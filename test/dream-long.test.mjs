import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createServer } from "../src/server.mjs";
import { DreamScheduler } from "../src/dream/scheduler.mjs";
import { config, fixture } from "./helpers.mjs";

const role = "agent-0";
const minute = 60000;
const day = 1440;
const group = "group:20000";
const empty = {
  schemaVersion: 1,
  operations: [],
  awakeningSummary: "",
  noChangesReason: "没有需要调整的认知。",
};
const patch = (...operations) => ({
  schemaVersion: 1,
  operations,
  awakeningSummary: "",
  noChangesReason: null,
});
const story = {
  schemaVersion: 1,
  title: "纸月",
  narrative: "纸月从河面上升起。",
  reflection: "记住了温柔的灯影。",
  themes: [],
  inspirations: [],
};
function add(evidenceIds, index, scopeId = group) {
  return {
    op: "ADD",
    category: "preference",
    scopeId,
    subjectKey: `fixture:item-${index}`,
    content: `用户说他喜欢第 ${index} 份草稿。`,
    epistemicStatus: "reported",
    evidenceIds,
    confidence: 0.8,
    importance: 0.5,
    reason: "明确自述。",
  };
}
function setup(t, count = 1, configure = () => {}, onLong) {
  const cfg = config(count);
  for (const agent of cfg.agents) {
    agent.dream.enabled = true;
    agent.dream.cognitive.longCognitionThreshold = 1;
    agent.dream.cognitive.deepDaily = false;
    agent.behavior.proactive.timezone = "UTC";
  }
  configure(cfg);
  let now = Date.UTC(2026, 0, 1),
    sequence = 0,
    pending = empty;
  const f = fixture(t, {
    cfg,
    run: async (p) => {
      if (p.conversation.includes("dream-imaginative"))
        return p.callTool("dream_story_submit", story);
      if (p.prompt.includes("长梦（long）") && onLong) return onLong(p);
      return p.callTool("dream_cognition_submit", pending);
    },
  });
  f.runtime.clock = () => new Date(now);
  f.runtime.dreamScheduler = new DreamScheduler(f.runtime);
  const append = (agentId = role, conversation = group) =>
    f.store.bind(agentId).append({
      dedupe: "long-run-fixture-" + ++sequence,
      conversation,
      kind: "message.received",
      body: "合成场景有一条已观察来信。",
      senderId: "30000",
      payload: { trustedInput: true },
    });
  const seed = async (operations, agentId = role) => {
    pending = patch(...operations);
    assert.equal((await f.runtime.dreams.run(agentId)).status, "COMMITTED");
    pending = empty;
  };
  const settle = async () => {
    while (f.runtime.work.size) await Promise.allSettled([...f.runtime.work]);
  };
  const tick = async (minutes) => {
    now += minutes * minute;
    await f.runtime.dreamScheduler.tick();
    await settle();
  };
  const read = (table) =>
    f.store.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all();
  return { ...f, append, seed, settle, tick, read };
}

test("threshold is strictly exceeded and a successful unchanged long scan will not repeat without a new cognition version", async (t) => {
  const f = setup(t, 1, (cfg) => {
    cfg.agents[0].dream.cognitive.longWeekly = false;
  });
  await f.seed([add([f.append().id], 1)]);
  await f.tick(16);
  assert.equal(
    f.read("dream_runs").some(({ mode }) => mode === "long"),
    false,
  );
  await f.seed([add([f.append().id], 2)]);
  await f.tick(1);
  const longs = () =>
    f.read("dream_runs").filter(({ mode }) => mode === "long");
  assert.deepEqual(
    longs().map(({ trigger, status }) => [trigger, status]),
    [["threshold", "COMMITTED"]],
  );
  await f.tick(1);
  await f.tick(1);
  assert.equal(longs().length, 1);
  await f.seed([add([f.append().id], 3)]);
  await f.tick(1);
  assert.equal(longs().length, 2);
  await f.tick(1);
  assert.equal(longs().length, 2);
});

