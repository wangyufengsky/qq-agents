import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { DesktopHost } from "../src/home/desktop-host.mjs";

test("desktop commands validate action data before refreshing state", () => {
  const client = randomUUID();
  const roomEpoch = randomUUID();
  const grantId = randomUUID();
  const visitId = randomUUID();
  const revoke = { roomEpoch, grantId };
  const grant = { ...revoke, agentId: "agent-1" };
  const display = {
    ...grant,
    scope: "display",
    limits: { minutes: 1, attempts: 1 },
  };
  const values = {
    sync: [undefined, true, false, { visible: true, dragged: [] }],
    invite: ["agent-1"],
    leave: ["agent-1"],
    send: ["hello"],
    "door-mode": ["welcome"],
    "knock-answer": [true],
    disconnect: [undefined],
    "activity-pause": [false],
    "screen-grant": [grant],
    "screen-revoke": [revoke],
    "screen-grant-batch": [[{ ...grant, visitId }]],
    "screen-revoke-batch": [[revoke]],
    "display-grant-batch": [[{ ...display, visitId }]],
    "display-revoke-batch": [[revoke]],
    "observation-grant": [grant, display],
    "observation-revoke": [revoke],
    "observation-state": [{ ...revoke, state: "ready" }],
    "window-task": [{ ...grant, scope: "native", text: "open" }],
    "window-task-stop": ["task"],
    "native-grant": [grant, { ...grant, visitId, confirmed: true }],
    "native-revoke": [revoke],
    "browser-grant": [{ ...grant, origin: "https://example.com" }],
    "browser-revoke": [revoke],
  };
  let refreshes = 0;
  const host = {
    refresh() {
      refreshes++;
      return false;
    },
    configured() {
      return true;
    },
  };
  for (const [action, samples] of Object.entries(values)) {
    for (const data of samples) {
      const before = refreshes;
      assert.deepEqual(
        DesktopHost.prototype.command.call(host, { client, action, data }),
        { enabled: false },
        action,
      );
      assert.equal(refreshes, before + 1, action);
    }
    const invalid =
      action === "sync" ? "hello" : action === "disconnect" ? true : undefined;
    const before = refreshes;
    assert.throws(
      () =>
        DesktopHost.prototype.command.call(host, {
          client,
          action,
          data: invalid,
        }),
      /INVALID_REQUEST/,
      action,
    );
    assert.equal(refreshes, before, action);
  }
  for (const [action, data] of [
    ["screen-grant-batch", [revoke]],
    ["browser-revoke", grant],
    ["sync", { visible: true, dragged: [], extra: true }],
    ["send", true],
  ]) {
    assert.throws(
      () => DesktopHost.prototype.command.call(host, { client, action, data }),
      /INVALID_REQUEST/,
      action,
    );
  }
});
