import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { DesktopActivity } from "../src/home/desktop-activity.mjs";
import { DESKTOP_ACTIVITY_CONVERSATION } from "../src/home/desktop-decision.mjs";
import { config, fixture } from "./helpers.mjs";

const minute = 60_000;
const tick = () => new Promise(setImmediate);

test("activity uses fair round-robin, per-role hourly limits and visit-local wait", () => {
  const starts = new Map();
  const activity = new DesktopActivity(starts);
  const roles = [{ id: "first" }, { id: "second" }];
  const visits = new Map(roles.map(({ id }) => [id, {}]));
  for (const visit of visits.values()) activity.arrive(visit, 0);
  const next = (now) => activity.next(roles, visits, now, () => true);
  assert.equal(next(2 * minute - 1), undefined);
  const first = next(2 * minute);
  assert.equal(first.actor, "first");
  assert.equal(first.reason, "arrival");
  assert.equal(next(2 * minute).actor, "second");
  activity.finish(visits.get("first"), {
    reply: { action: "wait", waitMinutes: 10 },
    lastResult: { status: "completed" },
    now: 2 * minute,
  });
  for (const at of [4, 6, 8]) assert.equal(next(at * minute).actor, "second");
  assert.equal(next(10 * minute), undefined);
  const returning = next(12 * minute);
  assert.equal(returning.actor, "first");
  assert.equal(returning.reason, "wait-ended");
  assert.deepEqual(returning.lastResult, { status: "completed" });
  const reopened = new DesktopActivity(starts);
  reopened.arrive(visits.get("second"), 12 * minute);
  assert.equal(
    reopened.next([roles[1]], visits, 14 * minute, () => true),
    undefined,
  );
  assert.equal(
    reopened.next([roles[1]], visits, 62 * minute, () => true).actor,
    "second",
  );
});

function setup(t, enabled = true) {
  const cfg = config(1);
  cfg.desktopHome.enabled = true;
  cfg.desktopHome.bodyControlRoles = ["agent-0"];
  if (enabled) cfg.desktopHome.activityRoles = ["agent-0"];
  const gates = [];
  let host;
  t.after(() => {
    host?.reset();
    for (const gate of gates) gate.resolve();
  });
  const { runtime, store } = fixture(t, { cfg });
  const client = randomUUID();
  host = runtime.desktopVisits;
  let now = runtime.now();
  runtime.now = () => now;
  const cmd = (action, data) => host.command({ client, action, data });
  const sync = (visible = true) => cmd("sync", visible);
  sync();
  const role = host.live.room.roles[0];
  host.live.room.members[role.id] = "invited";
  host.live.admit(role);
  const runs = [];
  const backend = runtime.backendConnections.adapter(runtime.agent(role.id));
  backend.runDesktop = async (params) => {
    params.beforeInput();
    params.onInputSubmitted();
    const scope = params.managedContext.conversation;
    const gate = Promise.withResolvers();
    gates.push(gate);
    runs.push({ params, scope, gate });
    const choice = await gate.promise;
    if (params.signal.aborted) return;
    const tool =
      scope === DESKTOP_ACTIVITY_CONVERSATION
        ? "desktop_activity_decide"
        : "desktop_room_decide";
    await params.callTool(tool, choice ?? { action: "silent" });
  };
  return {
    runtime,
    store,
    host,
    role,
    client,
    cmd,
    sync,
    runs,
    time(ms) {
      const visible = host.client.activityVisibleUntil > now;
      // Keep the room alive without skipping the independent visibility lease.
      now += ms;
      host.client.expiresAt = now + 15_000;
      if (visible) host.client.activityVisibleUntil = now + 2500;
    },
  };
}

