import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import {
  ClockMode,
  ClockinClient,
  CookieJar,
  SessionExpiredError,
  advanceState,
  msUntilNextMinute,
  calculateWorkedSeconds,
  displayState,
  formatCompactDuration,
  parseIsoTimestamp,
  parseLoginToken,
  parseTokens,
  readTokens,
  resolveSite,
  resolveUrl,
  statusContent,
  taskLabel,
} from "../src/clockin.ts";

describe("tokens", () => {
  it("parses the two distinct tokens", () => {
    const tokens = parseTokens(
      '<input type="hidden" name="_token" value="form123">' + '<meta name="csrf-token" content="meta456">',
    );
    assert.equal(tokens.formToken, "form123");
    assert.equal(tokens.csrfToken, "meta456");
  });

  it("uses the meta token when the login page has no hidden input", () => {
    assert.equal(parseLoginToken('<meta name="csrf-token" content="meta456">'), "meta456");
  });

  it("prefers the hidden login token when both exist", () => {
    const html = '<meta name="csrf-token" content="meta456"><input type="hidden" name="_token" value="form123">';
    assert.equal(parseLoginToken(html), "form123");
  });

  it("handles any attribute order and quoting", () => {
    const tokens = parseTokens("<META content='m1' name=csrf-token /><input value=f1 name='_token'>");
    assert.deepEqual(tokens, { csrfToken: "m1", formToken: "f1" });
  });

  it("finds tokens in a streamed body even when a tag spans chunks", async () => {
    const html = `${"x".repeat(5000)}<meta name="csrf-token" content="streamed42">${"y".repeat(5000)}`;
    const bytes = new TextEncoder().encode(html);
    const split = html.indexOf("csrf-") + 2;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.slice(0, split));
        controller.enqueue(bytes.slice(split));
        controller.close();
      },
    });
    assert.equal((await readTokens(new Response(body))).csrfToken, "streamed42");
  });

  it("stops downloading once it has the token", async () => {
    let pulls = 0;
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        controller.enqueue(new TextEncoder().encode(pulls === 1 ? '<meta name="csrf-token" content="early">' : "x".repeat(1000)));
      },
      cancel() {
        cancelled = true;
      },
    }, { highWaterMark: 0 });
    const tokens = await readTokens(new Response(body), (t) => Boolean(t.csrfToken));
    assert.equal(tokens.csrfToken, "early");
    assert.equal(cancelled, true);
    assert.ok(pulls <= 2, `pulls=${pulls}`);
  });
});

describe("cookies and urls", () => {
  it("keeps every Set-Cookie and drops expired ones", () => {
    const url = "https://office.clockin.de/login";
    const jar = new CookieJar();
    jar.store(
      new Headers([
        ["set-cookie", "XSRF-TOKEN=abc; expires=Fri, 01 Jan 2100 00:00:00 GMT; path=/"],
        ["set-cookie", "session=s1; path=/; httponly"],
      ]),
      url,
    );
    assert.equal(jar.header(url), "XSRF-TOKEN=abc; session=s1");
    jar.store(new Headers([["set-cookie", "XSRF-TOKEN=deleted; Max-Age=0; path=/"]]), url);
    assert.equal(jar.header(url), "session=s1");
  });

  it("keeps the live session when the parent-domain copy is deleted, as clockin.de does", () => {
    const url = "https://office.clockin.de/login";
    const jar = new CookieJar();
    jar.store(
      new Headers([
        ["set-cookie", "XSRF-TOKEN=x1; Max-Age=86400; path=/; domain=office.clockin.de; secure; samesite=lax"],
        ["set-cookie", "clockin_session=s1; Max-Age=86400; path=/; domain=office.clockin.de; secure; httponly"],
        ["set-cookie", "XSRF-TOKEN=old; Max-Age=0; path=/; domain=.clockin.de; secure; samesite=lax"],
        ["set-cookie", "clockin_session=old; Max-Age=0; path=/; domain=.clockin.de; secure; httponly"],
        ["set-cookie", "admin_clockin_session=old; Max-Age=0; path=/; domain=.clockin.de; secure"],
      ]),
      url,
    );
    assert.equal(jar.header(url), "XSRF-TOKEN=x1; clockin_session=s1");
    assert.equal(jar.header("https://other.example/"), "");
  });

  it("resolves redirect locations", () => {
    assert.equal(resolveUrl("https://office.clockin.de/login", "/dashboard"), "https://office.clockin.de/dashboard");
    assert.equal(resolveUrl("https://office.clockin.de/a/b", "c"), "https://office.clockin.de/a/c");
    assert.equal(resolveUrl("https://office.clockin.de/login", "https://x.example/y"), "https://x.example/y");
  });
});

