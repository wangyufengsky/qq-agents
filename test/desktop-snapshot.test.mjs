import test from "node:test";
import assert from "node:assert/strict";
import { createDesktopSnapshot } from "../desktop/home/snapshot.mjs";

test("frame receipts are projected only to the panel snapshot", () => {
  const receipts = [{ requestId: "q", state: "submitted" }];
  const room = { bubbles: {} };
  const projection = createDesktopSnapshot({
    context: {
      frameworkRoot: "configured",
      remoteState: { frameReceipts: receipts, roles: [] },
      sizes: {},
    },
    room,
    screenGrants: new Map(),
    places: new Map(),
    entries: new Map(),
    permissionRevision: () => undefined,
    windowTaskGrant: () => undefined,
  });
  assert.equal(projection.snapshot().frameReceipts, undefined);
  assert.deepEqual(projection.snapshot(true).frameReceipts, receipts);
});
