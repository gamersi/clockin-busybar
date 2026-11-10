import assert from "node:assert/strict";
import { afterEach, describe, it, mock } from "node:test";

import { ClockMode, advanceState, type ClockDisplayState } from "../src/clockin.ts";
import { Controller, type ClockActions, type Renderer, type Snapshot } from "../src/controller.ts";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const state = (mode: ClockMode, breakSeconds = 0): ClockDisplayState => ({
  mode,
  workedSeconds: 24420,
  targetSeconds: 27720,
  breakSeconds,
});

// Started controllers keep their poll and minute timers; stop them so node:test can exit.
const live: Controller[] = [];
afterEach(() => {
  while (live.length) live.pop()!.stop();
});

function setup(states: ClockDisplayState[] | ClockDisplayState, pollIntervalMs = 60_000) {
  const log: string[] = [];
  const queue = Array.isArray(states) ? [...states] : undefined;
  const renderer: Renderer = {
    async render(s) {
      log.push(`render:${s.mode}`);
    },
    async feedback(text) {
      log.push(`feedback:${text}`);
    },
  };
  const actions: ClockActions = {
    async status() {
      const next = queue ? (queue.length > 1 ? queue.shift()! : queue[0]) : (states as ClockDisplayState);
      return () => next;
    },
    async clockIn() {
      log.push("clock-in");
    },
    async pause() {
      log.push("pause");
    },
    async resume() {
      log.push("resume");
    },
    async clockOut() {
      log.push("clock-out");
    },
  };
  const errors: unknown[] = [];
  const controller = new Controller(renderer, actions, (e) => errors.push(e), {
    pollIntervalMs,
    doublePressWindowMs: 30,
    longPressMs: 60,
  });
  live.push(controller);
  return { controller, log, errors };
}

const tap = (controller: Controller) => {
  controller.pressed();
  controller.released();
};

describe("Controller gestures", () => {
  it("single press clocks in from off duty", async () => {
    const { controller, log } = setup(state(ClockMode.OFF));
    tap(controller);
    await sleep(60);
    assert.deepEqual(log, ["render:off", "feedback:CLOCK IN", "clock-in", "render:off"]);
  });

  it("single press pauses while working and the refresh replaces the feedback", async () => {
    const { controller, log } = setup([state(ClockMode.WORKING), state(ClockMode.BREAK, 2)]);
    tap(controller);
    await sleep(60);
    assert.deepEqual(log, ["render:working", "feedback:PAUSING", "pause", "render:break"]);
  });

  it("single press resumes while on break", async () => {
    const { controller, log } = setup(state(ClockMode.BREAK));
    tap(controller);
    await sleep(60);
    assert.ok(log.includes("resume"));
  });

  it("double press clocks out", async () => {
    const { controller, log } = setup(state(ClockMode.WORKING));
    tap(controller);
    await sleep(10);
    tap(controller);
    await sleep(60);
    assert.deepEqual(log, ["render:working", "feedback:CLOCK OUT", "clock-out", "render:working"]);
  });

  it("long press clocks out before release, and release does nothing more", async () => {
    const { controller, log } = setup(state(ClockMode.WORKING));
    controller.pressed();
    await sleep(90);
    assert.ok(log.includes("clock-out"));
    controller.released();
    await sleep(60);
    assert.equal(log.filter((entry) => entry === "clock-out").length, 1);
    assert.ok(!log.includes("pause"));
  });

  it("clock-out is ignored when off duty", async () => {
    const { controller, log } = setup(state(ClockMode.OFF));
    tap(controller);
    tap(controller);
    await sleep(60);
    assert.deepEqual(log, ["render:off", "feedback:OFF DUTY"]);
  });

  it("start draws the state and stop leaves no timers behind", async () => {
    const { controller, log } = setup(state(ClockMode.OFF));
    await controller.start();
    controller.pressed();
    controller.stop();
    assert.deepEqual(log, ["render:off"]);
    // node:test would hang here if the poll interval or press timers were still running.
  });

  it("reports action errors without stopping", async () => {
    const { controller, errors } = setup(state(ClockMode.WORKING));
    (controller as unknown as { actions: ClockActions }).actions.pause = async () => {
      throw new Error("boom");
    };
    tap(controller);
    await sleep(60);
    assert.equal((errors[0] as Error).message, "boom");
  });

  it("waits for a refresh to finish before scheduling the next poll", async () => {
    const { controller } = setup(state(ClockMode.OFF), 10);
    let running = 0;
    let maxRunning = 0;
    let calls = 0;
    (controller as unknown as { actions: ClockActions }).actions.status = async () => {
      calls += 1;
      running += 1;
      maxRunning = Math.max(maxRunning, running);
      await sleep(40);
      running -= 1;
      return () => state(ClockMode.OFF);
    };
    await controller.start();
    await sleep(130);
    controller.stop();
    assert.equal(maxRunning, 1);
    // A 10 ms interval with overlapping polls would have queued about 13.
    assert.ok(calls >= 2 && calls <= 4, `calls=${calls}`);
  });

  it("does not act on stale state when stopped during the refresh", async () => {
    const { controller, log } = setup(state(ClockMode.WORKING));
    (controller as unknown as { actions: ClockActions }).actions.status = async () => {
      await sleep(30);
      return () => state(ClockMode.WORKING);
    };
    tap(controller);
    await sleep(40); // the toggle (after 30 ms) is now waiting on the status
    controller.stop();
    await sleep(50);
    assert.ok(!log.includes("pause"));
  });

});

