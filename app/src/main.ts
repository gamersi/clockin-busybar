import { device } from "@shared/device";
import manifest from "./appmeta/manifest.json";
import {
  CLOCK_OUT_TASK_ID,
  ClockinClient,
  PAUSE_TASK_ID,
  SessionExpiredError,
  WORK_TASK_ID,
  advanceState,
  displayState,
  resolveSite,
  statusContent,
  taskLabel,
  type ClockDisplayState,
} from "./clockin.ts";
import { Controller, DEFAULT_CONTROLLER_CONFIG, type Renderer } from "./controller.ts";
import { isLowPriorityError } from "./display.ts";

/** Thrown instead of logging in again while a login back-off is running. */
class RetryLaterError extends Error {}

const MAX_LOGIN_BACKOFF_MS = 5 * 60 * 1000;

const APP = manifest.id;
const SETTINGS_VERSION = 1; // "version" in settings.json

const STATUS_ELEMENT_ID = "clockin-status";
const DISPLAY_PRIORITY = 60;
// The front matrix is 72 pixels wide and 16 pixels high.
const FRONT_CENTER_X = 36;
const FRONT_CENTER_Y = 8;
const ERROR_COLOR = "#f06a6aff";

type ButtonKey = "start" | "ok" | "back";

interface Settings {
  email: string;
  password: string;
  site: string | undefined;
  button: ButtonKey;
  pollIntervalSeconds: number;
}

const DEFAULTS: Settings = {
  email: "",
  password: "",
  site: undefined,
  button: "start",
  pollIntervalSeconds: 60,
};

const report = (error: unknown) =>
  console.error(`${APP}: ${error instanceof Error ? error.message : String(error)}`);

async function loadSettings(): Promise<Settings> {
  try {
    const { version, values } = (await device.AppsSettingsGet({ app_id: APP })) as {
      version?: number;
      values?: Record<string, unknown>;
    };
    if (version !== SETTINGS_VERSION || !values) return DEFAULTS;
    const text = (value: unknown) => (typeof value === "string" ? value.trim() : "");
    const button = values.button;
    return {
      email: text(values.email),
      password: typeof values.password === "string" ? values.password : "",
      site: text(values.site) || undefined,
      button: button === "ok" || button === "back" || button === "start" ? button : DEFAULTS.button,
      pollIntervalSeconds:
        typeof values.poll_interval === "number" && values.poll_interval > 0
          ? values.poll_interval
          : DEFAULTS.pollIntervalSeconds,
    };
  } catch (error) {
    report(error);
    return DEFAULTS;
  }
}

// ---------- Screen ----------

/** What is on screen now, so an unchanged frame costs no request. */
let shown: string | undefined;

async function drawText(text: string, color: string): Promise<void> {
  const key = `${text}|${color}`;
  if (key === shown) return;
  try {
    await device.DisplayDraw({
      application_name: APP,
      priority: DISPLAY_PRIORITY,
      elements: [
        {
          id: STATUS_ELEMENT_ID,
          type: "text",
          x: FRONT_CENTER_X,
          y: FRONT_CENTER_Y,
          text,
          font: "condensed",
          align: "center",
          color,
        },
      ],
    });
    shown = key;
  } catch (error) {
    if (!isLowPriorityError(error)) throw error;
    console.warn(`${APP}: display is owned by a higher-priority app`);
  }
}

const renderer: Renderer = {
  render(state: ClockDisplayState) {
    const { text, color } = statusContent(state);
    return drawText(text, color);
  },
  // Feedback stays until the next status draw replaces it. The desktop controller sent
  // timeout=2000, which the API reads as seconds, so its feedback never expired on its own either.
  feedback(text: string, color: string) {
    return drawText(text, color);
  },
};

function showError(text: string): void {
  void drawText(text, ERROR_COLOR).catch(report);
}

// ---------- App ----------

