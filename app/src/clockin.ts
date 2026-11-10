// Client for the clockin.de employee web interface, written for the BUSY Bar runtime.
//
// The device's built-in fetch keeps no cookies and does not follow redirects, so this
// client keeps its own cookie jar and follows redirects itself.

export const DEFAULT_BASE_URL = "https://office.clockin.de";
export const CLOCK_OUT_TASK_ID = 8;
export const PAUSE_TASK_ID = 5;
export const WORK_TASK_ID = 10;

const USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36";
const HTML_ACCEPT = "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8";
const MAX_REDIRECTS = 10;
/** Unparsed HTML kept between chunks, so a tag split across two chunks is still found. */
const MAX_PENDING_HTML = 2048;

export type ClockData = Record<string, unknown>;

export const ClockMode = {
  OFF: "off",
  WORKING: "working",
  BREAK: "break",
  OTHER: "other",
} as const;
export type ClockMode = (typeof ClockMode)[keyof typeof ClockMode];

export interface ClockDisplayState {
  readonly mode: ClockMode;
  readonly workedSeconds: number;
  readonly targetSeconds: number;
  readonly label?: string;
  readonly site?: string;
  readonly breakSeconds: number;
}

/** Raised when the session is no longer valid and a new login is needed. */
export class SessionExpiredError extends Error {}

// ---------- HTML token parsing ----------

export interface Tokens {
  formToken?: string;
  csrfToken?: string;
}

const TAG_RE = /<(input|meta)\b[^>]*>/gi;

function attribute(tag: string, name: string): string | undefined {
  const match = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, "i").exec(tag);
  if (!match) return undefined;
  return match[1] ?? match[2] ?? match[3];
}

/** Collects the `_token` input value and the `csrf-token` meta content from HTML. */
export function scanTokens(html: string, tokens: Tokens = {}): Tokens {
  TAG_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = TAG_RE.exec(html)) !== null) {
    const tag = match[0];
    if (match[1].toLowerCase() === "input" && attribute(tag, "name") === "_token") {
      tokens.formToken = attribute(tag, "value");
    } else if (match[1].toLowerCase() === "meta" && attribute(tag, "name") === "csrf-token") {
      tokens.csrfToken = attribute(tag, "content");
    }
  }
  return tokens;
}

export function parseTokens(html: string): Tokens {
  return scanTokens(html);
}

export function parseLoginToken(html: string): string | undefined {
  const tokens = parseTokens(html);
  return tokens.formToken || tokens.csrfToken;
}

function bytesToText(bytes: Uint8Array): string {
  // Tokens are ASCII, so a byte-per-character view is enough to find them.
  const parts: string[] = [];
  for (let i = 0; i < bytes.length; i += 512) {
    const end = Math.min(i + 512, bytes.length);
    let part = "";
    for (let j = i; j < end; j++) part += String.fromCharCode(bytes[j]);
    parts.push(part);
  }
  return parts.join("");
}

/**
 * Reads an HTML body chunk by chunk and returns its tokens without holding the whole
 * page in memory; the app's heap is far smaller than a typical dashboard page.
 */
export async function readTokens(
  response: Response,
  enough: (tokens: Tokens) => boolean = () => false,
): Promise<Tokens> {
  const tokens: Tokens = {};
  if (!response.body) return tokens;
  const reader = response.body.getReader();
  let pending = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    pending += bytesToText(value);
    const lastOpen = pending.lastIndexOf("<");
    const complete = lastOpen >= 0 && pending.indexOf(">", lastOpen) < 0;
    const scanUpTo = complete ? lastOpen : pending.length;
    scanTokens(pending.slice(0, scanUpTo), tokens);
    pending = pending.slice(scanUpTo);
    if (pending.length > MAX_PENDING_HTML) pending = "";
    if (enough(tokens)) {
      // clockin.de pages are ~150 KB and the token sits in the first few hundred bytes;
      // stop the download instead of pushing the rest through the bar's slow TLS and JS.
      await reader.cancel().catch(() => undefined);
      return tokens;
    }
  }
  scanTokens(pending, tokens);
  return tokens;
}

