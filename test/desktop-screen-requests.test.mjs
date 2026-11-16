import assert from "node:assert/strict";
import { test } from "node:test";
import { createScreenRequests } from "../desktop/home/screen-requests.mjs";

test("manual capture revalidates the target just before frame delivery", async () => {
  const roomEpoch = "room";
  const grant = { roomEpoch, agentId: "agent", grantId: "grant", source: {} };
  const requested = Promise.withResolvers();
  const screenGrants = new Map([[grant.agentId, grant]]);
  let probes = 0;
  const controller = createScreenRequests({
    context: {
      framework: {
        async result(route, payload, current, beforeDelivery) {
          try {
            assert.equal(route, "screen-result");
            assert.equal(payload.data, "synthetic-frame");
            assert.ok(current());
            assert.equal(await beforeDelivery(), false);
            requested.resolve();
          } catch (error) {
            requested.reject(error);
          }
        },
      },
    },
    screenGrants,
    windowGrants: new Map(),
    displayGrants: new Map(),
    localScreen: (grantId) => grant.grantId === grantId && grant,
    permissionRevision: () => 2,
    verifyApproachedWindow: async () => true,
    readObservationTarget: async (source) => ({
      state: ++probes === 3 ? "blocked" : "ready",
      source,
    }),
    captureScreenSource: async () => ({ data: "synthetic-frame" }),
  });
  controller.handle(
    {
      room: {
        roomEpoch,
        screenView: { eligible: [grant.agentId], grants: [grant] },
      },
      screenRequest: {
        roomEpoch,
        grantId: grant.grantId,
        requestId: "request",
      },
    },
    "sync",
  );
  assert.equal(controller.active.grant, grant);
  await requested.promise;
  await Promise.resolve();
  assert.equal(probes, 3);
  assert.equal(controller.active, undefined);
});
