import assert from "node:assert/strict";
import { test } from "node:test";
import { createCompanionController } from "../desktop/home/companion-controller.mjs";

test("an older mode acknowledgement cannot release a newer permission barrier", async () => {
  const requests = [];
  const context = {
    framework: {
      authorization(action, mode) {
        assert.equal(action, "mode-set");
        const response = Promise.withResolvers();
        requests.push({ mode, ...response });
        return response.promise;
      },
    },
    selectedMode: "presence",
    remoteState: {
      connected: true,
      roomEpoch: "room",
      companionMode: "privacy",
      companionRevision: 1,
    },
  };
  const { permissionRevision, syncCompanionMode } = createCompanionController({
    context,
    update() {},
  });
  const pendingPresence = syncCompanionMode();
  context.selectedMode = "work";
  const pendingWork = syncCompanionMode();
  assert.deepEqual(
    requests.map(({ mode }) => mode),
    ["presence", "work"],
  );
  context.remoteState.companionMode = "work";
  context.remoteState.companionRevision = 3;
  requests[0].resolve({ roomEpoch: "room", companionMode: "presence" });
  assert.equal(await pendingPresence, true);
  assert.equal(permissionRevision("control"), undefined);
  requests[1].resolve(context.remoteState);
  assert.equal(await pendingWork, true);
  assert.equal(permissionRevision("control"), 3);
});
