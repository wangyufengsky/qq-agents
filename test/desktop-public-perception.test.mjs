import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setImmediate } from "node:timers/promises";
import test from "node:test";
import { DESKTOP_ACTIVITY_CONVERSATION } from "../src/home/desktop-decision.mjs";
import { desktopHomePolicy } from "../src/home/desktop-home-policy.mjs";
import { DesktopPublicActivity } from "../src/home/desktop-public-activity.mjs";
import { config, fixture } from "./helpers.mjs";

const minute = 60_000;
const ids = ["agent-0", "agent-1", "agent-2"];

function setup(t, overrides = {}) {
  const cfg = config(3);
  Object.assign(cfg.desktopHome, {
    enabled: true,
    bodyControlRoles: ids,
    activityRoles: ids,
    publicPerception: {
      ...cfg.desktopHome.publicPerception,
      enabled: true,
      firstMin: 5,
      firstMax: 5,
      idleMin: 15,
      idleMax: 15,
      resumeMin: 3,
      resumeMax: 3,
      ...overrides,
    },
  });
  let host;
  const runs = [];
  t.after(() => {
    host?.reset();
    for (const { gate } of runs) gate.resolve();
  });
  const { runtime, store } = fixture(t, { cfg });
  host = runtime.desktopVisits;
  const client = randomUUID();
  let now = Date.now();
  runtime.now = () => now;
  const command = (action, data) => host.command({ client, action, data });
  const sync = ({ visible = true, dragged = [], residents = [] } = {}) =>
    command("sync", {
      visible,
      dragged,
      bodyProtocol: 2,
      bodyPublic: true,
      ...(host.live && {
        publicSpace: {
          roomEpoch: host.live.room.epoch,
          door: { x: 72, y: 60, displayId: 1 },
          residents: residents.map(([agentId, x, displayId = 1]) => ({
            agentId,
            x,
            y: 60,
            displayId,
            facing: "right",
            pose: "sit",
            halfWidth: 97,
            halfHeight: 78,
            visitId: host.body.visitId(host.live.visits.get(agentId)),
          })),
        },
      }),
    });
  sync();
  const join = (id) => {
    const role = host.live.room.roles.find((r) => r.id === id);
    host.live.room.members[id] = "invited";
    host.live.admit(role);
  };
  for (const actor of ids) {
    runtime.backendConnections.adapter(runtime.agent(actor)).runDesktop =
      async (params) => {
        const gate = Promise.withResolvers();
        runs.push({ actor, params, gate });
        params.beforeInput();
        params.onInputSubmitted();
        const decision = await gate.promise;
        if (decision && !params.signal.aborted)
          await params.callTool(
            params.managedContext.conversation === DESKTOP_ACTIVITY_CONVERSATION
              ? "desktop_activity_decide"
              : "desktop_room_decide",
            decision,
          );
      };
  }
  const advance = (ms) => {
    const visible = host.client.activityVisibleUntil > now;
    now += ms;
    host.client.expiresAt = now + 15_000;
    if (visible) host.client.activityVisibleUntil = now + 2_500;
  };
  const quietJoin = (id) => {
    join(id);
    for (const e of host.live.perception.events) e.opportunities.clear();
  };
  const finish = async (run, decision = { action: "silent" }) => {
    const job = host.live.activities.get(run.actor) ?? host.live.foreground;
    run.gate.resolve(decision);
    await job.done;
    await setImmediate();
  };
  return {
    host,
    runtime,
    store,
    client,
    command,
    runs,
    sync,
    join,
    quietJoin,
    advance,
    finish,
  };
}

test("config has adjustable defaults and rejects reversed ranges or quotas", () => {
  const defaults = desktopHomePolicy.parse({}).publicPerception;
  assert.equal(defaults.enabled, false);
  assert.equal(defaults.idleLimit, 3);
  assert.equal(defaults.totalLimit, 4);
  assert(
    !desktopHomePolicy.safeParse({
      publicPerception: { idleLimit: 5, totalLimit: 4 },
    }).success,
  );
  assert(
    !desktopHomePolicy.safeParse({
      publicPerception: { firstMin: 8, firstMax: 2 },
    }).success,
  );
});