/** Laravel renders the same session token into the form input and the meta tag. */
const anyToken = (tokens: Tokens) => Boolean(tokens.formToken || tokens.csrfToken);
const csrfToken = (tokens: Tokens) => Boolean(tokens.csrfToken);

async function discard(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Nothing left to release.
  }
}

// ---------- Cookies and URLs ----------

interface Cookie {
  name: string;
  value: string;
  /** Lower-case domain without a leading dot. */
  domain: string;
  hostOnly: boolean;
  path: string;
}

export function urlHost(url: string): string {
  const authority = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]*)/i.exec(url)?.[1] ?? "";
  return authority.replace(/^.*@/, "").replace(/:\d+$/, "").toLowerCase();
}

function domainMatches(host: string, cookie: Cookie): boolean {
  if (cookie.hostOnly) return host === cookie.domain;
  return host === cookie.domain || host.endsWith(`.${cookie.domain}`);
}

function pathMatches(path: string, cookiePath: string): boolean {
  if (path === cookiePath) return true;
  if (!path.startsWith(cookiePath)) return false;
  return cookiePath.endsWith("/") || path[cookiePath.length] === "/";
}

/**
 * Cookies keyed by name, domain and path, as in a browser. clockin.de sets its session on
 * office.clockin.de and, in the same response, deletes same-named cookies on .clockin.de;
 * a jar keyed by name alone would throw the live session away.
 */
export class CookieJar {
  private readonly cookies = new Map<string, Cookie>();

  store(headers: Headers, url: string, now: number = Date.now()): void {
    const host = urlHost(url);
    const requestPath = urlPath(url);
    const defaultPath = requestPath.slice(0, requestPath.lastIndexOf("/")) || "/";
    headers.forEach((value, key) => {
      if (key.toLowerCase() !== "set-cookie") return;
      const parts = value.split(";");
      const pair = parts[0];
      const eq = pair.indexOf("=");
      if (eq <= 0) return;
      const name = pair.slice(0, eq).trim();
      const cookieValue = pair.slice(eq + 1).trim();
      let expired = cookieValue === "";
      let domain = host;
      let hostOnly = true;
      let path = defaultPath;
      for (let i = 1; i < parts.length; i++) {
        const attr = parts[i].trim();
        const attrEq = attr.indexOf("=");
        const attrName = (attrEq < 0 ? attr : attr.slice(0, attrEq)).trim().toLowerCase();
        const attrValue = attrEq < 0 ? "" : attr.slice(attrEq + 1).trim();
        if (attrName === "max-age" && Number(attrValue) <= 0) expired = true;
        if (attrName === "expires") {
          const expires = Date.parse(attrValue);
          if (!isNaN(expires) && expires <= now) expired = true;
        }
        if (attrName === "domain" && attrValue) {
          domain = attrValue.replace(/^\./, "").toLowerCase();
          hostOnly = false;
        }
        if (attrName === "path" && attrValue.startsWith("/")) path = attrValue;
      }
      // A server may only set cookies for its own host or a parent domain of it.
      if (!hostOnly && host !== domain && !host.endsWith(`.${domain}`)) return;

      const id = `${name};${domain};${path}`;
      if (expired) this.cookies.delete(id);
      else this.cookies.set(id, { name, value: cookieValue, domain, hostOnly, path });
    });
  }

  header(url: string): string {
    const host = urlHost(url);
    const path = urlPath(url);
    const pairs: string[] = [];
    this.cookies.forEach((cookie) => {
      if (domainMatches(host, cookie) && pathMatches(path, cookie.path)) {
        pairs.push(`${cookie.name}=${cookie.value}`);
      }
    });
    return pairs.join("; ");
  }

  clear(): void {
    this.cookies.clear();
  }
}

