import { keepNeutralWeather } from "./garden-fixtures.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  acceptsSession,
  sessionSignature,
} from "../src/backends/session-contract.mjs";
import { HOUR } from "../src/home/garden-rules.mjs";
import { MediaStore } from "../src/tools/media.mjs";
import {
  config,
  context,
  fixture,
  raw,
  sendReviewed,
  settle,
} from "./helpers.mjs";

const agentId = "agent-0";
const subject = "@subject";
const owner = "private:30000";
const admin = { kind: "admin", id: "administrator" };

function setup(t, run = async () => {}, { opened = true } = {}) {
  const cfg = config(2);
  cfg.desktopHome.enabled = true;
  for (const agent of cfg.agents) {
    agent.ownerIds = ["30000", "30002"];
    agent.allow.users = ["30000", "30001", "30002"];
    Object.assign(agent.subject, {
      enabled: true,
      inboxEnabled: true,
      sessionMode: "continuous",
    });
  }
  const f = fixture(t, { cfg, run });
  let now = Date.UTC(2026, 0, 1, 12);
  f.runtime.clock = () => new Date(now);
  f.runtime.media = new MediaStore(path.join(f.root, "media"));
  const { runtime } = f;
  const memory = f.store.bind(agentId);
  const { garden } = runtime.home;
  keepNeutralWeather(garden);
  const role = runtime.agent(agentId);
  const generation = runtime.home.generation(agentId);
  const refresh = (updates) => {
    const state = garden.requireState();
    return garden.configure(now, state.settingsRevision, {
      ...state.settings,
      ...updates,
    });
  };
  const start = (updates = {}) => {
    garden.initialize(now);
    refresh({
      roles: { [agentId]: generation },
      startingWater: 10,
      delegationHours: 1,
      ...updates,
    });
    garden.desktopSync(now, 10 * HOUR);
  };
  if (opened) start();
  const act = (action) =>
    garden.act(now, admin, { requestId: randomUUID(), action });
  const plant = (plot) => act({ kind: "plant", plot, cropId: "clover" });
  const tick = async () => {
    runtime.subject.tick();
    await settle(runtime);
  };
  function latest(sender = "30000") {
    return memory.db
      .prepare(
        "SELECT id FROM events WHERE agent_id=? AND conversation=? AND kind='message.received' ORDER BY seq DESC LIMIT 1",
      )
      .get(agentId, "private:" + sender)?.id;
  }
  let messageId = 100;
  async function receive(sender = 30000, message_type = "private") {
    await runtime.ingest(
      "qq-0",
      raw(++messageId, {
        message_type,
        ...(message_type === "private" && { group_id: undefined }),
        user_id: sender,
        time: now / 1000,
        message: [
          { type: "text", data: { text: "请看看花园，帮我给地浇水。" } },
        ],
      }),
    );
    await settle(runtime);
    return latest(String(sender));
  }
  return {
    ...f,
    role,
    memory,
    garden,
    generation,
    start,
    plant,
    act,
    refresh,
    tick,
    receive,
    latest,
    advance: (ms) => (now += ms),
    wake: (scope = owner, id = agentId) => runtime.wake(id, scope),
    dispatch: () => runtime.subjectInbox.dispatch(role),
    ownerTool: (
      kind,
      args,
      requestId = randomUUID(),
      scope = owner,
      id = agentId,
    ) =>
      runtime.callTool(context(runtime, id, scope), "garden_act", {
        kind,
        requestId,
        args,
      }),
  };
}
const request = (call, eventId, args = {}, requestId = randomUUID()) =>
  call("garden_act", {
    kind: "delegate_water",
    requestId,
    args: { eventId, ...args },
  });
const step = (call, id, requestId = randomUUID()) =>
  call("garden_act", {
    kind: "delegate_step",
    requestId,
    args: { delegationId: id },
  });