test("independent idle cadence respects both quotas and reserves an idle opportunity", () => {
  const p = desktopHomePolicy.parse({
    publicPerception: {
      enabled: true,
      firstMin: 5,
      firstMax: 5,
      idleMin: 15,
      idleMax: 15,
    },
  }).publicPerception;
  const clock = new DesktopPublicActivity(
    new Map(),
    () => p,
    () => undefined,
    (min) => min,
  );
  const visit = { activity: {} };
  clock.arrive(visit, 0);
  const event = [{ id: "a", kind: "greeting", until: Infinity, direct: true }];
  assert.equal(clock.take("fish", visit, 0, event).idle, false);
  assert.equal(clock.take("fish", visit, minute, event).idle, false);
  assert.equal(clock.take("fish", visit, 2 * minute, event).idle, false);
  assert.equal(clock.take("fish", visit, 3 * minute, event), undefined);
  const turn = clock.take("fish", visit, 5 * minute, event);
  assert.equal(turn.idle, true);
  clock.finish("fish", visit, turn, 5 * minute);
  assert.equal(clock.dueAt(visit), 20 * minute);
  assert.equal(clock.take("fish", visit, 20 * minute, []), undefined);
  const other = { activity: {} };
  clock.arrive(other, 0);
  for (let i = 0; i < 3; i++) {
    const now = (5 + 15 * i) * minute;
    const turn = clock.take("dragon", other, now, []);
    assert.equal(turn.idle, true);
    clock.finish("dragon", other, turn, now);
  }
  assert.equal(clock.take("dragon", other, 50 * minute, []), undefined);
  assert.equal(clock.take("dragon", other, 51 * minute, event).idle, false);
});

test("three simultaneous activity rounds execute separate body requests and cancel only the dragged role", async (t) => {
  const f = setup(t);
  for (const actor of ids) f.quietJoin(actor);
  f.advance(5 * minute);
  assert.deepEqual(f.sync().room.activityActors, ids);
  assert.equal(f.runs.length, 3);
  const moves = f.runs.map(({ params }) =>
    params.callTool("desktop_body_control", {
      type: "move",
      target: "door",
      requestId: randomUUID(),
    }),
  );
  const requests = f.sync().bodyRequests;
  assert.equal(requests.length, 3);
  const before = [...f.host.live.activities.values()];
  f.sync({ dragged: [ids[1]] });
  assert.equal(before[1].controller.signal.aborted, true);
  assert.equal(before[0].controller.signal.aborted, false);
  assert.equal(before[2].controller.signal.aborted, false);
  for (const request of requests.filter(({ agentId }) => agentId !== ids[1])) {
    const { roomEpoch, commandId, agentId, visitId } = request;
    const input = { client: f.client, roomEpoch, commandId, agentId, visitId };
    f.host.body.claim(input);
    f.host.body.receive({
      ...input,
      finishedAt: Date.now(),
      result: { status: "completed", position: { x: 72, y: 60, displayId: 1 } },
    });
  }
  const results = await Promise.allSettled(moves);
  assert.equal(results[0].value.status, "completed");
  assert.equal(results[2].value.status, "completed");
});

test("perception freezes ordinary audiences and named replies do not start a new greeting", async (t) => {
  const f = setup(t);
  for (const actor of ids) f.quietJoin(actor);
  const layout = [
    [ids[0], 75],
    [ids[1], 96, 2],
    [ids[2], 105],
  ];
  f.sync({ residents: layout });
  const { perception, visits } = f.host.live;
  perception.add("action", ids[0], {
    action: "sit",
    position: { x: -22, y: -18, displayId: 1 },
  });
  assert(
    perception
      .context(ids[2], visits.get(ids[2]))
      .recent.some(({ action }) => action === "sit"),
  );
  assert(
    !perception
      .context(ids[1], visits.get(ids[1]))
      .recent.some(({ action }) => action === "sit"),
  );
  const address = perception.add("greeting", ids[0], {
    target: ids[1],
    action: "wave",
    urgent: true,
  });
  f.sync({ residents: layout });
  const [{ actor, params }] = f.runs;
  assert.equal(actor, ids[1]);
  assert(params.prompt.includes(address.id));
  const reply = params.callTool("desktop_body_control", {
    type: "gesture",
    gesture: "wave",
    recipient: ids[0],
    replyTo: address.id,
    requestId: "reply",
  });
  const [request] = f.sync({ residents: layout }).bodyRequests;
  assert.equal(request.greeting.agentId, ids[0]);
  const { roomEpoch, commandId, agentId, visitId } = request;
  const input = { client: f.client, roomEpoch, commandId, agentId, visitId };
  f.host.body.claim(input);
  const result = {
    ...input,
    finishedAt: Date.now(),
    result: { status: "completed", position: { x: -1, y: -18, displayId: 2 } },
  };
  f.host.body.receive(result);
  assert.equal((await reply).status, "completed");
  assert.throws(() => f.host.body.receive(result), /DESKTOP_BODY_UNAVAILABLE/);
  assert.equal(
    perception.opportunities(ids[0], visits.get(ids[0]), f.runtime.now())
      .length,
    0,
  );
  assert.equal(
    perception.greeting(ids[1], visits.get(ids[1]), address.id),
    undefined,
  );
  assert.equal(
    perception.context(ids[0], visits.get(ids[0])).recent.at(-1).action,
    "wave",
  );
});

