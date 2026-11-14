import assert from "node:assert/strict";
import test from "node:test";
import { randomBytes, randomUUID } from "node:crypto";
import { desktopToken } from "../src/home/desktop-auth.mjs";
import { createServer } from "../src/server.mjs";
import { config, fixture } from "./helpers.mjs";

const jpeg =
  "/9j/4AAQSkZJRgABAgAAAQABAAD//gAQTGF2YzYyLjI4LjEwMAD/2wBDAAgEBAQEBAUFBQUFBQYGBgYGBgYGBgYGBgYHBwcICAgHBwcGBgcHCAgICAkJCQgICAgJCQoKCgwMCwsODg4RERT/xABLAAEBAAAAAAAAAAAAAAAAAAAABQEBAAAAAAAAAAAAAAAAAAAABRABAAAAAAAAAAAAAAAAAAAAABEBAAAAAAAAAAAAAAAAAAAAAP/AABEIABAAEAMBIgACEQADEQD/2gAMAwEAAhEDEQA/AIAAok//2Q==";
const minute = 60_000;
const decision = "desktop_activity_decide";
const observation = "@desktop-observation";

function setup(t, enabled = true) {
  const cfg = config(2);
  cfg.desktopHome.enabled = true;
  cfg.desktopHome.autonomousObservation = enabled;
  cfg.desktopHome.activityRoles = ["agent-0"];
  cfg.desktopHome.bodyControlRoles = ["agent-0"];
  cfg.desktopHome.screenView.enabled = true;
  cfg.desktopHome.toolRoles = ["agent-0", "agent-1"];
  for (const agent of cfg.agents) agent.behavior.imageInput.enabled = true;
  const { runtime, store } = fixture(t, { cfg });
  const host = runtime.desktopVisits;
  const client = randomUUID();
  let now = runtime.now();
  runtime.now = () => now;
  const command = (action, data) => host.command({ client, action, data });
  const sync = (visible = true) =>
    command("sync", { visible, dragged: [], observationProtocol: 2 });
  const { room } = sync();
  for (const role of host.live.room.roles) {
    host.live.room.members[role.id] = "invited";
    host.live.admit(role);
  }
  const grantId = randomUUID();
  const target = (state) =>
    command("observation-state", { roomEpoch: room.roomEpoch, grantId, state });
  const grant = (id = "agent-0") => {
    command("observation-grant", {
      roomEpoch: room.roomEpoch,
      grantId,
      agentId: id,
    });
    return target("ready");
  };
  const revoke = () =>
    command("observation-revoke", { roomEpoch: room.roomEpoch, grantId });
  const payload = (request) => ({
    client,
    roomEpoch: request.roomEpoch,
    grantId: request.grantId,
    requestId: request.requestId,
  });
  const backend = runtime.backendConnections.adapter(runtime.agent("agent-0"));
  const runs = [];
  backend.runDesktop = async (params) => {
    params.beforeInput();
    params.onInputSubmitted();
    runs.push(params);
    await params.callTool(decision, { action: "silent" });
  };
  return {
    runtime,
    store,
    host,
    client,
    grant,
    target,
    review: (action, data) =>
      host.observation.review({ client, action, ...data }),
    revoke,
    sync,
    command,
    payload,
    backend,
    runs,
    time(ms, { verify = true } = {}) {
      now += ms;
      host.client.expiresAt = now + 15_000;
      host.client.activityVisibleUntil = now + 2500;
      if (verify && host.observation.grant) target("ready");
    },
  };
}

test("observation requires explicit opt-in and an eligible resident", (t) => {
  const { grant, sync, runtime } = setup(t, false);
  assert.deepEqual(sync().room.observation.eligible, []);
  assert.throws(() => grant(), /DESKTOP_SCREEN_UNAVAILABLE/);
  runtime.config.desktopHome.autonomousObservation = true;
  assert.throws(() => grant("agent-1"), /DESKTOP_SCREEN_UNAVAILABLE/);
  assert.deepEqual(sync().room.observation.ineligible, [
    { id: "agent-1", reason: "activity" },
  ]);
  assert.equal(grant().room.observation.grantedAgentId, "agent-0");
});

