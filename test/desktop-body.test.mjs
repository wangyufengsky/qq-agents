import assert from "node:assert/strict";
import test from "node:test";
import { randomBytes, randomUUID } from "node:crypto";
import { beginRoleRest } from "../src/core/role-rest.mjs";
import { createServer } from "../src/server.mjs";
import { desktopToken } from "../src/home/desktop-auth.mjs";
import {
  DesktopBodyClient,
  bodyDestination,
} from "../desktop/home/body-client.mjs";
import { config, fixture } from "./helpers.mjs";

const tick = () => new Promise(setImmediate);
const move = { type: "move", target: "door", requestId: "move-1" };
const position = { x: -530, y: 60, displayId: 4 };
const completed = { status: "completed", position };

async function setup(
  t,
  {
    enabled = true,
    lateVisitor = false,
    v2 = false,
    crossDisplay = false,
  } = {},
) {
  const cfg = config(2);
  cfg.desktopHome.enabled = true;
  if (enabled)
    cfg.desktopHome.bodyControlRoles = lateVisitor
      ? ["agent-0", "agent-1"]
      : ["agent-0"];
  const turns = [];
  let host;
  t.after(() => {
    host?.reset();
    for (const { gate } of turns) gate.resolve();
  });
  const { runtime } = fixture(t, { cfg });
  host = runtime.desktopVisits;
  const client = randomUUID();
  const token = randomBytes(32).toString("hex");
  const app = createServer({ runtime, token, allowLive: true });
  t.after(() => app.close());
  const base = `http://127.0.0.1:${await app.listen()}/api/desktop-home/`;
  const post = (endpoint, input, key = desktopToken(token)) =>
    fetch(base + endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-desktop-home-token": key,
      },
      body: JSON.stringify({ client, ...input }),
    });
  const act = async (action, data) =>
    (await post("client", { action, data })).json();
  const syncData = {
    visible: false,
    dragged: [],
    bodyProtocol: 2,
    ...(crossDisplay && { bodyCrossDisplay: true }),
  };
  const sync = async (data, from = client) =>
    (
      await post("client", {
        client: from,
        action: "sync",
        data: { ...syncData, ...data },
      })
    ).json();
  if (v2) await sync();
  else await act("sync");
  for (const agent of runtime.config.agents) {
    const role = host.live.room.roles.find(({ id }) => id === agent.id);
    if (!lateVisitor || role.id === "agent-0") {
      host.live.room.members[role.id] = "invited";
      host.live.admit(role);
    }
    const backend = runtime.backendConnections.adapter(agent);
    backend.runDesktop = async (params) => {
      params.beforeInput();
      params.onInputSubmitted();
      const gate = Promise.withResolvers();
      turns.push({
        actor: agent.id,
        call: (args) => params.callTool("desktop_body_control", args),
        gate,
      });
      const decision = await gate.promise;
      if (!params.signal.aborted)
        await params.callTool(
          "desktop_room_decide",
          decision ?? { action: "silent" },
        );
    };
  }
  const start = async () => {
    const turnCount = turns.length;
    await act("send", "@角色0 去小门旁边");
    for (let i = 0; i < 8 && turns.length <= turnCount; i++) await tick();
    assert(turns.length > turnCount);
    return turns.at(-1);
  };
  const request = async () =>
    (await (v2 ? sync() : act("sync"))).bodyRequests?.[0];
  const identity = ({ roomEpoch, commandId, agentId, visitId }) => ({
    roomEpoch,
    commandId,
    ...(visitId && { agentId, visitId }),
  });
  return {
    runtime,
    host,
    client,
    post,
    act,
    start,
    request,
    identity,
    sync,
    turns,
  };
}

test("only an opted-in desktop role can submit actions", async (t) => {
  const { runtime, start, request } = await setup(t, { enabled: false });
  assert(
    !runtime
      .toolsFor(runtime.agent("agent-0"), "@desktop")
      .includes("desktop_body_control"),
  );
  runtime.config.desktopHome.bodyControlRoles.push("agent-0");
  assert(
    runtime
      .toolsFor(runtime.agent("agent-0"), "@desktop")
      .includes("desktop_body_control"),
  );
  assert(
    !runtime
      .toolsFor(runtime.agent("agent-1"), "@desktop")
      .includes("desktop_body_control"),
  );
  runtime.agent("agent-0").tools.push("desktop_body_control");
  assert(
    !runtime
      .toolsFor(runtime.agent("agent-0"), "private:30000")
      .includes("desktop_body_control"),
  );
  const { call } = await start();
  await assert.rejects(call({ ...move, agentId: "agent-1" }));
  assert.equal(await request(), undefined);
});