test("administrator can address a resting resident once while chat is public and rest stays in force", async (t) => {
  const f = setup(t);
  for (const actor of ids) f.quietJoin(actor);
  const a = f.host.live.visits.get(ids[0]);
  const until = f.runtime.now() + 20 * minute;
  a.publicActivity.rest = until;
  f.command("send", "@角色0 门边还有位置。");
  const run = f.runs[0];
  assert.equal(run.actor, ids[0]);
  assert(run.params.prompt.includes("继续原来那段休息"));
  assert.deepEqual(
    run.params.tools.map(({ function: tool }) => tool.name),
    ["desktop_room_decide"],
  );
  await assert.rejects(
    run.params.callTool("desktop_body_control", {
      type: "state",
      requestId: "read",
    }),
    /TOOL_DISABLED/,
  );
  await f.finish(run);
  assert.equal(a.publicActivity.rest, until);
  const other = f.runs.find(({ actor }) => actor === ids[1]);
  assert(other.params.prompt.includes("门边还有位置"));
  await f.finish(other);
  await f.finish(f.runs.find(({ actor }) => actor === ids[2]));
  assert.equal(f.runs.filter(({ actor }) => actor === ids[0]).length, 1);
  const cursor = a.cursor;
  assert.equal(
    f.host.archive.heard(ids[0], a.startCursor, 0, 10)[0].addressedToYou,
    true,
  );
  assert.equal(a.cursor, cursor);
});

test("arrival opportunities merge per visit and expired events remain recent", (t) => {
  const f = setup(t);
  f.quietJoin(ids[0]);
  f.join(ids[1]);
  f.sync();
  assert.equal(f.runs.length, 1);
  f.advance(2_000);
  f.join(ids[2]);
  const { perception, visits } = f.host.live;
  const chances = (id) =>
    perception.opportunities(id, visits.get(id), f.runtime.now());
  assert.equal(chances(ids[0]).length, 0);
  assert.equal(chances(ids[1]).length, 1);
  assert.equal(perception.context(ids[0], visits.get(ids[0])).recent.length, 2);
  f.advance(31_000);
  assert.equal(chances(ids[1]).length, 0);
  assert.equal(
    perception.context(ids[1], visits.get(ids[1])).recent.at(-1).kind,
    "arrival",
  );
});

test("quiet desktop offers independent idle turns over two hours without catch-up", () => {
  const p = desktopHomePolicy.parse({}).publicPerception;
  const clock = new DesktopPublicActivity(
    new Map(),
    () => p,
    () => undefined,
    (min) => min,
  );
  const visits = ids.map(() => ({ activity: {} }));
  const rounds = ids.map(() => []);
  visits.forEach((visit) => clock.arrive(visit, 0));
  for (let m = 1; m <= 120; m++) {
    const now = m * minute;
    for (const [i, visit] of visits.entries()) {
      if (i === 1 && m >= 18 && m <= 40) {
        clock.resume(visit, now);
        continue;
      }
      const turn = clock.take(ids[i], visit, now, []);
      if (!turn) continue;
      assert.equal(turn.reason, "idle");
      rounds[i].push(m);
      clock.finish(ids[i], visit, turn, now);
      assert(rounds[i].filter((start) => start > m - 60).length <= 3);
    }
  }
  assert.deepEqual(rounds[0], [5, 20, 35, 65, 80, 95]);
  assert.deepEqual(rounds[1], [5, 42, 57, 72, 102, 117]);
  assert.deepEqual(rounds[2], rounds[0]);
});

test("public chat lets an unaddressed activity finish before that resident catches up", async (t) => {
  const f = setup(t);
  for (const actor of ids) f.quietJoin(actor);
  const { live } = f.host;
  f.advance(5 * minute);
  f.sync();
  const running = [...live.activities.values()];
  const [, second, third] = f.runs;
  const visit = live.visits.get(ids[1]);
  const originalCursor = visit.cursor;
  f.command("send", "@角色0 一起来门边坐吧。");
  assert.equal(running[0].controller.signal.aborted, true);
  assert.equal(running[1].controller.signal.aborted, false);
  assert.equal(running[2].controller.signal.aborted, false);
  await f.finish(f.runs[0]);
  await f.finish(f.runs[3]);
  assert.equal(visit.cursor, originalCursor);
  await f.finish(third);
  assert.equal(f.runs[4].actor, ids[2]);
  assert(f.runs[4].params.prompt.includes("一起来门边坐吧"));
  assert.equal(visit.cursor, originalCursor);
  await f.finish(f.runs[4]);
  await f.finish(second);
  assert.equal(f.runs[5].actor, ids[1]);
  assert(f.runs[5].params.prompt.includes("一起来门边坐吧"));
  assert(visit.cursor > originalCursor);
  await f.finish(f.runs[5]);
});