describe("clock data", () => {
  it("formats compact durations", () => {
    assert.equal(formatCompactDuration(24420), "06:47");
    assert.equal(formatCompactDuration(-5), "00:00");
  });

  it("parses timestamps with microseconds and offsets", () => {
    assert.equal(parseIsoTimestamp("2026-07-16T10:35:00.000000Z"), Date.UTC(2026, 6, 16, 10, 35));
    assert.equal(parseIsoTimestamp("2026-07-16T12:35:00+02:00"), Date.UTC(2026, 6, 16, 10, 35));
    assert.equal(parseIsoTimestamp("2026-07-16 10:35:00"), Date.UTC(2026, 6, 16, 10, 35));
    assert.equal(parseIsoTimestamp("garbage"), undefined);
  });

  it("adds the active work event to accumulated work", () => {
    const data = {
      currentWorkSeconds: 12600,
      targetSeconds: 27720,
      currentEvent: { occuredAt: "2026-07-16T10:35:00.000000Z", taskId: 10, taskLabel: "Arbeitszeit" },
    };
    // 15:52:31 in Vienna (UTC+2).
    const now = Date.UTC(2026, 6, 16, 13, 52, 31);
    assert.equal(calculateWorkedSeconds(data, now), 6 * 3600 + 47 * 60 + 31);
  });

  it("resolves a site by name or id", () => {
    const data = {
      sites: [
        { id: 65630, name: "Büro" },
        { id: 65631, name: "Homeoffice" },
      ],
    };
    assert.deepEqual(resolveSite(data, "homeoffice"), { id: "65631", name: "Homeoffice" });
    assert.deepEqual(resolveSite(data, "65630"), { id: "65630", name: "Büro" });
    assert.throws(() => resolveSite(data, undefined), /requires a site/);
    assert.throws(() => resolveSite(data, "Mars"), /Unknown site 'Mars'/);
    assert.deepEqual(resolveSite({ sites: [{ id: 1, name: "Only" }] }, undefined), { id: "1", name: "Only" });
    assert.deepEqual(resolveSite({ sites: [{ id: 2, name: "Straße" }] }, "STRASSE"), { id: "2", name: "Straße" });
  });

  it("finds the task label with a fallback", () => {
    assert.equal(taskLabel({ tasks: [{ taskId: 10, name: "Work" }] }, 10, "Arbeitszeit"), "Work");
    assert.equal(taskLabel({}, 10, "Arbeitszeit"), "Arbeitszeit");
  });

  it("distinguishes work, break and off duty", () => {
    assert.equal(displayState({ targetSeconds: 27720 }).mode, ClockMode.OFF);
    assert.equal(displayState({ targetSeconds: 27720, currentEvent: { taskId: 8 } }).mode, ClockMode.OFF);
    assert.equal(displayState({ targetSeconds: 27720, currentEvent: { taskId: 10 } }).mode, ClockMode.WORKING);
    assert.equal(displayState({ targetSeconds: 27720, currentEvent: { taskId: 5 } }).mode, ClockMode.BREAK);
    assert.equal(displayState({ targetSeconds: 27720, currentEvent: { taskId: 3 } }).mode, ClockMode.OTHER);
  });

  it("tracks elapsed pause time", () => {
    const state = displayState(
      {
        currentWorkSeconds: 12600,
        targetSeconds: 27720,
        currentEvent: { taskId: 5, occuredAt: "2026-07-16T15:50:00.000000Z" },
      },
      Date.UTC(2026, 6, 16, 15, 52, 31),
    );
    assert.equal(state.mode, ClockMode.BREAK);
    assert.equal(state.workedSeconds, 12600);
    assert.equal(state.breakSeconds, 151);
  });

  it("advances only the running timer", () => {
    const base = { workedSeconds: 100, targetSeconds: 0, breakSeconds: 10 };
    assert.equal(advanceState({ ...base, mode: ClockMode.WORKING }, 5_900).workedSeconds, 105);
    assert.equal(advanceState({ ...base, mode: ClockMode.BREAK }, 5_000).breakSeconds, 15);
    assert.equal(advanceState({ ...base, mode: ClockMode.OFF }, 5_000).workedSeconds, 100);
    assert.equal(msUntilNextMinute({ ...base, mode: ClockMode.WORKING }), 20_000);
    assert.equal(msUntilNextMinute({ ...base, mode: ClockMode.BREAK }), 50_000);
    assert.equal(msUntilNextMinute({ ...base, mode: ClockMode.OFF }), undefined);
  });

  it("shows the same texts as the desktop controller", () => {
    const base = { workedSeconds: 24420, targetSeconds: 27720, breakSeconds: 125 };
    assert.equal(statusContent({ ...base, mode: ClockMode.WORKING }).text, "06:47 WORK");
    assert.equal(statusContent({ ...base, mode: ClockMode.BREAK }).text, "00:02 BREAK");
    assert.equal(statusContent({ ...base, mode: ClockMode.OFF }).text, "OFF DUTY");
    assert.equal(statusContent({ ...base, mode: ClockMode.OTHER }).text, "TRACKING");
    assert.match(statusContent({ ...base, mode: ClockMode.WORKING }).color, /^#[0-9a-f]{8}$/);
  });
});

// ---------- HTTP flow against a fake server ----------

interface Call {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: string;
}

const realFetch = globalThis.fetch;

function fakeServer(handler: (call: Call) => Response): Call[] {
  const calls: Call[] = [];
  globalThis.fetch = (async (url: string, init: RequestInit = {}) => {
    const call: Call = {
      method: init.method ?? "GET",
      url,
      headers: (init.headers ?? {}) as Record<string, string>,
      body: init.body as string | undefined,
    };
    calls.push(call);
    return handler(call);
  }) as typeof fetch;
  return calls;
}

const html = (body: string, headers: [string, string][] = []) =>
  new Response(body, { status: 200, headers: [["content-type", "text/html"], ...headers] });
const redirect = (location: string, headers: [string, string][] = []) =>
  new Response(null, { status: 302, headers: [["location", location], ...headers] });

describe("ClockinClient", () => {
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it("logs in with cookies, follows the redirect and reads the csrf token", async () => {
    const calls = fakeServer((call) => {
      if (call.method === "GET" && call.url.endsWith("/login")) {
        return html('<form><input type="hidden" name="_token" value="form123"></form>', [
          ["set-cookie", "XSRF-TOKEN=x1; path=/"],
          ["set-cookie", "clockin_session=s1; path=/; httponly"],
        ]);
      }
      if (call.method === "POST" && call.url.endsWith("/login")) {
        return redirect("/dashboard", [["set-cookie", "clockin_session=s2; path=/"]]);
      }
      if (call.url.endsWith("/dashboard")) return html('<meta name="csrf-token" content="meta456">');
      return new Response("not found", { status: 404 });
    });

    const client = new ClockinClient();
    await client.login("you@example.com", "p a&ss");

    assert.equal(client.csrfToken, "meta456");
    assert.deepEqual(
      calls.map((c) => `${c.method} ${c.url}`),
      [
        "GET https://office.clockin.de/login",
        "POST https://office.clockin.de/login",
        "GET https://office.clockin.de/dashboard",
      ],
    );
    assert.equal(calls[1].body, "_token=form123&email=you%40example.com&password=p+a%26ss");
    assert.equal(calls[1].headers["Content-Type"], "application/x-www-form-urlencoded");
    assert.equal(calls[1].headers.Cookie, "XSRF-TOKEN=x1; clockin_session=s1");
    assert.equal(calls[1].headers.Origin, "https://office.clockin.de");
    assert.equal(calls[2].headers.Cookie, "XSRF-TOKEN=x1; clockin_session=s2");
    assert.equal(calls[2].headers["Content-Type"], undefined);
    // The device allows at most 11 request headers of the app's own.
    for (const call of calls) assert.ok(Object.keys(call.headers).length <= 11);
  });

  it("reports a failed login when the server redirects back to /login", async () => {
    fakeServer((call) => {
      if (call.method === "POST") return redirect("https://office.clockin.de/login");
      return html('<meta name="csrf-token" content="meta456">');
    });
    await assert.rejects(new ClockinClient().login("a", "b"), /Login failed/);
  });

  it("posts clock events with the csrf token", async () => {
    const calls = fakeServer(() => new Response("{}", { status: 200 }));
    const client = new ClockinClient();
    client.csrfToken = "csrf123";

    await client.recordEvent(10, "Arbeitszeit", "65631");
    await client.recordEvent(5);
    await client.recordEvent(8);

    assert.deepEqual(
      calls.map((c) => JSON.parse(c.body ?? "")),
      [{ taskId: 10, taskLabel: "Arbeitszeit", siteId: "65631" }, { taskId: 5 }, { taskId: 8 }],
    );
    assert.equal(calls[0].url, "https://office.clockin.de/clock/recordEvent");
    assert.equal(calls[0].headers["X-CSRF-TOKEN"], "csrf123");
  });

  it("detects an expired session", async () => {
    const client = new ClockinClient();
    client.csrfToken = "csrf123";
    fakeServer((call) => (call.url.endsWith("/login") ? html("<form></form>") : redirect("/login")));
    await assert.rejects(client.clockData(), SessionExpiredError);
    fakeServer(() => new Response("", { status: 419 }));
    await assert.rejects(client.clockData(), SessionExpiredError);
  });

  it("treats a redirect after recording an event as success, like requests did", async () => {
    const calls = fakeServer((call) =>
      call.method === "POST" ? redirect("/dashboard") : html('<meta name="csrf-token" content="t">'),
    );
    const client = new ClockinClient();
    client.csrfToken = "csrf123";
    await client.recordEvent(5);
    assert.deepEqual(
      calls.map((c) => `${c.method} ${c.url}`),
      ["POST https://office.clockin.de/clock/recordEvent", "GET https://office.clockin.de/dashboard"],
    );
  });
});
