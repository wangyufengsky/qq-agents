import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { setImmediate } from "node:timers/promises";
import { DesktopBodyClient } from "../desktop/home/body-client.mjs";
import { DESKTOP_WINDOW_TASK_CONVERSATION } from "../src/home/desktop-decision.mjs";
import { config, fixture } from "./helpers.mjs";

const frame =
  "/9j/4AAQSkZJRgABAgAAAQABAAD//gAQTGF2YzYyLjI4LjEwMAD/2wBDAAgEBAQEBAUFBQUFBQYGBgYGBgYHBwcICAgHBwcGBscHCAgICAkJCQgICAgJCQoKCgwLCgoMDQoICAj/xAAUAQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIQAxAAAAH/2Q==";
const agentId = "agent-0";

async function until(read) {
  for (let i = 0; i < 30; i++) {
    const result = read();
    if (result) return result;
    await setImmediate();
  }
  assert.fail("expected desktop work");
}

function setup(t, scope) {
  const cfg = config(1);
  cfg.desktopHome.enabled = true;
  cfg.desktopHome.interactionsEnabled = true;
  cfg.desktopHome.bodyControlRoles = [agentId];
  cfg.desktopHome.toolRoles = [agentId];
  cfg.desktopHome.screenView.enabled = true;
  cfg.desktopHome.nativeControl.enabled = true;
  cfg.agents[0].behavior.imageInput.enabled = true;
  const model = Promise.withResolvers();
  const run = Promise.withResolvers();
  let host;
  t.after(() => {
    host?.reset();
    run.resolve();
  });
  const { runtime, store } = fixture(t, { cfg });
  host = runtime.desktopVisits;
  const client = randomUUID();
  const sync = () =>
    command("sync", {
      visible: true,
      dragged: [],
      bodyProtocol: 2,
      bodyInteractions: true,
    });
  const command = (action, data) => host.command({ client, action, data });
  const { room } = sync();
  const role = host.live.room.roles[0];
  host.live.room.members[role.id] = "invited";
  host.live.admit(role);
  const grantId = randomUUID();
  const roomEpoch = room.roomEpoch;
  command(scope + "-grant", { roomEpoch, grantId, agentId });
  const input = {
    roomEpoch,
    grantId,
    agentId,
    scope,
    text: "确认测试窗口的状态",
  };
  runtime.backendConnections.adapter(runtime.agent(agentId)).runDesktop =
    async (params) => {
      params.beforeInput();
      params.onInputSubmitted();
      model.resolve(params);
      await run.promise;
    };
  const start = () => command("window-task", input);
  const getArrival = async () => {
    const request = await until(() => sync().bodyRequests?.[0]);
    const { roomEpoch, commandId, visitId } = request;
    const identity = { client, roomEpoch, commandId, agentId, visitId };
    assert.equal(request.action.type, "window-task");
    assert.equal(request.windowTask.grantId, grantId);
    host.body.claim(identity);
    return { request, identity };
  };
  const arrive = (identity, result) =>
    host.body.receive({ ...identity, finishedAt: Date.now(), result });
  const stage = () => sync().room.windowTaskStatus?.stage;
  return {
    client,
    store,
    host,
    command,
    sync,
    input,
    start,
    getArrival,
    arrive,
    stage,
    model,
    run,
  };
}

test("a window task exposes only the authorized second step after a private arrival and retires its own session", async (t) => {
  const f = setup(t, "screen");
  const memory = f.store.bind(agentId);
  const cursor = f.host.live.visits.get(agentId).cursor;
  const ordinarySession = { backend: "codex", id: "ordinary-desktop" };
  memory.setState("@desktop", {
    ...memory.state("@desktop"),
    session: ordinarySession,
  });
  assert.throws(
    () => f.command("window-task", { ...f.input, grantId: randomUUID() }),
    /DESKTOP_WINDOW_TASK_UNAVAILABLE/,
  );
  assert.equal(f.start().room.windowTaskStatus.stage, "approaching");
  const { request, identity } = await f.getArrival();
  assert.equal(f.sync().screenRequest, undefined);
  assert.throws(
    () =>
      f.arrive(identity, {
        status: "completed",
        position: { x: 100, y: 100, displayId: 3 },
      }),
    /DESKTOP_BODY_INVALID/,
  );
  assert.deepEqual(
    f.arrive(identity, { status: "completed", arrivalConfirmed: true }),
    { accepted: true },
  );
  const params = await f.model.promise;
  assert.equal(f.stage(), "ready");
  assert.equal(
    params.managedContext.conversation,
    DESKTOP_WINDOW_TASK_CONVERSATION,
  );
  assert.equal(params.managedContext.session ?? null, null);
  params.managedContext.saveSession({ backend: "codex", id: "window-task" });
  assert.deepEqual(
    params.tools.map(({ function: tool }) => tool.name),
    ["desktop_room_decide", "desktop_screen_view"],
  );
  assert(params.prompt.includes(f.input.text));
  await assert.rejects(
    params.callTool("desktop_native_control", { type: "observe" }),
    /TOOL_DISABLED/,
  );
  await assert.rejects(
    params.callTool("desktop_room_decide", { action: "say", text: "不公开" }),
    /DESKTOP_DECISION_INVALID/,
  );
  const work = params.callTool("desktop_screen_view", {});
  const capture = await until(() => f.sync().screenRequest);
  assert.equal(capture.windowTaskId, request.windowTask.id);
  assert.equal(capture.grantId, request.windowTask.grantId);
  f.host.screen.receive({
    client: f.client,
    roomEpoch: capture.roomEpoch,
    grantId: capture.grantId,
    requestId: capture.requestId,
    data: frame,
  });
  const output = await work;
  assert(output.content.some(({ type }) => type === "image"));
  await assert.rejects(
    params.callTool("desktop_screen_view", {}),
    /DESKTOP_SCREEN_UNAVAILABLE/,
  );
  await params.callTool("desktop_room_decide", { action: "silent" });
  f.run.resolve();
  await until(() => f.stage() === "completed");
  assert.deepEqual(memory.state("@desktop").session, ordinarySession);
  assert.equal(
    memory.state(DESKTOP_WINDOW_TASK_CONVERSATION).session ?? null,
    null,
  );
  assert.equal(f.host.live.visits.get(agentId).cursor, cursor);
  assert(!JSON.stringify(f.host.archive.history()).includes(f.input.text));
});

