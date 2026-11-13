import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
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
  const sync = (visible = true) => command("sync", visible);
  const { room } = sync();
  for (const role of host.live.room.roles) {
    host.live.room.members[role.id] = "invited";
    host.live.admit(role);
  }
  const grantId = randomUUID();
  const grant = (id = "agent-0") =>
    command("observation-grant", {
      roomEpoch: room.roomEpoch,
      grantId,
      agentId: id,
    });
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
    revoke,
    sync,
    command,
    payload,
    backend,
    runs,
    time(ms) {
      now += ms;
      host.client.expiresAt = now + 15_000;
      host.client.activityVisibleUntil = now + 2500;
    },
  };
}

test("observation requires explicit opt-in and an eligible resident", (t) => {
  const { grant, sync, runtime } = setup(t, false);
  assert.deepEqual(sync().room.observation.eligible, []);
  assert.throws(() => grant(), /DESKTOP_SCREEN_UNAVAILABLE/);
  runtime.config.desktopHome.autonomousObservation = true;
  assert.throws(() => grant("agent-1"), /DESKTOP_SCREEN_UNAVAILABLE/);
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
