import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate } from "node:timers/promises";
import { NativeControlClient } from "../desktop/home/native-control-client.mjs";

function fixture({
  acceptClaim = true,
  claimExpiresAt = Date.now() + 60_000,
} = {}) {
  const roomEpoch = "room";
  const agentId = "fish";
  const room = {
    roomEpoch,
    nativeControl: { eligible: [agentId], grantedAgentId: agentId },
  };
  const source = { id: "local-window", title: "Test fixture" };
  const scopes = [];
  const commands = [];
  const claims = [];
  const results = [];
  const client = new NativeControlClient(
    {
      open(target) {
        assert.equal(target, source);
        const scope = {
          ref: `ref-${scopes.length}`,
          closed: false,
          calls: [],
          mutations: [],
          observe() {
            return { elements: [{ ref: scope.ref, role: "button" }] };
          },
          async act(action, { signal, beforeDispatch }) {
            scope.calls.push({ action, signal });
            if (action.wait)
              return new Promise((_, reject) => {
                signal.addEventListener("abort", () => reject(signal.reason), {
                  once: true,
                });
              });
            if (!(await beforeDispatch())) return;
            scope.mutations.push(action);
            return { changed: true };
          },
          close() {
            scope.closed = true;
          },
        };
        scopes.push(scope);
        return scope;
      },
    },
    {
      command(action, data) {
        commands.push({ action, data });
        return action === "native-grant" ? room : undefined;
      },
      async claim(data, current) {
        if (current()) claims.push(data);
        return { accepted: await acceptClaim, expiresAt: claimExpiresAt };
      },
      result(value, current) {
        if (current()) results.push(value);
      },
    },
  );
  const grant = async () => {
    assert.equal(await client.grant({ roomEpoch, agentId, source }), "granted");
    const { data } = commands[0];
    assert.deepEqual(Object.keys(data).sort(), [
      "agentId",
      "grantId",
      "roomEpoch",
    ]);
    return data.grantId;
  };
  const sync = (nativeTurnId, nativeRequest) =>
    client.update(
      {
        room,
        nativeTurnId,
        nativeRequest: nativeRequest && {
          expiresAt: Date.now() + 60_000,
          ...nativeRequest,
        },
      },
      "sync",
    );
  const revoke = () => client.revoke(roomEpoch, agentId);
  return {
    claims,
    client,
    commands,
    grant,
    results,
    revoke,
    roomEpoch,
    scopes,
    sync,
  };
}

test("native control deduplicates requests and creates a fresh scope per turn", async () => {
  const { grant, results, roomEpoch, scopes, sync } = fixture();
  const grantId = await grant();
  const observe = {
    roomEpoch,
    grantId,
    requestId: "first",
    turnId: "turn-1",
    action: { type: "observe" },
  };
  sync("turn-1", { ...observe, grantId: "stale" });
  assert.equal(scopes.length, 0);
  sync("turn-1", observe);
  sync("turn-1", observe);
  await setImmediate();
  sync("turn-1", observe);
  assert.equal(results.length, 1);
  assert.equal(scopes.length, 1);
  const action = { type: "click", ref: scopes[0].ref };
  sync("turn-1", { ...observe, requestId: "second", action });
  await setImmediate();
  assert.equal(scopes.length, 1);
  assert.deepEqual(scopes[0].calls[0].action, action);
  assert.deepEqual(scopes[0].mutations, [action]);
  sync("turn-2", { ...observe, requestId: "third", turnId: "turn-2" });
  await setImmediate();
  assert.equal(scopes[0].closed, true);
  assert.equal(scopes.length, 2);
  assert.equal(results.length, 3);
  assert.notEqual(
    results[0].result.elements[0].ref,
    results[2].result.elements[0].ref,
  );
  sync();
  assert.equal(scopes[1].closed, true);
});

test("a stale sync reply cannot mutate a window when its server claim is denied", async () => {
  const { claims, grant, results, roomEpoch, scopes, sync } = fixture({
    acceptClaim: false,
  });
  const grantId = await grant();
  const requestId = "stale";
  sync("turn", {
    roomEpoch,
    grantId,
    requestId,
    turnId: "turn",
    action: { type: "click", ref: "old-ref" },
  });
  await setImmediate();
  assert.deepEqual(claims, [{ roomEpoch, grantId, requestId }]);
  assert.deepEqual(scopes[0].mutations, []);
  assert.equal(results[0].result, undefined);
});

test("revoking during a claim prevents mutation even if the server accepts it", async () => {
  const { promise, resolve } = Promise.withResolvers();
  const { claims, grant, results, revoke, roomEpoch, scopes, sync } = fixture({
    acceptClaim: promise,
  });
  const grantId = await grant();
  sync("turn", {
    roomEpoch,
    grantId,
    requestId: "late",
    turnId: "turn",
    action: { type: "click", ref: "old-ref" },
  });
  assert.equal(claims.length, 1);
  assert.equal(await revoke(), "revoked");
  resolve(true);
  await setImmediate();
  assert.deepEqual(scopes[0].mutations, []);
  assert.deepEqual(results, []);
});

test("a delayed positive claim cannot dispatch after its expiry without a newer poll", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 1_000 });
  const { promise, resolve } = Promise.withResolvers();
  const { claims, grant, roomEpoch, scopes, sync } = fixture({
    acceptClaim: promise,
    claimExpiresAt: 2_000,
  });
  const grantId = await grant();
  const request = {
    roomEpoch,
    grantId,
    requestId: "late",
    turnId: "turn",
    action: { type: "click", ref: "old-ref" },
  };
  sync("turn", { ...request, expiresAt: Date.now() });
  assert.equal(scopes.length, 0);
  sync("turn", request);
  assert.equal(claims.length, 1);
  t.mock.timers.setTime(2_000);
  resolve(true);
  await setImmediate();
  assert.deepEqual(scopes[0].mutations, []);
});

test("native control aborts a withdrawn request and revokes local access immediately", async () => {
  const { commands, grant, results, revoke, roomEpoch, scopes, sync } =
    fixture();
  const grantId = await grant();
  const request = {
    roomEpoch,
    grantId,
    requestId: "cancelled",
    turnId: "turn",
    action: { type: "click", ref: "blocked", wait: true },
  };
  sync("turn", request);
  const [{ signal }] = scopes[0].calls;
  sync("turn");
  assert.equal(signal.aborted, true);
  assert.equal(scopes[0].closed, true);
  await setImmediate();
  assert.deepEqual(results, []);
  sync("turn", { ...request, requestId: "revoked" });
  const [{ signal: revoked }] = scopes[1].calls;
  const revocation = revoke();
  assert.equal(revoked.aborted, true);
  assert.equal(scopes[1].closed, true);
  assert.equal(await revocation, "revoked");
  await setImmediate();
  assert.deepEqual(results, []);
  assert.deepEqual(commands[1], {
    action: "native-revoke",
    data: { roomEpoch, grantId },
  });
});