describe("Controller local redraws", () => {
  // Fake timers: a minute passes instantly, and the "network" counts its requests.
  function localSetup(start: ClockDisplayState) {
    mock.timers.enable({ apis: ["setTimeout"] });
    let clock = 1_000_000;
    const shown: string[] = [];
    let fetches = 0;
    const actions: ClockActions = {
      async status(): Promise<Snapshot> {
        fetches += 1;
        const fetchedAt = clock;
        return (now) => advanceState(start, now - fetchedAt);
      },
      async clockIn() {},
      async pause() {},
      async resume() {},
      async clockOut() {},
    };
    const renderer: Renderer = {
      async render(s) {
        shown.push(`${s.mode}:${Math.floor(s.workedSeconds / 60)}:${Math.floor(s.breakSeconds / 60)}`);
      },
      async feedback() {},
    };
    const controller = new Controller(renderer, actions, () => {}, {
      pollIntervalMs: 600_000,
      doublePressWindowMs: 450,
      longPressMs: 1_200,
    }, () => clock);
    const advance = async (ms: number) => {
      clock += ms;
      mock.timers.tick(ms);
      for (let i = 0; i < 5; i++) await Promise.resolve();
    };
    return { controller, shown, fetches: () => fetches, advance };
  }

  it("redraws when the shown minute changes, without fetching", async () => {
    // 6:47:50 worked: the minute turns over in 10 s, then every 60 s.
    const { controller, shown, fetches, advance } = localSetup({ ...state(ClockMode.WORKING), workedSeconds: 6 * 3600 + 47 * 60 + 50 });
    try {
      await controller.start();
      assert.deepEqual(shown, ["working:407:0"]);
      await advance(9_000);
      assert.deepEqual(shown, ["working:407:0"]);
      await advance(2_000);
      assert.deepEqual(shown, ["working:407:0", "working:408:0"]);
      await advance(60_000);
      assert.deepEqual(shown, ["working:407:0", "working:408:0", "working:409:0"]);
      assert.equal(fetches(), 1);
    } finally {
      controller.stop();
      mock.timers.reset();
    }
  });

  it("does not tick while off duty", async () => {
    const { controller, shown, advance } = localSetup(state(ClockMode.OFF));
    try {
      await controller.start();
      await advance(300_000);
      assert.deepEqual(shown, ["off:407:0"]);
    } finally {
      controller.stop();
      mock.timers.reset();
    }
  });
});
