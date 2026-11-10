import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { isLowPriorityError } from "../src/display.ts";

describe("isLowPriorityError", () => {
  it("recognises the error busy-lib throws for a 409", () => {
    const error = Object.assign(new Error("Not drawn due to low priority"), {
      status: 409,
      statusText: "Conflict",
      body: { error: "Not drawn due to low priority", code: 409 },
    });
    assert.equal(isLowPriorityError(error), true);
  });

  it("ignores other errors", () => {
    assert.equal(isLowPriorityError(Object.assign(new Error("Bad request"), { status: 400 })), false);
    assert.equal(isLowPriorityError(Object.assign(new Error("Conflict"), { status: 409 })), false);
    assert.equal(isLowPriorityError(undefined), false);
  });
});