test("a single frame reaches a fresh observation context with only quiet decisions and own body tools", async (t) => {
  const { host, store, client, grant, sync, payload, backend, time } = setup(t);
  grant();
  const memory = store.bind("agent-0");
  const chatSession = { backend: "codex", id: "saved-chat" };
  memory.setState("@desktop", { session: chatSession, lastTurnId: "chat" });
  let sawFrame = false;
  backend.runDesktop = async (params) => {
    params.beforeInput();
    params.onInputSubmitted();
    assert.equal(params.managedContext.conversation, observation);
    assert.equal(params.managedContext.session, undefined);
    assert.equal(params.inputImages[0].data, jpeg);
    assert.deepEqual(
      params.tools.map(({ function: tool }) => tool.name),
      [decision, "desktop_body_control"],
    );
    params.managedContext.saveSession({
      backend: "codex",
      id: "observation-fixture",
    });
    sawFrame = true;
    await assert.rejects(
      params.callTool("desktop_screen_view", {}),
      /TOOL_DISABLED/,
    );
    await assert.rejects(params.callTool("memory_read", {}), /TOOL_DISABLED/);
    await assert.rejects(
      params.callTool("desktop_native_control", {}),
      /TOOL_DISABLED/,
    );
    await assert.rejects(
      params.callTool(decision, { action: "leave" }),
      /DESKTOP_DECISION_INVALID/,
    );
    const move = params.callTool("desktop_body_control", {
      type: "move",
      target: "door",
      requestId: "move",
    });
    const [{ roomEpoch, commandId }] = sync().bodyRequests;
    host.body.claim({ client, roomEpoch, commandId });
    host.body.receive({
      client,
      roomEpoch,
      commandId,
      result: { status: "completed", position: { x: 10, y: 20, displayId: 1 } },
    });
    assert.equal((await move).status, "completed");
    await params.callTool(decision, { action: "wait", waitMinutes: 4 });
  };
  time(2 * minute);
  const { screenRequest, room } = sync();
  assert.equal(screenRequest.mode, "observation");
  assert.equal(room.roles[0].activity, "observe");
  const active = host.live.active;
  assert.throws(
    () =>
      host.screen.receive({
        ...payload(screenRequest),
        client: randomUUID(),
        data: jpeg,
      }),
    /DESKTOP_SCREEN_UNAVAILABLE/,
  );
  host.screen.claim(payload(screenRequest));
  host.screen.receive({ ...payload(screenRequest), data: jpeg });
  await active.done;
  assert(sawFrame);
  assert.deepEqual(memory.state("@desktop").session, chatSession);
  assert.equal(memory.state(observation).session, null);
  assert.equal(host.live.visits.get("agent-0").activity.lastResult, undefined);
  assert(
    !host.live.room.messages.some(({ speakerType }) => speakerType === "agent"),
  );
  assert.equal(host.live.room.budget, host.live.room.maxTurns);
});

test("duplicate capture skips the model and unavailable target removes its authorization", async (t) => {
  const { host, grant, sync, payload, runs, time } = setup(t);
  grant();
  for (const status of ["duplicate", "unavailable"]) {
    time(2 * minute);
    const { screenRequest } = sync();
    const active = host.live.active;
    host.screen.claim(payload(screenRequest));
    host.screen.receive({ ...payload(screenRequest), status });
    await active.done;
  }
  assert.equal(runs.length, 0);
  assert.equal(sync().room.observation.grantedAgentId, null);
});

for (const cause of [
  "revoke",
  "pause",
  "expiry",
  "hidden",
  "qq",
  "leave",
  "policy",
  "disconnect",
]) {
  test(`observation rejects a delayed frame after ${cause}`, async (t) => {
    const { host, runtime, grant, revoke, sync, payload, command, runs, time } =
      setup(t);
    grant();
    time(2 * minute);
    const { screenRequest } = sync();
    assert(screenRequest);
    host.screen.claim(payload(screenRequest));
    const active = host.live.active;
    switch (cause) {
      case "revoke":
        revoke();
        break;
      case "pause":
        command("activity-pause", true);
        break;
      case "expiry":
        time(15 * minute);
        sync();
        break;
      case "hidden":
        sync(false);
        break;
      case "qq":
        host.interrupt("agent-0");
        break;
      case "leave":
        command("leave", "agent-0");
        break;
      case "policy":
        runtime.config.desktopHome.autonomousObservation = false;
        sync();
        break;
      case "disconnect":
        command("disconnect");
        break;
    }
    assert.throws(
      () => host.screen.receive({ ...payload(screenRequest), data: jpeg }),
      /DESKTOP_SCREEN_UNAVAILABLE/,
    );
    await active.done;
    assert.equal(runs.length, 0);
  });
}

