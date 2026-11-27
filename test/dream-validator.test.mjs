import test from "node:test";
import assert from "node:assert/strict";
import { parsePatch } from "../src/dream/validator.mjs";

const operation = {
  op: "ADD",
  category: "fact",
  scopeId: "global",
  subjectKey: "fixture:topic",
  content: "合成证据支持的长期事实。",
  epistemicStatus: "reported",
  evidenceIds: Array.from({ length: 101 }, (_, index) => `fixture-${index}`),
  importance: 0.5,
  confidence: 0.5,
  reason: "据此归纳。".repeat(100),
};
const patch = {
  schemaVersion: 1,
  operations: [operation],
  awakeningSummary: "",
  noChangesReason: "本次补丁同时附有未纳入的条目说明。",
};

test("cognitive submission accepts every referenced record in a valid batch", () => {
  assert.deepEqual(parsePatch(patch, 1), patch);
  assert.throws(() => parsePatch(patch, 0), /DREAM_INVALID_PATCH/);
  const largerPatch = { ...patch, operations: Array(101).fill(operation) };
  assert.equal(parsePatch(largerPatch, 101).operations.length, 101);
});

test("an empty batch still requires a nonblank reason within its budget", () => {
  for (const noChangesReason of [undefined, null, " ", "长".repeat(201)])
    assert.throws(
      () => parsePatch({ ...patch, operations: [], noChangesReason }, 1),
      /DREAM_INVALID_PATCH/,
    );
  assert.deepEqual(parsePatch({ ...patch, operations: [] }, 1).operations, []);
});