test("a new visitor cannot use a previous administrator message as a body command", async (t) => {
  const { host, turns, start } = await setup(t, { lateVisitor: true });
  const first = await start();
  const role = host.live.room.roles.find(({ id }) => id === "agent-1");
  host.live.room.members[role.id] = "invited";
  host.live.admit(role);
  first.gate.resolve({ action: "say", text: "你好" });
  for (let i = 0; i < 8 && turns.length < 2; i++) await tick();
  const visitor = turns.at(-1);
  assert.equal(visitor.actor, "agent-1");
  const submitted = visitor.call(move).catch((error) => error);
  await tick();
  assert.equal(host.body.pending.size, 0);
  assert.match(
    (await submitted).message,
    /DESKTOP_BODY_UNAVAILABLE|TOOL_DISABLED/,
  );
});

test("body receipts wait for the client and duplicate calls share the result", async (t) => {
  const { post, start, request, identity } = await setup(t);
  const { call } = await start();
  const first = call(move);
  const second = call(move);
  await assert.rejects(
    call({ ...move, target: "seat" }),
    /DESKTOP_BODY_INVALID/,
  );
  await assert.rejects(
    call({ ...move, requestId: "other" }),
    /DESKTOP_BODY_BUSY/,
  );
  const req = await request();
  assert.equal(req.agentId, "agent-0");
  const id = identity(req);
  const status = () => call({ type: "status", requestId: move.requestId });
  assert.equal((await status()).status, "queued");
  assert.equal((await post("body-claim", id, "invalid")).status, 401);
  assert.equal(
    (await post("body-result", { ...id, result: completed })).ok,
    false,
  );
  assert.equal(
    (await post("body-claim", { ...id, client: randomUUID() })).ok,
    false,
  );
  assert.equal((await post("body-claim", id)).ok, true);
  assert.equal((await post("body-claim", id)).ok, false);
  assert.equal((await status()).status, "executing");
  assert.equal(
    (await post("body-result", { ...id, result: completed })).ok,
    true,
  );
  const receipt = { ...completed, requestId: move.requestId };
  assert.deepEqual(await first, receipt);
  assert.deepEqual(await second, receipt);
  assert.deepEqual(await status(), receipt);
  assert.deepEqual(await call(move), receipt);
  assert.equal(await request(), undefined);
  assert.equal(
    (await post("body-result", { ...id, result: completed })).ok,
    false,
  );
});

test("stop cancels a claimed action and reports the actual stop position", async (t) => {
  const { post, start, request, identity } = await setup(t);
  const { call } = await start();
  const result = call(move);
  const id = identity(await request());
  assert.equal((await post("body-claim", id)).ok, true);
  const stop = call({ type: "stop" });
  assert.equal((await request()).cancel, true);
  const cancelled = { status: "cancelled", reason: "stopped", position };
  assert((await post("body-result", { ...id, result: cancelled })).ok);
  assert.deepEqual(await stop, await result);
  assert.deepEqual(await result, { ...cancelled, requestId: move.requestId });
});

for (const cause of [
  "revoke",
  "qq",
  "leave",
  "disconnect",
  "pause",
  "new-message",
]) {
  test(`body actions lose authorization after ${cause}`, async (t) => {
    const { runtime, host, act, post, start, request, identity } =
      await setup(t);
    const { call } = await start();
    const action = call(move);
    const id = identity(await request());
    const receipt = host.body.pending.get("agent-0").receipt.promise;
    const toolSettled = action.catch((error) => error);
    assert.equal((await post("body-claim", id)).ok, true);
    switch (cause) {
      case "revoke":
        runtime.config.desktopHome.bodyControlRoles = [];
        break;
      case "qq":
        host.interrupt("agent-0");
        break;
      case "leave":
        await act("leave", "agent-0");
        break;
      case "disconnect":
        await act("disconnect");
        break;
      case "pause":
        runtime.config.globalPaused = true;
        break;
      case "new-message":
        await act("send", "新消息");
        break;
    }
    assert.equal(
      (await post("body-result", { ...id, result: completed })).ok,
      false,
    );
    assert.equal(await request(), undefined);
    assert.equal((await receipt).status, "unknown");
    await toolSettled;
    assert.equal((await post("body-claim", id)).ok, false);
  });
}

