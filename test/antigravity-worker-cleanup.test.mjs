import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { AntigravityStreamWorker } from "../src/backends/antigravity-stream.mjs";

test("a locked temporary media directory rejects worker teardown without an uncaught callback error", async (t) => {
  const owner = { config: { effort: "low" }, workers: new Map(), stop() {} };
  const worker = new AntigravityStreamWorker(
    owner,
    { key: "synthetic-cleanup", signature: "synthetic" },
    { instructions: "Synthetic test" },
  );
  owner.workers.set(worker.details.key, worker);
  const remove = fs.rmSync;
  t.after(() => {
    fs.rmSync = remove;
    remove(worker.mediaRoot, { recursive: true, force: true });
  });
  fs.rmSync = (target, options) => {
    if (target === worker.mediaRoot)
      throw Error("SYNTHETIC_PRIVATE_LOCK_DETAIL");
    return remove(target, options);
  };
  await assert.rejects(worker.close(), (error) => {
    assert.equal(error.message, "ANTIGRAVITY_MEDIA_FAILED");
    assert(!String(error).includes("SYNTHETIC_PRIVATE_LOCK_DETAIL"));
    return true;
  });
  assert.equal(owner.workers.size, 0);
  await assert.rejects(worker.close(), /ANTIGRAVITY_MEDIA_FAILED/);
});
