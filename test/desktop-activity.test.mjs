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

test("role cadence adjusts a live visit and preserves an explicit wait and drag cooldown", () => {
  let interval = 10;
  const activity = new DesktopActivity(new Map(), () => interval);
  const visit = {};
  activity.arrive(visit, 0, "agent-0");
  assert.equal(activity.dueAt(visit), 10 * minute);
  interval = 1;
  assert.equal(activity.dueAt(visit), 2 * minute);
  activity.finish(visit, {
    reply: { action: "wait", waitMinutes: 5 },
    now: minute,
  });
  activity.defer(visit, 2 * minute);
  assert.equal(activity.dueAt(visit), 6 * minute);
  interval = 10;
  assert.equal(activity.dueAt(visit), 12 * minute);
});

function setup(t, enabled = true, count = 1) {
  const cfg = config(count);
  cfg.desktopHome.enabled = true;
  const ids = cfg.agents.map(({ id }) => id);
  cfg.desktopHome.bodyControlRoles = ids;
  cfg.desktopHome.interactionsEnabled = count > 1;
  if (enabled) cfg.desktopHome.activityRoles = ids;
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
  const sync = (visible = true) =>
    cmd(
      "sync",
      count === 1
        ? visible
        : { visible, dragged: [], bodyProtocol: 2, bodyInteractions: true },
    );
  sync();
  for (const role of host.live.room.roles) {
    host.live.room.members[role.id] = "invited";
    host.live.admit(role);
  }
  const role = host.live.room.roles[0];
  const runs = [];
  const runDesktop = async (params) => {
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
  for (const agent of cfg.agents)
    runtime.backendConnections.adapter(runtime.agent(agent.id)).runDesktop =
      runDesktop;
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

const promptInteraction = (run) =>
  JSON.parse(run.params.prompt.trim().split("\n").at(-1)).interaction;

function interactionFixture(t) {
  const state = setup(t, true, 3);
  const { host, runs, sync, time } = state;
  const next = (actor) => {
    const previous = runs.length;
    sync();
    assert.equal(runs.length, previous + 1);
    assert.equal(host.live.active.actor, actor);
    return runs.at(-1);
  };
  const finish = async (run, decision = { action: "silent" }) => {
    const { done } = host.live.active;
    run.gate.resolve(decision);
    await done;
  };
  const offer = async (kind) => {
    time(2 * minute);
    const proposer = next("agent-0");
    assert.deepEqual(
      promptInteraction(proposer).recipients.map(({ id }) => id),
      ["agent-1", "agent-2"],
    );
    await finish(proposer, {
      action: "silent",
      interaction: { action: "propose", kind, recipient: "agent-1" },
    });
    assert.equal(runs.length, 1);
    const recipient = next("agent-1");
    const { id } = promptInteraction(recipient).offer;
    return { recipient, id };
  };
  return { ...state, next, finish, offer };
}

test("interaction consent uses existing activity turns and authorizes each participant's own step", async (t) => {
  const { host, client, sync, time, next, finish, offer } =
    interactionFixture(t);
  const { recipient, id } = await offer("together");
  const act = (run, requestId) =>
    run.params.callTool("desktop_body_control", {
      type: "interaction",
      requestId,
      interactionId: id,
    });
  const receive = async (run, requestId, actor, peer, step) => {
    const action = act(run, requestId);
    const [request] = sync().bodyRequests;
    const { commandId, roomEpoch, agentId, visitId } = request;
    assert.equal(agentId, actor);
    assert.equal(visitId, host.body.visitId(host.live.visits.get(actor)));
    assert.deepEqual(request.interaction, {
      kind: "together",
      step,
      peerAgentId: peer,
      peerVisitId: host.body.visitId(host.live.visits.get(peer)),
    });
    const claim = { client, commandId, roomEpoch, agentId, visitId };
    assert.equal(host.body.claim(claim).accepted, true);
    host.body.receive({
      ...claim,
      finishedAt: Date.now(),
      result: { status: "completed", position: { x: 0, y: 0, displayId: 1 } },
    });
    assert.equal((await action).status, "completed");
  };
  await assert.rejects(act(recipient, "early"), /DESKTOP_BODY_UNAVAILABLE/);
  await assert.rejects(
    recipient.params.callTool("desktop_activity_decide", {
      action: "silent",
      interaction: { action: "accept", id: randomUUID() },
    }),
    /DESKTOP_DECISION_INVALID/,
  );
  await finish(recipient, {
    action: "silent",
    interaction: { action: "accept", id },
  });
  const bystander = next("agent-2");
  assert.equal(promptInteraction(bystander), undefined);
  await assert.rejects(
    act(bystander, "wrong-actor"),
    /DESKTOP_BODY_UNAVAILABLE/,
  );
  await finish(bystander);
  time(2 * minute);
  const proposer = next("agent-0");
  assert.equal(promptInteraction(proposer).step.action, "move");
  await receive(proposer, "near-recipient", "agent-0", "agent-1", "move");
  await finish(proposer);
  const accepted = next("agent-1");
  assert.equal(promptInteraction(accepted).step.action, "sit");
  await receive(accepted, "sit", "agent-1", "agent-0", "sit");
  await finish(accepted);
  assert.equal(host.live.interaction, undefined);
  assert.equal(host.live.room.budget, host.live.room.maxTurns);
  assert.equal(
    host.live.room.messages.some(({ speakerType }) => speakerType !== "system"),
    false,
  );
});

for (const interruption of ["peer-qq", "target-blocked"]) {
  test(`an accepted approach releases its first step after ${interruption}`, async (t) => {
    const { host, client, sync, time, next, finish, offer } =
      interactionFixture(t);
    const { recipient, id } = await offer("approach");
    await finish(recipient, {
      action: "silent",
      interaction: { action: "accept", id },
    });
    await finish(next("agent-2"));
    time(2 * minute);
    const proposer = next("agent-0");
    const pending = proposer.params.callTool("desktop_body_control", {
      type: "interaction",
      requestId: "approach",
      interactionId: id,
    });
    const [{ commandId, roomEpoch, agentId, visitId }] = sync().bodyRequests;
    const claim = { client, commandId, roomEpoch, agentId, visitId };
    host.body.claim(claim);
    const report = (result) =>
      host.body.receive({ ...claim, finishedAt: Date.now(), result });
    if (interruption === "peer-qq") {
      host.interrupt("agent-1");
      assert.throws(
        () =>
          report({
            status: "completed",
            position: { x: 0, y: 0, displayId: 1 },
          }),
        /DESKTOP_BODY_UNAVAILABLE/,
      );
      assert.deepEqual(sync().bodyRequests, []);
      assert.equal((await pending).status, "unknown");
    } else {
      report({ status: "failed", reason: "target-blocked" });
      assert.equal((await pending).reason, "target-blocked");
    }
    await finish(proposer);
    assert.equal(host.live.interaction, undefined);
  });
}

for (const invalidation of [
  "ignore",
  "revisit",
  "qq",
  "expire",
  "permission",
  "manual-drag",
  "hidden",
]) {
  test(`interaction invitation is discarded after ${invalidation}`, async (t) => {
    const { runtime, host, cmd, sync, time, finish, offer } =
      interactionFixture(t);
    const { recipient, id } = await offer("approach");
    if (invalidation === "ignore") {
      await finish(recipient, {
        action: "silent",
        interaction: { action: "ignore", id },
      });
    } else {
      if (invalidation === "revisit") {
        const proposer = host.live.room.roles[0];
        host.live.leave(proposer);
        host.live.room.members[proposer.id] = "invited";
        host.live.admit(proposer);
      }
      if (invalidation === "qq") host.interrupt("agent-0");
      if (invalidation === "expire") time(10 * minute);
      if (invalidation === "permission")
        runtime.config.desktopHome.bodyControlRoles = ["agent-1", "agent-2"];
      if (invalidation === "manual-drag")
        cmd("sync", { visible: true, dragged: ["agent-0"] });
      if (invalidation === "hidden") sync(false);
      sync(invalidation !== "hidden");
      await finish(recipient, {
        action: "silent",
        interaction: { action: "accept", id },
      });
    }
    assert.equal(host.live.interaction, undefined);
    assert.deepEqual(sync().bodyRequests, []);
  });
}