test("revocation after frame capture fences backend submission", async (t) => {
  const { host, grant, sync, payload, backend, time, revoke } = setup(t);
  const entered = Promise.withResolvers();
  const resume = Promise.withResolvers();
  backend.runDesktop = async (params) => {
    entered.resolve(params);
    await resume.promise;
    params.beforeInput();
    assert.fail("Revoked pixels cannot be submitted");
  };
  grant();
  time(2 * minute);
  const { screenRequest } = sync();
  const active = host.live.active;
  host.screen.claim(payload(screenRequest));
  host.screen.receive({ ...payload(screenRequest), data: jpeg });
  const params = await entered.promise;
  revoke();
  assert(params.signal.aborted);
  resume.resolve();
  await active.done;
});

test("explicit role selection is required for on-request observation", async (t) => {
  const { host, runtime, grant, sync, payload, backend, time } = setup(t);
  runtime.config.desktopHome.observationRoles = [];
  assert.throws(() => grant(), /DESKTOP_SCREEN_UNAVAILABLE/);
  runtime.config.desktopHome.observationRoles = ["agent-0"];
  grant();
  const conversations = [];
  backend.runDesktop = async (params) => {
    params.beforeInput();
    params.onInputSubmitted();
    const { conversation } = params.managedContext;
    conversations.push(conversation);
    if (conversation === observation) {
      assert.equal(params.inputImages[0].data, jpeg);
      await params.callTool(decision, { action: "silent" });
    } else {
      assert.equal(params.inputImages, undefined);
      assert.equal(host.screen.request(), undefined);
      await assert.rejects(
        params.callTool(decision, { action: "silent", summary: "外部资料" }),
        /DESKTOP_DECISION_INVALID/,
      );
      await params.callTool(decision, { action: "observe" });
    }
  };
  time(2 * minute);
  sync();
  const active = host.live.active;
  await new Promise(setImmediate);
  const { screenRequest } = sync();
  host.screen.claim(payload(screenRequest));
  host.screen.receive({ ...payload(screenRequest), data: jpeg });
  await active.done;
  assert.deepEqual(conversations, ["@desktop-activity", observation]);
  assert.equal(host.activityStarts.get("agent-0").length, 1);
});

test("valid observation drafts stay private until each local review action", async (t) => {
  const { host, client, grant, sync, payload, backend, revoke, review, time } =
    setup(t);
  grant();
  const prompts = [];
  backend.runDesktop = async (params) => {
    params.beforeInput();
    params.onInputSubmitted();
    prompts.push(params.prompt);
    await params.callTool(decision, {
      action: "silent",
      response: "可以检查进度",
      summary: "观察到进度界面",
    });
  };
  const capture = async () => {
    time(2 * minute);
    const { screenRequest } = sync();
    const active = host.live.active;
    host.screen.claim(payload(screenRequest));
    host.screen.receive({ ...payload(screenRequest), data: jpeg });
    await active.done;
  };
  await capture();
  const { candidate } = review("status");
  assert.equal(candidate.summary, "观察到进度界面");
  assert.equal(candidate.agentId, "agent-0");
  assert(!JSON.stringify(sync()).includes("观察到进度界面"));
  assert.deepEqual(review("list").records, []);
  assert.throws(
    () =>
      host.observation.review({
        client: randomUUID(),
        action: "publish",
        id: candidate.id,
      }),
    /DESKTOP_SCREEN_UNAVAILABLE/,
  );
  assert.throws(
    () => review("publish", { id: randomUUID() }),
    /DESKTOP_OBSERVATION_REVIEW_UNAVAILABLE/,
  );
  const approved = review("publish", { id: candidate.id });
  assert.equal(approved.published.text, "可以检查进度");
  assert.equal(approved.candidate.response, undefined);
  assert.deepEqual(review("list").records, []);
  review("save", { id: candidate.id });
  const [saved] = review("list", { agentId: "agent-0" }).records;
  assert.equal(saved.summary, candidate.summary);
  assert.equal(saved.expiresAt - saved.createdAt, 7 * 24 * 60 * minute);
  assert.deepEqual(review("list", { agentId: "agent-1" }).records, []);
  await capture();
  assert.match(prompts[1], /观察到进度界面/);
  assert(!JSON.stringify(host.archive.history()).includes(candidate.summary));
  revoke();
  assert.equal(review("status").candidate, undefined);
  assert.equal(review("status").published, undefined);
  assert.throws(
    () =>
      host.observation.review({
        client,
        action: "save",
        id: candidate.id,
      }),
    /DESKTOP_OBSERVATION_REVIEW_UNAVAILABLE/,
  );
  assert.equal(review("list").records.length, 1);
  assert.equal(
    review("delete", { agentId: "agent-0", id: saved.id }).deleted,
    true,
  );
  assert.deepEqual(review("list").records, []);
});