test("admin QQ input binds one scoped request and origin receipt", async (t) => {
  let run, delegation, original;
  const f = setup(t, (p) => run?.(p));
  const requestId = randomUUID();
  run = async ({ callTool }) => {
    if (delegation) return;
    original = f.latest();
    delegation = await request(callTool, original, {}, requestId);
    assert.equal((await request(callTool, original)).id, delegation.id);
    await assert.rejects(
      request(callTool, original, { plot: 1 }, requestId),
      /GARDEN_REQUEST_CONFLICT/,
    );
  };
  await f.receive();
  if (!delegation) await f.wake();
  assert.equal(delegation.status, "queued");
  assert.deepEqual(delegation.targets, []);
  run = null;
  await f.receive();
  await assert.rejects(
    f.ownerTool("delegate_water", { eventId: f.latest() }),
    /GARDEN_DELEGATION_SOURCE_DENIED/,
  );
  await assert.rejects(
    f.ownerTool("delegate_water", { eventId: f.latest() }, requestId),
    /GARDEN_REQUEST_CONFLICT/,
  );
  await assert.rejects(
    f.ownerTool(
      "delegate_water",
      { eventId: original },
      randomUUID(),
      "private:30001",
    ),
    /GARDEN_DELEGATION_SOURCE_DENIED/,
  );
  await assert.rejects(
    f.ownerTool(
      "delegate_water",
      { eventId: original },
      randomUUID(),
      "group:20000",
    ),
    /TOOL_DISABLED/,
  );
  await assert.rejects(
    f.ownerTool(
      "delegate_water",
      { eventId: original },
      randomUUID(),
      owner,
      "agent-1",
    ),
    /GARDEN_DELEGATION_SOURCE_DENIED/,
  );
  const ref = { delegationId: delegation.id };
  await assert.rejects(
    f.ownerTool("delegate_status", ref, randomUUID(), "private:30002"),
    /GARDEN_DELEGATION_NOT_FOUND/,
  );
  await assert.rejects(
    f.ownerTool("delegate_cancel", ref, randomUUID(), owner, "agent-1"),
    /GARDEN_DELEGATION_NOT_FOUND/,
  );
  assert.equal(
    f.runtime.subjectInbox.feedbackItems(
      f.role,
      "private:30002",
      f.runtime.now(),
      true,
    ).length,
    0,
  );
  f.refresh({ roles: {} });
  assert.equal((await f.ownerTool("delegate_status", ref)).status, "dropped");
  assert.equal(f.dispatch(), false);
  f.refresh({ roles: { [agentId]: f.generation } });
  assert.equal((await f.ownerTool("delegate_status", ref)).status, "dropped");
});

test("existing inbox defers a garden wake while busy, asleep or paused and expiry uses only garden time", async (t) => {
  let delegation;
  const f = setup(t, async (p) => {
    if (p.conversation !== owner || delegation) return;
    delegation = await request(p.callTool, f.latest());
  });
  f.garden.desktopStop(f.runtime.now());
  await f.receive();
  if (!delegation) await f.wake();
  const ref = { delegationId: delegation.id };
  assert.equal(delegation.paused, true);
  assert.equal(f.dispatch(), false);
  f.advance(72 * HOUR);
  assert.equal((await f.ownerTool("delegate_status", ref)).status, "queued");
  f.garden.desktopSync(f.runtime.now(), 10 * HOUR);
  f.runtime.config.globalPaused = true;
  assert.equal(f.dispatch(), false);
  f.runtime.config.globalPaused = false;
  f.role.paused = true;
  assert.equal(f.dispatch(), false);
  f.role.paused = false;
  const busy = context(f.runtime, agentId, owner);
  const runningKey = agentId + "|" + owner;
  f.runtime.running.set(runningKey, busy);
  assert.equal(f.dispatch(), false);
  f.runtime.running.delete(runningKey);
  f.memory.setState("@subject-rest", {
    rest: { until: f.runtime.now() + 2 * HOUR },
  });
  assert.equal(f.dispatch(), false);
  f.advance(HOUR - 1);
  assert.equal((await f.ownerTool("delegate_status", ref)).status, "queued");
  f.advance(1);
  assert.equal((await f.ownerTool("delegate_status", ref)).status, "expired");
  f.memory.setState("@subject-rest", {});
  assert.equal(f.dispatch(), false);
});

