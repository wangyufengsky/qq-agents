import test from "node:test";
import assert from "node:assert/strict";
import { behaviorSchema } from "../src/core/policy.mjs";

test("elsewhere defaults missing policy and preserves explicit opt-out", () => {
  assert.deepEqual(behaviorSchema.parse({}).elsewhere, {
    enabled: true,
    windowMs: 21600000,
    ownLookbackMs: 86400000,
  });
  assert.deepEqual(
    behaviorSchema.parse({ elsewhere: { enabled: false } }).elsewhere,
    { enabled: false, windowMs: 21600000, ownLookbackMs: 86400000 },
  );
});
test("elsewhere accepts only bounded integer windows and known fields", () => {
  for (const windowMs of [600000, 86400000])
    assert.equal(
      behaviorSchema.parse({ elsewhere: { windowMs } }).elsewhere.windowMs,
      windowMs,
    );
  for (const windowMs of [599999, 86400001, 600000.5, "21600000"])
    assert.equal(
      behaviorSchema.safeParse({ elsewhere: { windowMs } }).success,
      false,
    );
  assert.equal(
    behaviorSchema.safeParse({ elsewhere: { enabled: "false" } }).success,
    false,
  );
  assert.equal(
    behaviorSchema.safeParse({ elsewhere: { includeRawText: true } }).success,
    false,
  );
});