test("idle activity has an independent tool catalog, budget and native session", async (t) => {
  const { host, client, sync, runs, store, time } = setup(t);
  const memory = store.bind("agent-0");
  const roleCursor = host.live.visits.get("agent-0").cursor;
  const budget = host.live.room.budget;
  time(2 * minute);
  const snapshot = sync();
  assert.equal(snapshot.room.thinking, null);
  assert.equal(snapshot.room.activityActor, "agent-0");
  const { params, gate, scope } = runs[0];
  assert.equal(scope, DESKTOP_ACTIVITY_CONVERSATION);
  assert.deepEqual(
    params.tools.map(({ function: tool }) => tool.name),
    ["desktop_activity_decide", "desktop_body_control"],
  );
  await assert.rejects(
    params.callTool("desktop_screen_view", {}),
    /TOOL_DISABLED/,
  );
  await assert.rejects(
    params.callTool("desktop_room_decide", { action: "say", text: "不应发言" }),
    /TOOL_DISABLED/,
  );
  await assert.rejects(
    params.callTool("desktop_activity_decide", { action: "say" }),
  );
  const move = params.callTool("desktop_body_control", {
    type: "move",
    target: "door",
    requestId: "move",
  });
  const [{ roomEpoch, commandId }] = sync().bodyRequests;
  const identity = { client, roomEpoch, commandId };
  host.body.claim(identity);
  host.body.receive({
    ...identity,
    result: { status: "completed", position: { x: 20, y: 30, displayId: 1 } },
  });
  assert.equal((await move).status, "completed");
  await assert.rejects(
    params.callTool("desktop_body_control", {
      type: "pose",
      facing: "left",
      requestId: "pose",
    }),
    /DESKTOP_BODY_LIMIT/,
  );
  gate.resolve({ action: "wait", waitMinutes: 5 });
  await host.live.active.done;
  assert.equal(host.live.room.budget, budget);
  assert.equal(host.live.visits.get("agent-0").cursor, roleCursor);
  assert.equal(memory.state("@desktop").lastTurnId, undefined);
  time(5 * minute - 1);
  sync();
  assert.equal(runs.length, 1);
  time(1);
  sync();
  assert.equal(runs.length, 2);
  assert.match(runs[1].params.prompt, /wait-ended/);
  assert.match(runs[1].params.prompt, /lastBodyResult/);
});

test("default, visibility, pause and role opt-in gate admissions", async (t) => {
  const { runtime, cmd, sync, time, runs } = setup(t, false);
  time(2 * minute);
  sync();
  assert.equal(runs.length, 0);
  runtime.config.desktopHome.activityRoles = ["agent-0"];
  sync(false);
  assert.equal(runs.length, 0);
  cmd("activity-pause", true);
  assert.equal(sync().room.activityPaused, true);
  assert.equal(runs.length, 0);
  cmd("activity-pause", false);
  assert.equal(sync().room.activityPaused, false);
  assert.equal(runs.length, 1);
});

for (const stop of [
  "pause",
  "hidden",
  "disconnect",
  "qq",
  "revoke",
  "chat",
  "conversation",
  "body-permission",
]) {
  test(`activity cancels for ${stop} and refuses a late client claim`, async (t) => {
    const { runtime, store, host, client, cmd, sync, time, runs } = setup(t);
    time(2 * minute);
    sync();
    const run = runs[0];
    const move = run.params
      .callTool("desktop_body_control", {
        type: "move",
        target: "door",
        requestId: "move",
      })
      .catch((error) => error);
    const [{ roomEpoch, commandId }] = sync().bodyRequests;
    const active = host.live.active;
    switch (stop) {
      case "pause":
        cmd("activity-pause", true);
        break;
      case "hidden":
        sync(false);
        break;
      case "disconnect":
        cmd("disconnect");
        break;
      case "qq":
        host.interrupt("agent-0");
        break;
      case "revoke":
        runtime.config.desktopHome.activityRoles = [];
        sync();
        break;
      case "chat":
        cmd("send", "测试聊天");
        break;
      case "conversation":
        store.bind("agent-0").setState("@desktop", { paused: true });
        sync();
        break;
      case "body-permission":
        runtime.config.desktopHome.bodyControlRoles = [];
        sync();
        break;
    }
    if (stop !== "body-permission") assert(run.params.signal.aborted);
    assert.throws(
      () => host.body.claim({ client, roomEpoch, commandId }),
      /DESKTOP_BODY_UNAVAILABLE/,
    );
    await move;
    run.gate.resolve();
    await active.done;
    if (stop === "chat") {
      await tick();
      assert.equal(runs[1].scope, "@desktop");
      assert.equal(host.live.room.budget, host.live.room.maxTurns - 1);
    }
  });
}

test("manual drag merges into the next eligible wake after cooling down", async (t) => {
  const { cmd, host, sync, runs, time } = setup(t);
  time(2 * minute);
  const state = cmd("sync", { visible: true, dragged: ["agent-0", "agent-0"] });
  assert.equal(state.room.activityActor, null);
  assert.equal(runs.length, 0);
  time(2 * minute);
  sync();
  assert.match(runs[0].params.prompt, /manual-drag/);
  const active = host.live.active;
  cmd("sync", { visible: true, dragged: ["agent-0"] });
  assert.equal(runs[0].params.signal.aborted, true);
  runs[0].gate.resolve();
  await active.done;
});