/** Resolves a redirect Location without depending on URL support in the runtime. */
export function resolveUrl(base: string, location: string): string {
  if (/^[a-z][a-z0-9+.-]*:/i.test(location)) return location;
  const origin = /^([a-z][a-z0-9+.-]*:\/\/[^/?#]*)/i.exec(base)?.[1] ?? "";
  if (location.startsWith("//")) return `${base.split(":")[0]}:${location}`;
  if (location.startsWith("/")) return origin + location;
  const path = base.slice(origin.length).split(/[?#]/)[0];
  return origin + path.slice(0, path.lastIndexOf("/") + 1) + location;
}

export function urlPath(url: string): string {
  const withoutOrigin = url.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/?#]*/i, "");
  return withoutOrigin.split(/[?#]/)[0] || "/";
}

function formEncode(values: Record<string, string>): string {
  return Object.keys(values)
    .map((key) => `${encodeURIComponent(key)}=${encodeURIComponent(values[key])}`.replace(/%20/g, "+"))
    .join("&");
}

function httpError(response: Response, url: string): Error {
  return new Error(`HTTP ${response.status} for ${url}`);
}

// ---------- Client ----------

interface SendOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}

interface SendResult {
  response: Response;
  url: string;
}

export class ClockinClient {
  readonly baseUrl: string;
  csrfToken: string | undefined;
  private readonly cookies = new CookieJar();

  constructor(baseUrl: string = DEFAULT_BASE_URL) {
    this.baseUrl = baseUrl.replace(/\/+$/, "") + "/";
  }

  url(path: string): string {
    return this.baseUrl + path.replace(/^\/+/, "");
  }

  private get origin(): string {
    return this.baseUrl.replace(/\/$/, "");
  }

  /** One request with this client's cookies, following redirects the way requests does. */
  private async send(url: string, options: SendOptions = {}): Promise<SendResult> {
    let method = options.method ?? "GET";
    let body = options.body;
    let headers = options.headers ?? {};
    for (let hop = 0; ; hop++) {
      const requestHeaders: Record<string, string> = {
        "Accept-Language": "de-AT,de;q=0.9",
        "User-Agent": USER_AGENT,
        ...headers,
      };
      const cookie = this.cookies.header(url);
      if (cookie) requestHeaders.Cookie = cookie;

      const response = await fetch(url, { method, headers: requestHeaders, body });
      this.cookies.store(response.headers, url);

      const location = response.headers.get("location");
      const isRedirect = response.status >= 300 && response.status < 400 && location;
      if (!isRedirect) return { response, url };
      await discard(response);
      if (hop >= MAX_REDIRECTS) throw new Error(`Too many redirects for ${url}`);

      url = resolveUrl(url, location);
      if (response.status !== 307 && response.status !== 308) {
        method = "GET";
        body = undefined;
        const { "Content-Type": _contentType, ...rest } = headers;
        headers = rest;
      }
    }
  }

  async login(email: string, password: string): Promise<void> {
    this.cookies.clear();
    this.csrfToken = undefined;
    const loginUrl = this.url("login");

    let { response } = await this.send(loginUrl, { headers: { Accept: HTML_ACCEPT } });
    if (!response.ok) {
      await discard(response);
      throw httpError(response, loginUrl);
    }
    const loginTokens = await readTokens(response, anyToken);
    const formToken = loginTokens.formToken || loginTokens.csrfToken;
    if (!formToken) {
      throw new Error("The login page contained neither an _token input nor a csrf-token meta tag");
    }

    let finalUrl: string;
    ({ response, url: finalUrl } = await this.send(loginUrl, {
      method: "POST",
      body: formEncode({ _token: formToken, email, password }),
      headers: {
        Accept: HTML_ACCEPT,
        "Content-Type": "application/x-www-form-urlencoded",
        Origin: this.origin,
        Referer: loginUrl,
      },
    }));
    if (!response.ok) {
      await discard(response);
      throw httpError(response, finalUrl);
    }
    if (urlPath(finalUrl).replace(/\/+$/, "") === "/login") {
      await discard(response);
      throw new Error("Login failed; check the email address and password");
    }

    this.csrfToken = (await readTokens(response, csrfToken)).csrfToken;
    if (!this.csrfToken) {
      const dashboardUrl = this.url("dashboard");
      ({ response } = await this.send(dashboardUrl, {
        headers: { Accept: "text/html", Referer: loginUrl },
      }));
      if (!response.ok) {
        await discard(response);
        throw httpError(response, dashboardUrl);
      }
      this.csrfToken = (await readTokens(response, csrfToken)).csrfToken;
    }

    if (!this.csrfToken) {
      throw new Error("The dashboard did not contain the expected csrf-token meta tag");
    }
  }

  private jsonHeaders(): Record<string, string> {
    if (!this.csrfToken) throw new SessionExpiredError("Not logged in");
    return {
      Accept: "application/json",
      "Content-Type": "application/json",
      Referer: this.url("dashboard"),
      "X-CSRF-TOKEN": this.csrfToken,
    };
  }

  /**
   * Like requests' raise_for_status() after following redirects, plus SessionExpiredError for
   * the answers Laravel gives to a stale session: a redirect to /login, 401 or 419. In those
   * cases the request was not carried out, so it is safe to log in again and repeat it.
   */
  private async checkJsonResponse(response: Response, finalUrl: string): Promise<void> {
    if (urlPath(finalUrl).replace(/\/+$/, "") === "/login") {
      await discard(response);
      throw new SessionExpiredError("Session expired");
    }
    if (response.status === 401 || response.status === 419) {
      await discard(response);
      throw new SessionExpiredError(`Session expired (HTTP ${response.status})`);
    }
    if (response.status < 200 || response.status >= 300) {
      await discard(response);
      throw httpError(response, finalUrl);
    }
  }

  async clockData(): Promise<ClockData> {
    const url = this.url("clock/data");
    const { response, url: finalUrl } = await this.send(url, { headers: this.jsonHeaders() });
    await this.checkJsonResponse(response, finalUrl);
    const data: unknown = await response.json();
    if (typeof data !== "object" || data === null || Array.isArray(data)) {
      throw new Error("Unexpected /clock/data response: expected a JSON object");
    }
    return data as ClockData;
  }

  async recordEvent(taskId: number, taskLabel?: string, siteId?: string): Promise<void> {
    const payload: Record<string, unknown> = { taskId };
    if (taskLabel !== undefined) payload.taskLabel = taskLabel;
    if (siteId !== undefined) payload.siteId = siteId;

    const url = this.url("clock/recordEvent");
    const { response, url: finalUrl } = await this.send(url, {
      method: "POST",
      body: JSON.stringify(payload),
      headers: { ...this.jsonHeaders(), Origin: this.origin },
    });
    await this.checkJsonResponse(response, finalUrl);
    await discard(response);
  }
}

// ---------- Clock data helpers ----------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toInt(value: unknown): number {
  const number = Number(value || 0);
  return isFinite(number) ? Math.trunc(number) : 0;
}

const ISO_RE =
  /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:[.,](\d+))?)?)?\s*(Z|[+-]\d{2}(?::?\d{2})?)?$/i;

/** Parses an ISO 8601 timestamp; one without an offset is taken as UTC. */
export function parseIsoTimestamp(value: string): number | undefined {
  const match = ISO_RE.exec(value.trim());
  if (!match) return undefined;
  const [, y, mo, d, h = "0", mi = "0", s = "0", fraction = "", zone] = match;
  let ms = Date.UTC(+y, +mo - 1, +d, +h, +mi, +s, Math.floor(Number(`0.${fraction || "0"}`) * 1000));
  if (zone && zone.toUpperCase() !== "Z") {
    const sign = zone[0] === "-" ? -1 : 1;
    const digits = zone.slice(1).replace(":", "");
    const offsetMinutes = Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2) || "0");
    ms -= sign * offsetMinutes * 60 * 1000;
  }
  return isNaN(ms) ? undefined : ms;
}