test("same-client sync can recover one claimed terminal after the execution lease", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const { client, post, start, request, identity, sync } = await setup(t, {
    v2: true,
  });
  const { call } = await start();
  const action = call(move);
  const req = await request();
  const id = identity(req);
  const evidence = {
    ...id,
    finishedAt: req.expiresAt - 100,
    result: completed,
  };
  assert.deepEqual(
    (await sync({ bodyResults: [evidence] })).bodyResultAcks,
    undefined,
  );
  assert.equal(
    (await post("body-claim", { ...id, visitId: randomUUID() })).ok,
    false,
  );
  assert.equal((await post("body-claim", id)).ok, true);
  t.mock.timers.setTime(req.expiresAt + 100);
  assert.deepEqual((await sync()).bodyRequests, []);
  assert.equal((await post("body-claim", id)).ok, false);
  assert.equal((await post("body-result", evidence)).ok, false);
  assert.equal(
    (await sync({ bodyResults: [evidence] }, randomUUID())).busy,
    true,
  );
  const invalid = [
    { ...evidence, visitId: randomUUID() },
    { ...evidence, roomEpoch: randomUUID() },
    { ...evidence, agentId: "agent-1" },
    { ...evidence, finishedAt: req.expiresAt },
  ];
  assert.equal(
    (await sync({ bodyResults: invalid })).bodyResultAcks,
    undefined,
  );
  const fresh = { agentId: "agent-0", x: -400, y: 50, displayId: 4 };
  const recovery = await sync(
    {
      bodyResults: [evidence, evidence],
      bodyPositions: { roomEpoch: req.roomEpoch, positions: [fresh] },
    },
    client,
  );
  assert.deepEqual(recovery.bodyResultAcks, [req.commandId]);
  assert.deepEqual(recovery.bodyRequests, []);
  const terminal = {
    ...completed,
    requestId: move.requestId,
    reconciled: true,
    finishedAt: evidence.finishedAt,
  };
  assert.deepEqual(await action, terminal);
  assert.deepEqual(await call({ type: "status", requestId: move.requestId }), {
    ...terminal,
    currentPosition: { x: fresh.x, y: fresh.y, displayId: fresh.displayId },
  });
  assert.equal(
    (await sync({ bodyResults: [evidence] })).bodyResultAcks,
    undefined,
  );
});

for (const invalidation of [
  "revisit",
  "lease-expiry",
  "replaced",
  "buffer-expiry",
  "revoke",
  "rest-pending",
]) {
  test(`sync cannot recover a body terminal after ${invalidation}`, async (t) => {
    t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
    const { runtime, host, act, post, start, request, identity, sync } =
      await setup(t, { v2: true });
    const { call } = await start();
    const action = call(move).catch((error) => error);
    const req = await request();
    const receipt = host.body.pending.get("agent-0").receipt.promise;
    const id = identity(req);
    assert.equal((await post("body-claim", id)).ok, true);
    const evidence = { ...id, finishedAt: Date.now(), result: completed };
    let nextClient;
    switch (invalidation) {
      case "revisit": {
        const role = host.live.room.roles[0];
        await act("leave", role.id);
        host.live.room.members[role.id] = "invited";
        host.live.admit(role);
        break;
      }
      case "lease-expiry":
        runtime.clock = () => Date.now() + 15_000;
        break;
      case "replaced":
        await act("disconnect");
        nextClient = randomUUID();
        break;
      case "buffer-expiry":
        t.mock.timers.setTime(req.expiresAt + 3000);
        break;
      case "revoke":
        runtime.config.desktopHome.bodyControlRoles = [];
        break;
      case "rest-pending": {
        const agent = runtime.agent("agent-0");
        agent.subject.inboxEnabled = true;
        agent.subject.enabled = true;
        beginRoleRest(runtime, agent, { durationMs: 60000, earlyWake: "none" });
        break;
      }
    }
    const recovered = await sync({ bodyResults: [evidence] }, nextClient);
    assert.equal(recovered.bodyResultAcks, undefined);
    assert.deepEqual(recovered.bodyRequests, []);
    assert.equal((await receipt).status, "unknown");
    await action;
  });
}