test("a failed or revoked arrival does not start a model or release a native action", async (t) => {
  const f = setup(t, "native");
  f.start();
  const first = await f.getArrival();
  f.command("window-task-stop", randomUUID());
  assert.equal(f.stage(), "approaching");
  f.arrive(first.identity, { status: "failed", reason: "target-unreachable" });
  await until(() => f.stage() === "failed");
  assert.equal(f.sync().nativeRequest, undefined);
  f.start();
  const second = await f.getArrival();
  f.command("native-revoke", {
    roomEpoch: f.input.roomEpoch,
    grantId: f.input.grantId,
  });
  assert.equal(f.stage(), "failed");
  assert.throws(
    () =>
      f.arrive(second.identity, {
        status: "completed",
        arrivalConfirmed: true,
      }),
    /DESKTOP_BODY_UNAVAILABLE/,
  );
  assert.equal(f.sync().nativeRequest, undefined);
});

test("a claimed native operation is tried once and an unverified delivery is shown as failed", async (t) => {
  const f = setup(t, "native");
  f.start();
  const { request, identity } = await f.getArrival();
  f.arrive(identity, { status: "completed", arrivalConfirmed: true });
  const params = await f.model.promise;
  const operation = params.callTool("desktop_native_control", {
    type: "click",
    ref: "fixture",
  });
  const native = await until(() => f.sync().nativeRequest);
  assert.equal(native.windowTaskId, request.windowTask.id);
  const work = {
    client: f.client,
    roomEpoch: native.roomEpoch,
    grantId: native.grantId,
    requestId: native.requestId,
  };
  f.host.native.claim(work);
  assert.throws(() => f.host.native.claim(work), /DESKTOP_NATIVE_UNAVAILABLE/);
  f.host.native.receive({
    ...work,
    result: { ok: true, delivery: "delivered_unverified" },
  });
  assert.equal((await operation).delivery, "delivered_unverified");
  await assert.rejects(
    params.callTool("desktop_native_control", {
      type: "click",
      ref: "fixture",
    }),
    /DESKTOP_NATIVE_UNAVAILABLE/,
  );
  await params.callTool("desktop_room_decide", { action: "silent" });
  f.run.resolve();
  await until(() => f.stage() === "failed");
  assert.equal(f.sync().room.windowTaskStatus.reason, "action-unconfirmed");
});

test("desktop client confirms a private arrival without querying or reporting coordinates", async () => {
  const receipts = [];
  const client = new DesktopBodyClient({
    claim: async () => ({ accepted: true }),
    result: async (body) => {
      receipts.push(body);
    },
    execute: (_request, _current, finish) =>
      finish({ status: "completed", arrivalConfirmed: true }),
    position: () => assert.fail("private position must not be read"),
  });
  const roomEpoch = randomUUID();
  client.update(
    {
      room: { roomEpoch },
      bodyProtocol: 2,
      bodyRequests: [
        {
          roomEpoch,
          commandId: randomUUID(),
          visitId: randomUUID(),
          agentId,
          expiresAt: Date.now() + 2000,
          windowTask: {
            id: randomUUID(),
            scope: "screen",
            grantId: randomUUID(),
          },
        },
      ],
    },
    "sync",
  );
  await setImmediate();
  assert.deepEqual(
    receipts.map(({ result }) => result),
    [{ status: "completed", arrivalConfirmed: true }],
  );
  assert.deepEqual(
    client.recovery().map(({ result }) => result),
    [{ status: "completed", arrivalConfirmed: true }],
  );
});