/** Elapsed seconds of the active event when it matches the task. */
export function calculateEventSeconds(data: ClockData, taskId: number, now: number = Date.now()): number {
  const event = data.currentEvent;
  if (!isRecord(event) || event.taskId !== taskId) return 0;
  const occurredAt = event.occuredAt || event.occurredAt;
  if (typeof occurredAt !== "string") return 0;
  const startedAt = parseIsoTimestamp(occurredAt);
  if (startedAt === undefined) return 0;
  return Math.max(0, Math.floor((now - startedAt) / 1000));
}

export function calculateWorkedSeconds(data: ClockData, now: number = Date.now()): number {
  return toInt(data.currentWorkSeconds) + calculateEventSeconds(data, WORK_TASK_ID, now);
}

export function taskLabel(data: ClockData, taskId: number, fallback: string): string {
  const tasks = data.tasks;
  if (Array.isArray(tasks)) {
    for (const task of tasks) {
      if (isRecord(task) && task.taskId === taskId && typeof task.name === "string" && task.name) {
        return task.name;
      }
    }
  }
  return fallback;
}

/** Close enough to Python's str.casefold() for site names. */
const caseFold = (text: string) => text.toLowerCase().replace(/ß/g, "ss");

export function resolveSite(data: ClockData, selection: string | undefined): { id: string; name: string } {
  const sites = Array.isArray(data.sites) ? data.sites.filter(isRecord) : [];

  if (selection === undefined && sites.length === 1) {
    const site = sites[0];
    return { id: String(site.id), name: String(site.name || site.id) };
  }

  if (selection !== undefined) {
    const wanted = caseFold(selection.trim());
    for (const site of sites) {
      const siteId = String(site.id);
      const siteName = String(site.name || "");
      if (wanted === caseFold(siteId) || wanted === caseFold(siteName)) {
        return { id: siteId, name: siteName || siteId };
      }
    }
  }

  const available = sites.map((site) => `${site.name} (${site.id})`).join(", ") || "none";
  if (selection === undefined) {
    throw new Error(`Clock-in requires a site. Available sites: ${available}`);
  }
  throw new Error(`Unknown site '${selection}'. Available sites: ${available}`);
}