test("existing wake runs the watering inbox, with ordered cross-turn scope, intervention and atomic cancellation", async (t) => {
  let delegation,
    first,
    runOwner = true,
    subjectCalls = 0,
    remaining;
  const stepId = randomUUID();
  const f = setup(t, async (p) => {
    const call = p.callTool;
    if (p.conversation === owner && runOwner && !delegation) {
      delegation = await request(call, f.latest());
      return;
    }
    if (p.conversation !== subject || !delegation) return;
    subjectCalls++;
    if (subjectCalls === 1) {
      assert.match(p.prompt, /subject-inbox/);
      const list = await call("subject_inbox_list", {});
      assert.ok(
        list.items.some((item) => item.id === "garden:" + delegation.id),
      );
      first = await step(call, delegation.id, stepId);
      const replay = await step(call, delegation.id, stepId);
      assert.deepEqual(replay.step, first.step);
      assert.equal(replay.duplicate, true);
      assert.equal(first.status, "partial");
    } else {
      remaining = await step(call, delegation.id);
    }
  });
  f.refresh({ turnLimit: 1, delegationHours: 24, startingWater: 21 });
  f.plant(6);
  f.refresh({ startingWater: 10 });
  f.plant(3);
  f.plant(2);
  f.advance(HOUR);
  f.plant(1);
  f.plant(4);
  await f.receive();
  if (!delegation) await f.wake();
  if (!subjectCalls) assert.equal(f.dispatch(), true);
  await settle(f.runtime);
  assert.equal(subjectCalls, 1);
  assert.equal(first.step.plot, 2);
  assert.deepEqual(
    first.targets.map(({ plot }) => plot),
    [2, 3, 1, 4],
  );
  assert.equal(f.dispatch(), false);
  const plot3 = f.garden.snapshot(f.runtime.now(), true).plots[2];
  f.act({ kind: "water", plot: 3, plantId: plot3.plant.id });
  f.plant(5);
  f.advance(2 * HOUR);
  await f.wake(subject);
  assert.equal(remaining.status, "partial");
  assert.equal(remaining.step.plot, 1);
  assert.equal(
    f.garden.snapshot(f.runtime.now(), true).plots[5].plant.water < 20,
    true,
  );
  assert.ok(!remaining.targets.some(({ plot }) => plot === 5 || plot === 6));
  assert.equal(
    remaining.targets.find((item) => item.plot === 3).reason,
    "already_watered",
  );
  const ref = { delegationId: delegation.id };
  const cancel = await f.ownerTool("delegate_cancel", ref);
  assert.deepEqual(
    cancel.targets.map(({ status }) => status),
    ["watered", "skipped", "watered", "cancelled"],
  );
  assert.equal(
    (await f.ownerTool("delegate_cancel", ref)).revision,
    cancel.revision,
  );
  await f.wake(subject);
  assert.equal(remaining.status, "cancelled");
  assert.equal(remaining.step, undefined);
  assert.equal(
    f.garden.snapshot(f.runtime.now(), true).plots[4].plant.water < 20,
    true,
  );
  assert.equal(
    f.garden
      .read(f.runtime.now())
      .activity.filter((entry) => entry.actor_kind === "agent").length,
    2,
  );
  assert.deepEqual(await f.ownerTool("delegate_status", ref), cancel);
});

test("targeted watering leaves a fully watered plant alone and still gives one actionable receipt", async (t) => {
  let delegation, result;
  const f = setup(t, async (p) => {
    if (p.conversation === owner && !delegation)
      delegation = await request(p.callTool, f.latest(), { plot: 7 });
    if (p.conversation === subject && delegation)
      result = await step(p.callTool, delegation.id);
  });
  f.refresh({ startingWater: 100 });
  f.plant(7);
  await f.receive();
  if (!delegation) await f.wake();
  await f.tick();
  assert.equal(result.status, "no_watering_needed");
  assert.deepEqual(result.targets, [
    { plot: 7, status: "skipped", reason: "already_watered" },
  ]);
});

