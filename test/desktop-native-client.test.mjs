import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate } from "node:timers/promises";
import {
  NativeControlClient,
  nativeControlTargetId,
} from "../desktop/home/native-control-client.mjs";

function fixture({
  acceptClaim = true,
  claimExpiresAt = Date.now() + 60_000,
  verifyTarget,
  verifyGrant,
  resultGate,
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
      verifyTarget,
      verifyGrant,
      command(action, data) {
        commands.push({ action, data });
        return action === "native-grant" ? room : undefined;
      },
      async claim(data, current) {
        if (current()) claims.push(data);
        return { accepted: await acceptClaim, expiresAt: claimExpiresAt };
      },
      async result(value, current) {
        if (current()) results.push(value);
        if (value.requestId === "first") await resultGate;
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
  assert.deepEqual(results, [
    { roomEpoch, grantId, requestId: "late", result: undefined },
  ]);
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

test("a window task checks the original arrival again after claiming native dispatch", async () => {
  const claim = Promise.withResolvers();
  let aligned = true;
  const { claims, grant, results, roomEpoch, scopes, sync } = fixture({
    acceptClaim: claim.promise,
    verifyTarget: () => aligned,
  });
  const grantId = await grant();
  sync("turn", {
    roomEpoch,
    grantId,
    requestId: "window-task-click",
    turnId: "turn",
    windowTaskId: "window-task",
    action: { type: "click", ref: "fixture" },
  });
  await setImmediate();
  assert.equal(claims.length, 1);
  aligned = false;
  claim.resolve(true);
  await setImmediate();
  assert.deepEqual(scopes[0].mutations, []);
  assert.equal(results[0].result, undefined);
});

test("local stop cancels a window task's in-flight result but preserves its window grant", async () => {
  const claim = Promise.withResolvers();
  const { claims, client, grant, results, roomEpoch, scopes, sync } = fixture({
    acceptClaim: claim.promise,
    verifyTarget: () => true,
  });
  const grantId = await grant();
  sync("turn", {
    roomEpoch,
    grantId,
    requestId: "window-task-stop",
    turnId: "turn",
    windowTaskId: "window-task",
    action: { type: "click", ref: "fixture" },
  });
  await setImmediate();
  assert.equal(claims.length, 1);
  client.stopWindowTask("old-task");
  assert.equal(scopes[0].closed, false);
  client.stopWindowTask("window-task");
  claim.resolve(true);
  await setImmediate();
  assert.equal(scopes[0].closed, true);
  assert.deepEqual(scopes[0].mutations, []);
  assert.deepEqual(results, []);
  assert.equal(client.selectedWindow("fish", roomEpoch).grantId, grantId);
});

test("a later same-turn request runs in the existing scope while an earlier result is uploading", async () => {
  const gate = Promise.withResolvers();
  const { grant, results, roomEpoch, scopes, sync } = fixture({
    resultGate: gate.promise,
  });
  const grantId = await grant();
  const first = {
    roomEpoch,
    grantId,
    requestId: "first",
    turnId: "turn",
    action: { type: "observe" },
  };
  sync("turn", first);
  await setImmediate();
  assert.equal(results.length, 1);
  sync("turn");
  const action = { type: "click", ref: scopes[0].ref };
  const second = { ...first, requestId: "second", action };
  sync("turn", second);
  assert.equal(scopes[0].closed, false);
  assert.equal(scopes[0].calls.length, 0);
  gate.resolve();
  await setImmediate();
  assert.equal(scopes.length, 1);
  assert.deepEqual(scopes[0].mutations, [action]);
  assert.deepEqual(
    results.map(({ requestId }) => requestId),
    ["first", "second"],
  );
  sync("turn", second);
  await setImmediate();
  assert.equal(scopes[0].mutations.length, 1);
});

test("a selected window must still be visible before dispatch after a positive claim", async () => {
  let checks = 0;
  const { claims, grant, roomEpoch, scopes, sync } = fixture({
    verifyGrant: async () => ++checks === 1,
  });
  const grantId = await grant();
  sync("turn", {
    roomEpoch,
    grantId,
    requestId: "changed-visibility",
    turnId: "turn",
    action: { type: "click", ref: "button" },
  });
  await setImmediate();
  assert.equal(checks, 2);
  assert.equal(claims.length, 1);
  assert.deepEqual(scopes[0].mutations, []);
});

test("unified native targets resume after disconnect without accepting a different window identity", async () => {
  const data = [];
  const results = [];
  const opens = [];
  const roomEpoch = "room";
  const agentId = "fish";
  const first = {
    id: "w-first",
    pid: 300,
    processInstance: "fixture-process",
    app: "fixture",
  };
  const other = { ...first, id: "w-other" };
  const firstId = nativeControlTargetId(first);
  const otherId = nativeControlTargetId(other);
  assert.notEqual(
    firstId,
    nativeControlTargetId({ ...first, processInstance: "reopened" }),
  );
  const room = () => ({ roomEpoch, nativeControl: { grants: [...data] } });
  const client = new NativeControlClient(
    {
      open(source, options) {
        assert.equal(options.unified, true);
        opens.push(source.id);
        return { observe: () => ({ elements: [] }), close() {} };
      },
    },
    {
      async command(action, grant) {
        if (action === "native-grant") data.push(grant);
        else
          data.splice(
            data.findIndex(({ grantId }) => grantId === grant.grantId),
            1,
          );
        return room();
      },
      async result(outcome) {
        results.push(outcome.requestId);
      },
    },
  );
  assert.equal(
    await client.grant({
      roomEpoch,
      agentId,
      source: first,
      targetId: firstId,
    }),
    "granted",
  );
  assert.equal(
    await client.grant({
      roomEpoch,
      agentId,
      source: other,
      targetId: otherId,
    }),
    "granted",
  );
  client.clear();
  client.update(
    {
      room: room(),
      nativeRequests: data.map(({ targetId, grantId }, i) => ({
        roomEpoch,
        targetId,
        grantId,
        requestId: "request-" + i,
        turnId: "turn",
        expiresAt: Date.now() + 10_000,
        action: { type: "observe" },
      })),
    },
    "sync",
  );
  await setImmediate();
  assert.deepEqual(opens, [first.id, other.id]);
  assert.deepEqual(results.sort(), ["request-0", "request-1"]);
  assert.equal(
    await client.revoke(roomEpoch, agentId, data[0].grantId),
    "revoked",
  );
  assert.equal(data.length, 1);
});