export function displayState(data: ClockData, now: number = Date.now()): ClockDisplayState {
  const event = isRecord(data.currentEvent) ? data.currentEvent : undefined;
  const taskId = event?.taskId;
  let mode: ClockMode;
  if (data.currentEvent == null || taskId === CLOCK_OUT_TASK_ID) mode = ClockMode.OFF;
  else if (taskId === WORK_TASK_ID) mode = ClockMode.WORKING;
  else if (taskId === PAUSE_TASK_ID) mode = ClockMode.BREAK;
  else mode = ClockMode.OTHER;

  const site = event && isRecord(event.site) ? event.site : undefined;
  const siteName = site?.name;
  const label = event?.taskLabel;
  return {
    mode,
    workedSeconds: calculateWorkedSeconds(data, now),
    targetSeconds: toInt(data.targetSeconds),
    label: label ? String(label) : undefined,
    site: siteName ? String(siteName) : undefined,
    breakSeconds: calculateEventSeconds(data, PAUSE_TASK_ID, now),
  };
}

/** The state `elapsedMs` later: the running work or break timer keeps counting. */
export function advanceState(state: ClockDisplayState, elapsedMs: number): ClockDisplayState {
  const seconds = Math.max(0, Math.floor(elapsedMs / 1000));
  if (state.mode === ClockMode.WORKING) return { ...state, workedSeconds: state.workedSeconds + seconds };
  if (state.mode === ClockMode.BREAK) return { ...state, breakSeconds: state.breakSeconds + seconds };
  return state;
}

/** Milliseconds until the HH:MM shown for this state changes, or undefined if it never does. */
export function msUntilNextMinute(state: ClockDisplayState): number | undefined {
  const seconds =
    state.mode === ClockMode.WORKING ? state.workedSeconds : state.mode === ClockMode.BREAK ? state.breakSeconds : undefined;
  if (seconds === undefined) return undefined;
  return (60 - (Math.max(0, seconds) % 60)) * 1000;
}

export function formatCompactDuration(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

/** Text and color shown for a state, the same as the desktop controller. */
export function statusContent(state: ClockDisplayState): { text: string; color: string } {
  const worked = formatCompactDuration(state.workedSeconds);
  switch (state.mode) {
    case ClockMode.WORKING:
      return { text: `${worked} WORK`, color: "#35d07fff" };
    case ClockMode.BREAK:
      return { text: `${formatCompactDuration(state.breakSeconds)} BREAK`, color: "#f5b642ff" };
    case ClockMode.OFF:
      return { text: "OFF DUTY", color: "#f06a6aff" };
    default:
      return { text: "TRACKING", color: "#8ca5ffff" };
  }
}
