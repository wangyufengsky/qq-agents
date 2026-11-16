import test from "node:test";
import assert from "node:assert/strict";
import { registerFollowIpc } from "../desktop/home/follow-ipc.mjs";

test("follow rejects requests without the focused panel", async () => {
  let handler;
  let started = false;
  registerFollowIpc({
    ipc: {
      handle: (_name, fn) => {
        handler = fn;
      },
    },
    context: {},
    entries: new Map(),
    follow: {
      start: () => {
        started = true;
      },
    },
  });
  assert.equal(await handler({}, "a", "pointer"), "unavailable");
  assert.equal(started, false);
});
