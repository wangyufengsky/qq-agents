import assert from "node:assert/strict";
import test from "node:test";
import { randomBytes, randomUUID } from "node:crypto";
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

async function setup(t, { enabled = true, lateVisitor = false } = {}) {
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
  await act("sync");
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
  const request = async () => (await act("sync")).bodyRequests?.[0];
  const identity = ({ roomEpoch, commandId }) => ({ roomEpoch, commandId });
  return {
    runtime,
    host,
    client,
    post,
    act,
    start,
    request,
    identity,
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