const bounds = { x: position.x, y: position.y, width: 120, height: 150 };
const displayRef = "display-fixture";
const workArea = { x: -1000, y: 0, width: 1000, height: 800 };
const stateResult = (layoutVersion) => ({
  ...completed,
  facing: "right",
  space: {
    layoutVersion,
    sampledAt: Date.now(),
    displays: [{ ref: displayRef, workArea, scaleFactor: 2 }],
    self: { displayRef, bounds, facing: "right", pose: "stand" },
    residents: [],
  },
});
const point = {
  type: "move",
  requestId: "point",
  layoutVersion: 1,
  target: { type: "point", displayRef, x: -390, y: 60 },
};

test("structured targets must match the latest fresh state receipt and retry by value", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const { post, start, request, identity } = await setup(t, { v2: true });
  const { call } = await start();
  await assert.rejects(call(point), /DESKTOP_BODY_STALE_LAYOUT/);
  const sendResult = async (result) => {
    const id = identity(await request());
    assert.equal((await post("body-claim", id)).ok, true);
    assert.equal(
      (await post("body-result", { ...id, finishedAt: Date.now(), result })).ok,
      true,
    );
  };
  const first = call({ type: "state", requestId: "state-1" });
  const snapshot = stateResult(1);
  await sendResult(snapshot);
  assert.deepEqual((await first).space, snapshot.space);
  await assert.rejects(
    call({ ...point, target: { ...point.target, x: -20 } }),
    /DESKTOP_BODY_INVALID/,
  );
  await assert.rejects(
    call({
      ...point,
      target: { type: "near-resident", residentRef: "unknown" },
    }),
    /DESKTOP_BODY_INVALID/,
  );
  const action = call(point);
  const retry = call({ ...point, target: { ...point.target } });
  await assert.rejects(
    call({ ...point, target: { ...point.target, x: -400 } }),
    /DESKTOP_BODY_INVALID/,
  );
  await sendResult(completed);
  assert.deepEqual(await action, await retry);
  const second = call({ type: "state", requestId: "state-2" });
  await sendResult(stateResult(2));
  await second;
  await assert.rejects(
    call({ ...point, requestId: "stale-version" }),
    /DESKTOP_BODY_STALE_LAYOUT/,
  );
  t.mock.timers.tick(5001);
  await assert.rejects(
    call({ ...point, requestId: "old-layout", layoutVersion: 2 }),
    /DESKTOP_BODY_STALE_LAYOUT/,
  );
});

test("client cancels on local drag and suppresses stale requests after connection loss", async () => {
  const results = [];
  let executions = 0;
  let cancels = 0;
  const body = new DesktopBodyClient({
    claim: async () => ({ accepted: true }),
    result: async ({ result }) => results.push(result),
    position: () => ({ position }),
    execute() {
      executions++;
      return () => cancels++;
    },
  });
  const req = {
    roomEpoch: "room",
    commandId: "command",
    agentId: "role",
    expiresAt: Date.now() + 5000,
  };
  const sync = (bodyRequests) =>
    body.update({ room: { roomEpoch: "room" }, bodyRequests }, "sync");
  sync([req]);
  await tick();
  body.stop("role", "manual-control");
  sync([req]);
  assert.deepEqual(results, [
    { position, status: "cancelled", reason: "manual-control" },
  ]);
  assert.equal(cancels, 1);
  body.update({ offline: true }, "sync");
  sync([req]);
  await tick();
  assert.equal(executions, 1);
  assert.equal(results.length, 1);
});

test("client buffers the captured terminal across offline syncs and never replays movement", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  let actual = position;
  let executions = 0;
  const cancellations = [];
  const directResults = [];
  let finish;

  const req = {
    roomEpoch: "room",
    commandId: "command",
    agentId: "role",
    visitId: "visit",
    expiresAt: Date.now() + 5000,
  };
  const body = new DesktopBodyClient({
    claim: async () => ({ accepted: true }),
    result: async (result) => {
      directResults.push(result);
      throw Error("DESKTOP_CONNECTION_FAILED");
    },
    position: () => ({ position: actual }),
    execute(request, current, terminal) {
      executions++;
      finish = terminal;
      return (reason) => {
        cancellations.push(reason);
        terminal({ status: "completed" });
      };
    },
  });
  const sync = (bodyRequests, bodyResultAcks) =>
    body.update(
      {
        room: { roomEpoch: "room" },
        bodyProtocol: 2,
        bodyRequests,
        bodyResultAcks,
      },
      "sync",
    );
  sync([req]);
  await tick();
  body.update({ offline: true }, "sync");
  actual = { ...position, x: -210 };
  const { expiresAt, ...id } = req;
  assert.deepEqual(body.recovery(), [
    {
      ...id,
      finishedAt: Date.now(),
      result: { position, status: "cancelled", reason: "disconnect" },
    },
  ]);
  sync([req]);
  await tick();
  assert.equal(executions, 1);
  assert.deepEqual(cancellations, ["disconnect"]);
  sync([], [req.commandId]);
  assert.deepEqual(body.recovery(), []);
  const next = { ...req, commandId: "next" };
  sync([next]);
  await tick();
  finish({ status: "completed" });
  await tick();
  body.update({ offline: true }, "sync");
  assert.deepEqual(cancellations, ["disconnect"]);
  assert.deepEqual(body.recovery(), directResults);
  assert.deepEqual(directResults[0].result, {
    status: "completed",
    position: actual,
  });
  t.mock.timers.tick(3000);
  assert.deepEqual(body.recovery(), []);
});

