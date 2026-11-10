// Display refreshes and button gestures, ported from the desktop BusyBarController.

import { ClockMode, msUntilNextMinute, type ClockDisplayState } from "./clockin.ts";

export interface ControllerConfig {
  readonly pollIntervalMs: number;
  readonly doublePressWindowMs: number;
  readonly longPressMs: number;
}

export const DEFAULT_CONTROLLER_CONFIG: ControllerConfig = {
  pollIntervalMs: 60_000,
  doublePressWindowMs: 450,
  longPressMs: 1_200,
};

export interface Renderer {
  render(state: ClockDisplayState): Promise<void>;
  feedback(text: string, color: string): Promise<void>;
}

/** The state at a given time, computed from one fetch without further requests. */
export type Snapshot = (now: number) => ClockDisplayState;

/** Margin after a minute boundary, so the local redraw never lands just before it. */
const TICK_MARGIN_MS = 250;

export interface ClockActions {
  status(): Promise<Snapshot>;
  clockIn(): Promise<void>;
  pause(): Promise<void>;
  resume(): Promise<void>;
  clockOut(): Promise<void>;
}

type Timer = ReturnType<typeof setTimeout>;

/** Serializes async work, like the asyncio.Lock the desktop controller used. */
class Lock {
  private tail: Promise<void> = Promise.resolve();

  run<T>(work: () => Promise<T>): Promise<T> {
    const result = this.tail.then(work);
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

export class Controller {
  private state: ClockDisplayState = { mode: ClockMode.OFF, workedSeconds: 0, targetSeconds: 0, breakSeconds: 0 };
  private pressedAt: number | undefined;
  private pendingShortPress: Timer | undefined;
  private longPressTimer: Timer | undefined;
  private longPressTriggered = false;
  private pollTimer: Timer | undefined;
  private tickTimer: Timer | undefined;
  private snapshot: Snapshot | undefined;
  private readonly lock = new Lock();
  private stopped = false;
  private readonly renderer: Renderer;
  private readonly actions: ClockActions;
  private readonly report: (error: unknown) => void;
  private readonly config: ControllerConfig;
  private readonly now: () => number;

  constructor(
    renderer: Renderer,
    actions: ClockActions,
    report: (error: unknown) => void,
    config: ControllerConfig = DEFAULT_CONTROLLER_CONFIG,
    now: () => number = Date.now,
  ) {
    this.renderer = renderer;
    this.actions = actions;
    this.report = report;
    this.config = config;
    this.now = now;
  }

  /** Draws the current state and starts polling. The poll timer keeps the app running. */
  async start(): Promise<void> {
    try {
      await this.lock.run(() => this.refresh());
    } finally {
      this.schedulePoll();
    }
  }

  // Like the desktop loop: wait the interval after a refresh finishes, so polls never overlap.
  private schedulePoll(): void {
    if (this.stopped) return;
    this.pollTimer = setTimeout(() => {
      this.pollTimer = undefined;
      this.lock
        .run(() => this.refresh())
        .catch(this.report)
        .then(() => this.schedulePoll());
    }, this.config.pollIntervalMs);
  }

  stop(): void {
    this.stopped = true;
    if (this.pollTimer !== undefined) clearTimeout(this.pollTimer);
    this.pollTimer = undefined;
    this.cancelTick();
    this.cancelLongPress();
    this.cancelPendingShortPress();
  }

  /** The configured button went down. */
  pressed(): void {
    if (this.stopped || this.pressedAt !== undefined) return;

    this.pressedAt = this.now();
    this.longPressTriggered = false;
    this.cancelLongPress();
    this.longPressTimer = setTimeout(() => this.delayedLongPress(), this.config.longPressMs);
  }

  /** The configured button came up. */
  released(): void {
    if (this.stopped || this.pressedAt === undefined) return;

    const heldFor = this.now() - this.pressedAt;
    this.pressedAt = undefined;
    if (this.longPressTriggered) return;
    this.cancelLongPress();

    if (heldFor >= this.config.longPressMs) {
      this.cancelPendingShortPress();
      void this.clockOut().catch(this.report);
      return;
    }

    if (this.pendingShortPress !== undefined) {
      this.cancelPendingShortPress();
      void this.clockOut().catch(this.report);
      return;
    }

    this.pendingShortPress = setTimeout(() => {
      this.pendingShortPress = undefined;
      void this.togglePause().catch(this.report);
    }, this.config.doublePressWindowMs);
  }

  private delayedLongPress(): void {
    this.longPressTimer = undefined;
    if (this.pressedAt === undefined || this.longPressTriggered) return;
    this.longPressTriggered = true;
    this.cancelPendingShortPress();
    void this.clockOut().catch(this.report);
  }

  private cancelPendingShortPress(): void {
    if (this.pendingShortPress !== undefined) clearTimeout(this.pendingShortPress);
    this.pendingShortPress = undefined;
  }

  private cancelLongPress(): void {
    if (this.longPressTimer !== undefined) clearTimeout(this.longPressTimer);
    this.longPressTimer = undefined;
  }

  // JerryScript loses `this` inside async arrow functions, so locked work lives in methods
  // and is handed to the lock through plain arrows.
  private togglePause(): Promise<void> {
    return this.lock.run(() => this.togglePauseLocked());
  }

  private async togglePauseLocked(): Promise<void> {
    await this.refresh();
    if (this.stopped) return;
    if (this.state.mode === ClockMode.WORKING) {
      await this.renderer.feedback("PAUSING", "#f5b642ff");
      await this.actions.pause();
    } else if (this.state.mode === ClockMode.BREAK) {
      await this.renderer.feedback("RESUMING", "#35d07fff");
      await this.actions.resume();
    } else if (this.state.mode === ClockMode.OFF) {
      await this.renderer.feedback("CLOCK IN", "#35d07fff");
      await this.actions.clockIn();
    } else {
      await this.renderer.feedback("NO ACTION", "#8ca5ffff");
      return;
    }
    await this.refresh();
  }

  private clockOut(): Promise<void> {
    return this.lock.run(() => this.clockOutLocked());
  }

  private async clockOutLocked(): Promise<void> {
    await this.refresh();
    if (this.stopped) return;
    if (this.state.mode === ClockMode.OFF) {
      await this.renderer.feedback("OFF DUTY", "#f06a6aff");
      return;
    }
    await this.renderer.feedback("CLOCK OUT", "#8ca5ffff");
    await this.actions.clockOut();
    await this.refresh();
  }

  /** Fetches from clockin.de and draws. */
  private async refresh(): Promise<void> {
    if (this.stopped) return;
    const snapshot = await this.actions.status();
    if (this.stopped) return;
    this.snapshot = snapshot;
    await this.draw();
  }

  // Between fetches the shown minutes are advanced locally, without a request:
  // one redraw exactly when HH:MM changes, nothing while off duty.
  private async draw(): Promise<void> {
    if (this.stopped || !this.snapshot) return;
    this.state = this.snapshot(this.now());
    await this.renderer.render(this.state);
    this.scheduleTick();
  }

  private scheduleTick(): void {
    this.cancelTick();
    if (this.stopped) return;
    const delay = msUntilNextMinute(this.state);
    if (delay === undefined) return;
    this.tickTimer = setTimeout(() => {
      this.tickTimer = undefined;
      // Through the lock, so a tick never overwrites feedback of a running action.
      this.lock.run(() => this.draw()).catch(this.report);
    }, delay + TICK_MARGIN_MS);
  }

  private cancelTick(): void {
    if (this.tickTimer !== undefined) clearTimeout(this.tickTimer);
    this.tickTimer = undefined;
  }
}