test("the periodic path waits a rolling week and honors longWeekly without weakening the separate threshold", async (t) => {
  for (const weekly of [true, false])
    await t.test(String(weekly), async (t) => {
      const f = setup(t, 1, (cfg) => {
        cfg.agents[0].dream.cognitive.longWeekly = weekly;
        cfg.agents[0].dream.cognitive.longCognitionThreshold = 20;
      });
      await f.seed([add([f.append().id], 1)]);
      await f.tick(7 * day - 1);
      const longs = () =>
        f.read("dream_runs").filter(({ mode }) => mode === "long");
      assert.equal(longs().length, 0);
      await f.tick(1);
      assert.equal(longs().length, weekly ? 1 : 0);
      if (weekly) assert.equal(longs()[0].trigger, "idle");
      await f.tick(day);
      assert.equal(longs().length, weekly ? 1 : 0);
      await f.tick(6 * day);
      assert.equal(longs().length, weekly ? 2 : 0);
    });
});

test("long scan retries on the shared scheduler without moving checkpoints on failure", async (t) => {
  let attempts = 0;
  const f = setup(
    t,
    1,
    (cfg) => {
      cfg.agents[0].dream.cognitive.longWeekly = false;
    },
    async (p) => {
      if (++attempts === 1) throw Error("ABORTED");
      return p.callTool("dream_cognition_submit", empty);
    },
  );
  await f.seed([add([f.append().id], 1), add([f.append().id], 2)]);
  const before = f.read("dream_checkpoints");
  const addition = f.append();
  await f.tick(16);
  assert.equal(attempts, 1);
  assert.deepEqual(f.read("dream_checkpoints"), before);
  await f.tick(1);
  assert.equal(attempts, 2);
  assert.equal(
    f.read("dream_checkpoints").find((row) => row.source_partition === "events")
      .last_event_seq,
    addition.seq,
  );
});

test("a manual API long dream performs MERGE and ARCHIVE, retains private provenance and advances only its frozen batch", async (t) => {
  let destination, merged, expired, newEvidence, late;
  const f = setup(
    t,
    1,
    (cfg) => {
      cfg.agents[0].dream.cognitive.maxEventsPerBatch = 4;
    },
    async (p) => {
      assert.match(p.prompt, /长梦（long）.*MERGE.*ARCHIVE/);
      assert.ok(p.prompt.includes(newEvidence.id));
      late = f.append();
      assert.ok(!p.prompt.includes(late.id));
      const list = await p.callTool("dream_cognition_list", {});
      assert.ok(list.items.some((item) => item.id === expired.id));
      const merge = {
        op: "MERGE",
        targetId: destination.id,
        sourceIds: [merged.id],
        expectedVersion: 1,
        content: "当前有效的稳定偏好。",
        evidenceIds: [newEvidence.id],
        reason: "内容重复，查过已有证据。",
      };
      const archive = {
        op: "ARCHIVE",
        targetId: expired.id,
        expectedVersion: 1,
        reason: "新资料已确认不再适用。",
      };
      await assert.rejects(
        p.callTool(
          "dream_cognition_submit",
          patch(merge, { ...archive, expectedVersion: 2 }),
        ),
        /DREAM_VERSION_CONFLICT/,
      );
      await p.callTool("dream_cognition_submit", patch(merge, archive));
    },
  );
  const publicSource = f.append(),
    privateSource = f.append(role, "private:30000");
  await f.seed([
    add([publicSource.id], 1),
    add([privateSource.id], 2, "global"),
    add([publicSource.id], 3),
  ]);
  [destination, merged, expired] = f.read("cognitions");
  newEvidence = f.append();
  const token = randomBytes(32).toString("hex");
  const server = createServer({ runtime: f.runtime, token });
  const port = await server.listen();
  t.after(() => server.close());
  const response = await fetch(`http://127.0.0.1:${port}/api/dreams/trigger`, {
    method: "POST",
    headers: { "x-admin-token": token, "content-type": "application/json" },
    body: JSON.stringify({ agentId: role, mode: "long" }),
  });
  assert.equal(response.status, 202);
  const receipt = await response.json();
  await f.settle();
  const run = f
    .read("dream_runs")
    .find(({ run_id }) => run_id === receipt.runId);
  assert.deepEqual(
    [run.mode, run.trigger, run.status, run.changes_count],
    ["long", "manual", "COMMITTED", 3],
  );
  const rows = new Map(f.read("cognitions").map((row) => [row.id, row]));
  assert.equal(rows.get(destination.id).from_private, 1);
  assert.deepEqual(JSON.parse(rows.get(destination.id).source_scopes_json), [
    group,
    "private:30000",
  ]);
  assert.equal(rows.get(merged.id).status, "archived");
  assert.equal(rows.get(merged.id).merged_into, destination.id);
  assert.equal(rows.get(expired.id).status, "archived");
  assert.equal(
    f
      .read("dream_checkpoints")
      .find(({ source_partition }) => source_partition === "events")
      .last_event_seq,
    newEvidence.seq,
  );
  assert.ok(late.seq > run.cursor_end);
});