test("a delayed claim cannot execute after an invalidating sync", async () => {
  const gate = Promise.withResolvers();
  let executions = 0;
  const body = new DesktopBodyClient({
    claim: () => gate.promise,
    result: async () => {},
    position: () => ({ position }),
    execute() {
      executions++;
    },
  });
  const req = {
    roomEpoch: "room",
    commandId: "command",
    agentId: "role",
    expiresAt: Date.now() + 5000,
  };
  body.update({ room: { roomEpoch: "room" }, bodyRequests: [req] }, "sync");
  body.update({ room: { roomEpoch: "new" }, bodyRequests: [] }, "sync");
  gate.resolve({ accepted: true });
  await tick();
  assert.equal(executions, 0);
});

test("door and seat targets stay inside the current display work area", () => {
  const bounds = { x: -900, y: 40, width: 194, height: 156 };
  const display = {
    id: 4,
    workArea: { x: -1000, y: 30, width: 1000, height: 750 },
  };
  const opts = {
    bounds,
    display,
    door: { x: -106, y: 670, width: 100, height: 118 },
    seat: { x: -850, y: 30 },
    displayAt: ({ x }) => ({ id: x < 0 ? 4 : 5 }),
    clamp: ({ x, y }, width, height, area) => ({
      x: Math.max(area.x, Math.min(x, area.x + area.width - width)),
      y: Math.max(area.y, Math.min(y, area.y + area.height - height)),
    }),
  };
  assert.deepEqual(bodyDestination({ ...opts, target: "door" }), {
    x: -312,
    y: 624,
  });
  assert.deepEqual(bodyDestination({ ...opts, target: "seat" }), opts.seat);
  assert.equal(
    bodyDestination({ ...opts, target: "door", door: { ...opts.door, x: 20 } }),
    null,
  );
  assert.equal(
    bodyDestination({ ...opts, target: "seat", seat: { x: 20, y: 50 } }),
    null,
  );
});

for (const crossDisplay of [false, true]) {
  test(`cross-display action requires the negotiated client capability (${crossDisplay})`, async (t) => {
    const { post, start, request, identity, sync } = await setup(t, {
      v2: true,
      crossDisplay,
    });
    assert.equal((await sync()).bodyCrossDisplay, true);
    const { call } = await start();
    const otherDisplay = {
      ref: "other",
      workArea: { x: 0, y: 0, width: 800, height: 600 },
      scaleFactor: 1.25,
    };
    const state = call({ type: "state", requestId: "displays" });
    const snapshot = stateResult(1);
    snapshot.space.displays.push(otherDisplay);
    const sendResult = async (result) => {
      const pending = await request();
      assert.equal(pending.crossDisplay, crossDisplay ? true : undefined);
      const id = identity(pending);
      assert.equal((await post("body-claim", id)).ok, true);
      if (result.space) result.space.sampledAt = Date.now();
      assert.equal(
        (await post("body-result", { ...id, finishedAt: Date.now(), result }))
          .ok,
        true,
      );
    };
    await sendResult(snapshot);
    await state;
    const cross = {
      ...point,
      target: { type: "corner", displayRef: "other", corner: "ne" },
    };
    if (!crossDisplay) {
      await assert.rejects(call(cross), /DESKTOP_BODY_INVALID/);
      return;
    }
    await assert.rejects(
      call({
        ...cross,
        target: { type: "point", displayRef: "other", x: 799, y: 1 },
      }),
      /DESKTOP_BODY_INVALID/,
    );
    const action = call(cross);
    await sendResult({
      status: "failed",
      reason: "target-unreachable",
      position,
    });
    assert.equal((await action).reason, "target-unreachable");
  });
}