function main(): void {
  const client = new ClockinClient();
  let settings = DEFAULTS;
  let controller: Controller | undefined;
  let stopped = false;
  let ready = false;
  // Failed logins back off: network errors double the wait up to 5 minutes, while wrong
  // credentials or a bad site wait for a button press. The desktop controller simply exited.
  let retryAt = 0;
  let backoffMs = 0;
  let retryOnPress = false;

  function loginFailed(text: string, permanent: boolean): void {
    showError(text);
    if (permanent) {
      retryAt = Infinity;
    } else {
      backoffMs = Math.min(MAX_LOGIN_BACKOFF_MS, backoffMs ? backoffMs * 2 : settings.pollIntervalSeconds * 1000);
      retryAt = Date.now() + backoffMs;
    }
  }

  // Logs in and checks the site once, as the desktop controller did before it started.
  async function ensureReady(): Promise<void> {
    if (ready) return;
    if (retryOnPress) {
      retryOnPress = false;
    } else if (Date.now() < retryAt) {
      throw new RetryLaterError("Waiting before the next login attempt");
    }
    try {
      await client.login(settings.email, settings.password);
    } catch (error) {
      const wrongCredentials = error instanceof Error && error.message.startsWith("Login failed");
      loginFailed("LOGIN ERR", wrongCredentials);
      throw error;
    }
    try {
      resolveSite(await client.clockData(), settings.site);
    } catch (error) {
      const badSite = error instanceof Error && /site/i.test(error.message);
      loginFailed(badSite ? "SITE ERR" : "ERROR", badSite);
      throw error;
    }
    ready = true;
    retryAt = 0;
    backoffMs = 0;
  }

  // Runs a request, logging in again once if the session expired.
  async function withSession<T>(work: () => Promise<T>): Promise<T> {
    await ensureReady();
    try {
      return await work();
    } catch (error) {
      if (!(error instanceof SessionExpiredError)) throw error;
      await client.login(settings.email, settings.password);
      return work();
    }
  }

  async function clockIn(): Promise<void> {
    await withSession(async () => {
      const data = await client.clockData();
      const site = resolveSite(data, settings.site);
      await client.recordEvent(WORK_TASK_ID, taskLabel(data, WORK_TASK_ID, "Arbeitszeit"), site.id);
    });
  }

  const actions = {
    // One request; the returned snapshot advances the running timer locally until the next one.
    status: () =>
      withSession(async () => {
        const data = await client.clockData();
        const fetchedAt = Date.now();
        const state = displayState(data, fetchedAt);
        return (now: number) => advanceState(state, now - fetchedAt);
      }),
    clockIn,
    pause: () => withSession(() => client.recordEvent(PAUSE_TASK_ID)),
    resume: clockIn,
    clockOut: () => withSession(() => client.recordEvent(CLOCK_OUT_TASK_ID)),
  };

  const stop = () => {
    stopped = true;
    controller?.stop();
    // Removing the last listener closes the app. Do it after this handler returns.
    setTimeout(unbind, 0);
  };

  const unbind = listen("input", (event) => {
    if (stopped) return;

    if (event.key === settings.button) {
      // A press retries a failed login straight away; the gesture itself then needs a working session.
      if (event.action === "press" && !ready) retryOnPress = true;
      if (event.action === "press") controller?.pressed();
      else if (event.action === "release") controller?.released();
      return;
    }

    // Back quits unless it is the clock button; holding Back always closes the app.
    if (event.key === "back" && event.action === "short") stop();
  });

  void (async () => {
    settings = await loadSettings();
    if (stopped) return;
    // Start from a clean screen, as the desktop controller did.
    await device.DisplayClear({ application_name: APP }).catch(report);
    if (!settings.email || !settings.password) {
      // Nothing to poll; the input listener keeps the app open until Back.
      await drawText("SETUP", "#8ca5ffff").catch(report);
      return;
    }
    await drawText("LOADING", "#8ca5ffff").catch(report);
    if (stopped) return;

    // Login and site errors draw their own message; anything later shows ERROR until the next good refresh.
    const reportOnScreen = (error: unknown) => {
      if (error instanceof RetryLaterError) return;
      report(error);
      if (ready && !stopped) showError("ERROR");
    };
    controller = new Controller(renderer, actions, reportOnScreen, {
      ...DEFAULT_CONTROLLER_CONFIG,
      pollIntervalMs: settings.pollIntervalSeconds * 1000,
    });
    await controller.start();
  })().catch(report);
}

main();