test("cross-role background priority reserves slots for deep sleep, then long dream, then imagination", async (t) => {
  const f = setup(t, 3, (cfg) => {
    for (const agent of cfg.agents) agent.dream.budget.maxGlobalConcurrency = 1;
    cfg.agents[1].dream.cognitive.deepDaily = true;
    cfg.agents[2].dream.cognitive.enabled = false;
    cfg.agents[2].dream.imaginative.enabled = true;
  });
  await f.seed([add([f.append().id], 1), add([f.append().id], 2)]);
  f.append("agent-1");
  await f.tick(15);
  await f.tick(1);
  await f.tick(1);
  assert.deepEqual(
    f
      .read("dream_runs")
      .slice(1)
      .map(({ agent_id, mode, status }) => [agent_id, mode, status]),
    [
      ["agent-1", "deep", "COMMITTED"],
      ["agent-0", "long", "COMMITTED"],
      ["agent-2", "imaginative", "COMMITTED"],
    ],
  );
});

test("a long merge or archive loses authority when a supporting source is restricted after submission", async (t) => {
  for (const op of ["MERGE", "ARCHIVE"])
    await t.test(op, async (t) => {
      let target, other, incoming;
      const f = setup(t, 1, undefined, async (p) => {
        const proposal = {
          op,
          targetId: target.id,
          expectedVersion: 1,
          reason: "旧认知已整理。",
        };
        if (op === "MERGE")
          Object.assign(proposal, {
            content: "更新后的偏好。",
            sourceIds: [other.id],
            evidenceIds: [incoming.id],
          });
        await p.callTool("dream_cognition_submit", patch(proposal));
        f.store.db
          .prepare("UPDATE events SET payload=? WHERE id=?")
          .run(
            JSON.stringify({ protectedOperations: true }),
            incoming.previousSourceId,
          );
      });
      const selected = f.append(),
        predecessor = f.append();
      await f.seed([add([selected.id], 1), add([predecessor.id], 2)]);
      [target, other] = f.read("cognitions");
      incoming = {
        ...f.append(),
        previousSourceId: op === "ARCHIVE" ? selected.id : predecessor.id,
      };
      const prior = f.read("dream_checkpoints");
      const failed = await f.runtime.dreams.run(role, { mode: "long" });
      assert.equal(failed.errorCode, "RECALL_SOURCE_NOT_ALLOWED");
      assert.deepEqual(
        f.read("cognitions").map(({ status, version }) => [status, version]),
        [
          ["active", 1],
          ["active", 1],
        ],
      );
      assert.deepEqual(f.read("dream_checkpoints"), prior);
    });
});