test("opening may hand over once but private and subject backend sessions reuse across watering and hot settings", async (t) => {
  const f = setup(t, undefined, { opened: false });
  let nextId = 0,
    delegation,
    didShare = false,
    final;
  f.runtime.backendFactory = (c) => {
    const b = {
      config: c,
      sessionSignature: (tools) => sessionSignature(b, tools),
      acceptsSession: (s, tools) => acceptsSession(b, s, tools),
      close: async () => {},
      cancel: async () => {},
      run: async (p) => {
        await p.beforeInputSubmitted?.();
        p.appendPrompt?.();
        p.onInputSubmitted?.();
        p.saveSession(
          p.session || {
            id: "garden-test-session-" + ++nextId,
            backend: c.type,
            signature: sessionSignature(b, p.tools),
          },
        );
        p.onUsage({
          source: "measured",
          contextTokens: 500,
          capacityTokens: 1000000,
          basis: "isolated test",
        });
        if (!f.garden.initialized()) return;
        const call = p.callTool;
        if (p.conversation === owner && f.latest() && !delegation) {
          const view = await call("garden_read", { view: "public" });
          assert.equal(view.plots[0].lowWater, true);
          const image = await call("garden_read", { view: "image" });
          const share = image.content
            ? JSON.parse(image.content[0].text)
            : image;
          assert.equal(share.text, view.text);
          if (process.env.QQ_TEST_GARDEN_REAL_IMAGE === "1")
            assert.equal(share.imageAvailable, true);
          if (share.mediaId)
            assert.equal(
              f.runtime.media.metadata(agentId, share.mediaId).mimeType,
              "image/png",
            );
          assert.equal(
            (
              await sendReviewed((args) => call("qq_send", args), {
                requestId: "garden-state-share",
                text: share.text,
                ...(share.mediaId && { mediaId: share.mediaId }),
              })
            ).status,
            "sent",
          );
          didShare = true;
          delegation = await request(call, f.latest(), { plot: 1 });
        } else if (p.conversation === subject && delegation && !final) {
          final = await step(call, delegation.id);
        } else if (p.conversation === owner && final) {
          const view = await call("garden_read", {});
          const status = await call("garden_act", {
            kind: "delegate_status",
            requestId: randomUUID(),
            args: { delegationId: delegation.id },
          });
          assert.equal(status.status, "completed");
          assert.equal(view.plots[0].water, status.targets[0].water);
          assert.equal(
            (
              await sendReviewed((args) => call("qq_send", args), {
                requestId: "garden-watering-receipt",
                text: "1 号地已经浇水。",
              })
            ).status,
            "sent",
          );
        }
      },
    };
    return b;
  };
  await f.receive();
  if (!f.memory.state(owner).session) await f.wake(owner);
  await f.wake(subject);
  const ids = () => [
    f.memory.state(owner).session.id,
    f.memory.state(subject).session.id,
  ];
  const before = ids();
  f.start();
  f.plant(1);
  await f.receive();
  if (!delegation) await f.wake(owner);
  assert.ok(didShare && delegation);
  await f.tick();
  assert.equal(final.status, "completed");
  const after = ids();
  assert.notEqual(before[0], after[0]);
  assert.notEqual(before[1], after[1]);
  const retired = f.memory.identity.list("session_history").length;
  await f.receive();
  if (f.runtime.transports.get("qq-0").sent.length < 2) await f.wake(owner);
  const sent = f.runtime.transports.get("qq-0").sent;
  assert.equal(sent.length, 2);
  assert.ok(sent.every((entry) => entry.conversation === owner));
  if (process.env.QQ_TEST_GARDEN_REAL_IMAGE === "1")
    assert.deepEqual(
      sent[0].segments.map((segment) => segment.type),
      ["text", "image"],
    );
  for (const update of [
    { speed: 4, turnLimit: 0, roles: {} },
    { speed: 1, delegationHours: 24, roles: { [agentId]: f.generation } },
  ]) {
    f.refresh(update);
    await f.wake(owner);
    await f.wake(subject);
    assert.deepEqual(ids(), after);
    assert.equal(f.memory.identity.list("session_history").length, retired);
  }
});

for (const cancelFirst of [true, false]) {
  test(`concurrent cancellation and watering reflect the committed order (cancel first: ${cancelFirst})`, async (t) => {
    let delegation, outcome;
    const f = setup(t, async (p) => {
      if (p.conversation === owner && !delegation)
        delegation = await request(p.callTool, f.latest());
      if (p.conversation !== subject || !delegation || outcome) return;
      const cancel = () =>
        f.ownerTool("delegate_cancel", { delegationId: delegation.id });
      const water = () => step(p.callTool, delegation.id);
      const results = await Promise.all(
        cancelFirst ? [cancel(), water()] : [water(), cancel()],
      );
      outcome = results[cancelFirst ? 0 : 1];
    });
    f.plant(1);
    f.plant(2);
    await f.receive();
    if (!delegation) await f.wake();
    await f.tick();
    assert.equal(outcome.status, "cancelled");
    const words = outcome.targets.map(({ status }) => status);
    assert.deepEqual(words, cancelFirst ? [] : ["watered", "cancelled"]);
    const watered = f.garden
      .read(f.runtime.now())
      .activity.filter((entry) => entry.actor_kind === "agent");
    assert.equal(watered.length, cancelFirst ? 0 : 1);
  });
}