test("minimization or a stale target lease cannot capture or expose an observation", async (t) => {
  const { host, grant, sync, payload, target, review, runs, time } = setup(t);
  grant();
  time(2 * minute);
  const first = sync().screenRequest;
  host.screen.claim(payload(first));
  const active = host.live.active;
  target("minimized");
  assert.equal(sync().room.observation.targetState, "minimized");
  assert.throws(
    () => host.screen.receive({ ...payload(first), data: jpeg }),
    /DESKTOP_SCREEN_UNAVAILABLE/,
  );
  await active.done;
  assert.equal(runs.length, 0);
  time(2 * minute, { verify: false });
  assert.equal(sync().screenRequest, undefined);
  await host.live.active?.done;
  target("ready");
  assert.equal(sync().room.observation.targetState, "ready");
  time(2 * minute, { verify: false });
  assert.equal(sync().screenRequest, undefined);
  assert.equal(sync().room.observation.targetState, "checking");
  assert.equal(review("status").candidate, undefined);
  target("permission");
  assert.equal(sync().room.observation.grantedAgentId, null);
});

test("observation review and backup use separate local credentials", async (t) => {
  const { runtime, client } = setup(t);
  const token = randomBytes(32).toString("hex");
  const desktopKey = desktopToken(token);
  const server = createServer({ runtime, token, allowLive: true });
  t.after(() => server.close());
  const base = `http://127.0.0.1:${await server.listen()}/api/desktop-home/`;
  const post = (route, body, headers) =>
    fetch(base + route, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
  const review = { client, action: "status" };
  const request = { agentId: "agent-0", action: "export" };
  assert.equal(
    (await post("observation-review", review, { "x-admin-token": token }))
      .status,
    401,
  );
  assert.equal(
    (
      await post("observation-review", review, {
        "x-desktop-home-token": desktopKey,
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await post("observation-summaries", request, {
        "x-desktop-home-token": desktopKey,
      })
    ).status,
    401,
  );
  assert.deepEqual(
    await (
      await post("observation-summaries", request, { "x-admin-token": token })
    ).json(),
    {
      version: 1,
      agentId: "agent-0",
      summaries: [],
    },
  );
});

test("submission waits for a fresh same-window receipt and rejects a minimized target", async (t) => {
  const { host, client, grant, sync, payload, backend, time } = setup(t);
  let submitted = 0;
  backend.runDesktop = async (params) => {
    params.beforeInput();
    await params.onRunStarted();
    params.onInputSubmitted();
    submitted++;
    await params.callTool(decision, { action: "silent" });
  };
  grant();
  for (const state of ["ready", "minimized"]) {
    time(2 * minute);
    const { screenRequest } = sync();
    const active = host.live.active;
    host.screen.claim(payload(screenRequest));
    host.screen.receive({ ...payload(screenRequest), data: jpeg });
    await new Promise(setImmediate);
    const { observationVerify } = sync();
    assert(observationVerify);
    assert.equal(submitted, state === "ready" ? 0 : 1);
    assert.throws(
      () =>
        host.observation.verifyResult({
          client,
          ...observationVerify,
          requestId: randomUUID(),
          state: "ready",
        }),
      /DESKTOP_SCREEN_UNAVAILABLE/,
    );
    assert.equal(
      host.observation.verifyResult({ client, ...observationVerify, state })
        .accepted,
      true,
    );
    await active.done;
    assert.throws(
      () =>
        host.observation.verifyResult({
          client,
          ...observationVerify,
          state: "ready",
        }),
      /DESKTOP_SCREEN_UNAVAILABLE/,
    );
    assert.equal(submitted, 1);
  }
  assert.equal(sync().room.observation.targetState, "minimized");
});

test("a discarded candidate's summary never reenters the observation prompt", async (t) => {
  const { host, grant, sync, payload, backend, review, time } = setup(t);
  grant();
  const prompts = [];
  backend.runDesktop = async (params) => {
    params.onInputSubmitted();
    prompts.push(params.prompt);
    await params.callTool(decision, {
      action: "silent",
      summary: "放弃的观察摘要",
    });
  };
  for (let i = 0; i < 2; i++) {
    time(2 * minute);
    const { screenRequest } = sync();
    const active = host.live.active;
    host.screen.claim(payload(screenRequest));
    host.screen.receive({ ...payload(screenRequest), data: jpeg });
    await active.done;
    const { candidate } = review("status");
    assert(candidate);
    review("discard", { id: candidate.id });
  }
  assert.equal(prompts.length, 2);
  assert(!prompts[1].includes("放弃的观察摘要"));
});

test("display grants offer optional observation, carry independent limits and reject revoked evidence", async (t) => {
  const f = setup(t);
  const { host, runtime, command, client, payload, time, backend } = f;
  const policy = runtime.config.desktopHome;
  policy.activityRoles = ["agent-0", "agent-1"];
  policy.displayObservation = { minutes: 9, attempts: 2 };
  const sync = (capability = true) =>
    command("sync", {
      visible: true,
      dragged: [],
      observationProtocol: 2,
      ...(capability && { displayObservation: true }),
    });
  const { roomEpoch } = sync(false).room;
  const add = (agentId, limits = policy.displayObservation) => {
    const grantId = randomUUID();
    command("observation-grant", {
      scope: "display",
      roomEpoch,
      agentId,
      grantId,
      limits,
    });
    command("observation-state", { roomEpoch, grantId, state: "ready" });
    return grantId;
  };
  assert.throws(() => add("agent-0"), /DESKTOP_SCREEN_UNAVAILABLE/);
  sync();
  assert.throws(
    () => add("agent-0", { minutes: 15, attempts: 4 }),
    /DESKTOP_SCREEN_UNAVAILABLE/,
  );
  const first = add("agent-0");
  const second = add("agent-1");
  assert.equal(host.observation.forActor("agent-0").direct, false);
  assert.equal(host.observation.forActor("agent-1").direct, false);
  assert.equal(
    host.observation.find(first).expiresAt - runtime.now(),
    9 * minute,
  );
  const tick = () => {
    time(2 * minute, { verify: false });
    for (const grantId of [first, second])
      command("observation-state", { roomEpoch, grantId, state: "ready" });
    return sync();
  };
  let choose = false;
  const offered = [];
  runtime.backendConnections.adapter(runtime.agent("agent-1")).runDesktop =
    backend.runDesktop = async (p) => {
      p.beforeInput();
      p.onInputSubmitted();
      offered.push(p.prompt);
      assert.equal(p.inputImages, undefined);
      await p.callTool(decision, { action: choose ? "observe" : "silent" });
    };
  tick();
  await host.live.active.done;
  await host.live.active?.done;
  assert(offered[0].includes('"observationTarget":"display"'));
  assert.equal(host.observation.state().displays[0].remaining, 2);
  await host.live.active?.done;
  choose = true;
  const requestStarted = Promise.withResolvers();
  const capture = host.screen.capture.bind(host.screen);
  host.screen.capture = (...args) => {
    const pending = capture(...args);
    requestStarted.resolve(host.screen.request());
    return pending;
  };
  tick();
  const screenRequest = await Promise.race([
    requestStarted.promise,
    host.live.active?.done,
  ]);
  assert(screenRequest);
  const captured = screenRequest.grantId;
  const retained = captured === first ? second : first;
  assert([first, second].includes(captured));
  host.screen.claim(payload(screenRequest));
  const active = host.live.active;
  command("observation-revoke", { roomEpoch, grantId: captured });
  assert.throws(
    () => host.screen.receive({ ...payload(screenRequest), data: jpeg }),
    /DESKTOP_SCREEN_UNAVAILABLE/,
  );
  await active.done;
  assert.equal(sync().room.observation.displays[0].grantId, retained);
  assert.equal(sync().room.observation.displays[0].remaining, 2);
  const retainedAgent = host.observation.find(retained).agentId;

  host.observation.finish(host.observation.find(retained), {
    summary: "示例摘要",
  });
  const { candidate } = host.observation.review({ client, action: "status" });
  assert.equal(candidate.grantId, retained);
  assert.throws(
    () =>
      host.observation.review({
        client,
        action: "save",
        id: candidate.id,
        grantId: second,
      }),
    /DESKTOP_OBSERVATION_REVIEW_UNAVAILABLE/,
  );
  host.observation.review({
    client,
    action: "save",
    id: candidate.id,
    grantId: retained,
  });
  assert.equal(
    host.observation.review({ client, action: "list", agentId: retainedAgent })
      .records[0].summary,
    "示例摘要",
  );
  const replacement = add(retainedAgent);
  assert.equal(host.observation.find(retained), undefined);
  assert.equal(host.observation.find(replacement).limit, 2);
  policy.displayObservation.minutes = 4;
  assert.equal(sync().room.observation.displays.length, 0);
});

test("new display access advances an empty idle slot while honoring rest, decline and expiry", async (t) => {
  const { host, runtime, command, backend, time } = setup(t);
  const policy = runtime.config.desktopHome;
  policy.publicPerception.enabled = true;
  policy.activityRoles = ["agent-0", "agent-1"];
  const sync = (extra = {}) =>
    command("sync", {
      visible: true,
      dragged: [],
      bodyProtocol: 2,
      bodyPublic: true,
      observationProtocol: 2,
      displayObservation: true,
      ...extra,
    });
  const { roomEpoch } = sync().room;
  const [fish, dragon] = [...host.live.visits.values()];
  const now = runtime.now();
  for (const visit of [fish, dragon]) {
    host.live.publicActivity.arrive(visit, now);
    visit.publicActivity.due = now + 25 * minute;
  }
  dragon.publicActivity.rest = now + 20 * minute;
  const make = (agentId) => ({
    roomEpoch,
    grantId: randomUUID(),
    agentId,
    visitId: host.body.visitId(host.live.visits.get(agentId)),
    scope: "display",
    limits: policy.displayObservation,
  });
  const batch = [make("agent-0"), make("agent-1")];
  assert.throws(
    () =>
      command("display-grant-batch", [
        batch[0],
        {
          ...batch[1],
          visitId: randomUUID(),
        },
      ]),
    /DESKTOP_SCREEN_UNAVAILABLE/,
  );
  assert.equal(host.observation.displays.size, 0);
  command("display-grant-batch", batch);
  for (const { grantId } of batch)
    command("observation-state", { roomEpoch, grantId, state: "ready" });
  const prompts = [];
  backend.runDesktop = async (params) => {
    params.beforeInput();
    params.onInputSubmitted();
    prompts.push(params.prompt);
    await params.callTool(decision, { action: "skip-observation" });
  };
  const waiting = host.observation.grantState(
    host.observation.displays.get("agent-1"),
  );
  assert.deepEqual(waiting.waiting, {
    reason: "rest",
    until: dragon.publicActivity.rest,
  });
  sync({
    ownerTouches: [
      { agentId: "agent-0", visitId: batch[0].visitId, kind: "pet" },
    ],
  });
  await host.live.activities.get("agent-0").done;
  assert.equal(prompts.length, 1);
  assert.match(prompts[0], /管理员刚摸了摸你的头/);
  assert.equal(
    host.observation.displays.get("agent-0").opportunity,
    "declined",
  );
  assert.equal(host.observation.displays.get("agent-0").attempts, 0);
  assert.equal(host.observation.forActor("agent-0"), undefined);
  assert.equal(host.live.activities.has("agent-1"), false);
  assert.deepEqual(host.live.publicActivity.starts.get("agent-0"), [
    { at: now, idle: true },
  ]);
  sync({
    dragged: ["agent-1"],
    ownerTouches: [
      { agentId: "agent-1", visitId: batch[1].visitId, kind: "drag" },
    ],
  });
  assert.deepEqual(host.live.ownerTouchInput(dragon).ownerTouches, ["drag"]);
  assert.deepEqual(host.live.ownerTouchInput(fish).ownerTouches, []);
  time((policy.displayObservation.minutes + 1) * minute, { verify: false });
  const { observation } = sync().room;
  assert.equal(observation.displays.length, 0);
  assert.throws(
    () => command("display-grant-batch", batch),
    /DESKTOP_SCREEN_UNAVAILABLE/,
  );
  assert.deepEqual(observation.displayHistory, [
    { agentId: "agent-0", state: "expired", opportunity: "declined" },
    { agentId: "agent-1", state: "expired", opportunity: "waiting" },
  ]);
});
