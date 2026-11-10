import test from "node:test";
import assert from "node:assert/strict";
import { validateConfig } from "../src/core/config.mjs";
import { recallBoundary } from "../src/core/recall-boundary.mjs";
import { memoryRecallDiagnostic } from "../src/core/session-records.mjs";
import { config, fixture, raw } from "./helpers.mjs";

const group = "group:20000";

function pilotConfig() {
  const cfg = config(1);
  const role = cfg.agents[0];
  role.wake.participation = 0;
  role.ownerIds = ["30000"];
  role.tools.push("diagnostics_read", "memory_recall");
  role.functionalAgents = {
    qq: { kind: "qq-dialogue", delegatesTo: ["memory"] },
    memory: {
      kind: "memory",
      enabled: true,
      backendId: "recall-fixture",
      pilot: { groups: ["20000"] },
    },
  };
  cfg.backends.push({
    id: "recall-fixture",
    label: "Fixture recall",
    type: "dsh",
    baseUrl: "http://127.0.0.1:9",
    functionalAgentOnly: true,
    provider: "fixture",
    model: "fixture-fast",
  });
  return cfg;
}

function setup(t, run, cfg = pilotConfig()) {
  const f = fixture(t, { cfg: validateConfig(cfg), run });
  const memory = f.store.bind("agent-0");
  async function add(
    num,
    text,
    groupId = 20000,
    user = 30000,
    time = 1800000000,
  ) {
    await f.runtime.ingest(
      "qq-0",
      raw(num, {
        group_id: groupId,
        user_id: user,
        time,
        message: [{ type: "text", data: { text } }],
      }),
    );
    return memory.db
      .prepare("SELECT id,seq FROM events WHERE agent_id=? AND message_id=?")
      .get("agent-0", String(num));
  }
  async function turn(input, conversation = group) {
    const result = await f.runtime.runTurn("agent-0", conversation, {
      reasons: [{ reason: "mention", seq: input.seq }],
    });
    assert.equal(result.status, "completed-no-send");
    return memory.identity.get(
      "model_turns",
      memory.state(conversation).lastTurnId,
    );
  }
  return { ...f, memory, add, turn };
}

test("opening searches only previous same-group evidence and attaches an authorized correction", async (t) => {
  let old,
    corrected,
    main,
    checks = 0;
  const f = setup(t, async (p) => {
    if (p.modelSelection) {
      checks++;
      const found = await p.callTool("memory_search", { query: "夹具地点" });
      assert.deepEqual(
        found.items.map(({ id }) => id),
        [corrected.id, old.id],
      );
      await assert.rejects(
        p.callTool("memory_search", {}),
        /FUNCTIONAL_AGENT_TOOL_BUDGET/,
      );
      await p.callTool("functional_agent_result", { evidenceIds: [old.id] });
    } else {
      main = p.prompt;
      assert.deepEqual(
        (await p.callTool("diagnostics_read", {})).memoryRecall.currentTurn
          .opening.presented,
        1,
      );
    }
  });
  old = await f.add(1, "夹具地点原定在南楼");
  await f.add(2, "我还答应做另一个无关任务");
  corrected = await f.add(3, "夹具地点改在北楼");
  await f.add(4, "夹具地点的其他群私密例子", 20001);
  const ctx = f.runtime.makeContext("agent-0", group);
  f.memory.corrections.create(
    {
      personId: "30000",
      oldBelief: "南楼",
      current: "北楼",
      kind: "clarification",
      scope: "夹具地点",
      targets: [{ type: "event", id: old.id }],
    },
    corrected,
    recallBoundary(f.runtime, ctx),
    new Date().toISOString(),
  );
  const input = await f.add(5, "还记得上次的夹具地点吗");
  const turn = await f.turn(input);
  assert.equal(checks, 1);
  assert.match(main.split("本轮记忆查证 ")[1], /夹具地点改在北楼/);
  assert.doesNotMatch(main.split("本轮记忆查证 ")[1], /南楼|无关任务|私密例子/);
  assert.deepEqual(memoryRecallDiagnostic(turn).opening, {
    reason: "past-reference",
    status: "matched",
    matched: 1,
    presented: 1,
    waitMs: turn.memoryRecall.opening.waitMs,
  });
  assert.equal(f.memory.state(group).readThroughSeq || 0, 0);
});

test("active recall uses a current cue, returns an acknowledged result once and does not run outside the pilot", async (t) => {
  let childCount = 0;
  let old;
  const f = setup(t, async (p) => {
    if (p.modelSelection) {
      childCount++;
      assert.doesNotMatch(p.prompt, /隔壁的隐藏线索/);
      await p.callTool("memory_read", { id: old.id });
      await p.callTool("functional_agent_result", { evidenceIds: [old.id] });
      return;
    }
    if (p.conversation !== group) {
      assert.equal(
        p.tools.some(({ name }) => name === "memory_recall"),
        false,
      );
      assert.doesNotMatch(p.prompt, /本轮记忆查证/);
      return;
    }
    assert.match(p.prompt, /"status":"skipped"/);
    assert.deepEqual(
      await p.callTool("memory_recall", { cue: "隔壁的隐藏线索" }),
      { status: "no-cue" },
    );
    const result = await p.callTool("memory_recall", { cue: "夹具安排" });
    assert.equal(result.status, "matched");
    assert.equal(result.evidence[0].id, old.id);
    assert.deepEqual(await p.callTool("memory_recall", { cue: "夹具安排" }), {
      status: "budget",
    });
  });
  old = await f.add(1, "夹具安排在室外");
  const input = await f.add(2, "夹具安排是什么");
  const turn = await f.turn(input);
  assert.equal(childCount, 1);
  assert.equal(turn.memoryRecall.opening.reason, "no-cue");
  assert.equal(turn.memoryRecall.active.presented, 1);
  assert.equal(
    (await f.turn(await f.add(3, "上次的夹具安排是什么", 20001), "group:20001"))
      .memoryRecall,
    undefined,
  );
  assert.equal(childCount, 1);
});

test("an opening deadline lets ordinary QQ continue and records no presented evidence", async (t) => {
  const cfg = pilotConfig();
  cfg.agents[0].functionalAgents.memory.pilot.openingTimeoutMs = 15;
  const f = setup(
    t,
    async (p) => {
      if (p.modelSelection) {
        await new Promise((resolve) =>
          p.signal.addEventListener("abort", resolve, { once: true }),
        );
        return;
      }
      assert.match(p.prompt, /"status":"timeout"/);
    },
    cfg,
  );
  const input = await f.add(1, "还记得上次的测试吗");
  const turn = await f.turn(input);
  assert.equal(turn.memoryRecall.opening.status, "timeout");
  assert.equal(turn.memoryRecall.opening.presented, 0);
});

test("pilot configuration does not authorize an unlisted group", () => {
  const cfg = pilotConfig();
  cfg.agents[0].functionalAgents.memory.pilot.groups.push("20002");
  assert.throws(() => validateConfig(cfg), /CONFIG_SCHEMA_INVALID/);
});

test("rechecks matched evidence at the ordinary backend submission fence", async (t) => {
  let old, suffix;
  const f = setup(t, async (p) => {
    assert.ok(p.modelSelection);
    // The candidate was already shown in the child input and needs no query.
    assert.match(p.prompt, /约定八点见/);
    await p.callTool("functional_agent_result", { evidenceIds: [old.id] });
  });
  old = await f.add(1, "柚子取件中约定八点见");
  const input = await f.add(2, "还记得上次的柚子取件吗");
  f.runtime.backends.set("agent-0", {
    async run(p) {
      await p.beforeInputSubmitted?.();
      f.memory.db
        .prepare("UPDATE events SET status='recalled' WHERE id=?")
        .run(old.id);
      suffix = p.appendPrompt();
      p.onInputSubmitted();
    },
    cancel() {},
    close() {},
  });
  const turn = await f.turn(input);
  assert.match(suffix, /"status":"withheld"/);
  assert.doesNotMatch(suffix, /八点见/);
  assert.equal(turn.memoryRecall.opening.matched, 1);
  assert.equal(turn.memoryRecall.opening.presented, 0);
});

function clues(prompt) {
  const section = prompt.split("同群眼熟线索 ")[1];
  return section ? JSON.parse(section.split("。triggers")[0]) : [];
}

test("natural messages are scanned at intake and share one clue across the reply batch", async (t) => {
  let prompt;
  const f = setup(t, async (p) => {
    assert.equal(p.modelSelection, undefined);
    prompt = p.prompt;
  });
  const history = await f.add(
    1,
    "蓝色背包放在北门的柜子里",
    20000,
    30000,
    1799990000,
  );
  await f.add(2, "蓝色背包隔壁群才知道的存放地点", 20001, 30000, 1799990000);
  const first = await f.add(3, "蓝色背包要带去北门吗", 20000, 30001);
  const second = await f.add(4, "蓝色背包可以先放着吗");
  // Intake cannot have seen an event archived after the messages it marked.
  const later = f.memory.append({
    dedupe: "late-history",
    connectionId: "qq-0",
    conversation: group,
    kind: "message.received",
    body: "蓝色背包放在南楼",
    occurredAt: new Date(1799990001000).toISOString(),
  });
  const turn = await f.turn(first);
  const result = clues(prompt);
  assert.equal(result.length, 1);
  assert.equal(result[0].id, history.id);
  assert.notEqual(result[0].id, later.id);
  assert.equal(result[0].status, "眼熟");
  assert.match(result[0].excerpt, /柜子/);
  assert.deepEqual(
    new Set(result[0].triggers.map((x) => x.inputEventId)),
    new Set([first.id, second.id]),
  );
  const diagnostic = memoryRecallDiagnostic(turn).familiarity;
  assert.equal(diagnostic.checked, 2);
  assert.equal(diagnostic.presented, 1);
});

test("a short unsegmented name is a weak clue and a recalled source is withheld", async (t) => {
  let prompt;
  const f = setup(t, async (p) => {
    assert.equal(p.modelSelection, undefined);
    prompt = p.prompt;
  });
  const old = await f.add(1, "群里约过北门碰头", 20000, 30000, 1799990000);
  const input = await f.add(2, "北门还封着，咱们走哪边？");
  await f.turn(input);
  assert.deepEqual(
    clues(prompt).map(({ id, status, excerpt, triggers }) => ({
      id,
      status,
      excerpt,
      triggers,
    })),
    [
      {
        id: old.id,
        status: "待核对",
        excerpt: undefined,
        triggers: [{ inputEventId: input.id, sharedTerms: ["北门"] }],
      },
    ],
  );
  const next = await f.add(3, "北门还封着，咱们走哪边？");
  f.memory.db
    .prepare("UPDATE events SET status='recalled' WHERE id=?")
    .run(old.id);
  const turn = await f.turn(next);
  assert.deepEqual(clues(prompt), []);
  assert.equal(memoryRecallDiagnostic(turn).familiarity.status, "withheld");
  assert.equal(memoryRecallDiagnostic(turn).familiarity.presented, 0);
});

test("competing old clues remain uncertain and a protected candidate stays hidden", async (t) => {
  let prompt;
  const f = setup(t, async (p) => {
    assert.equal(p.modelSelection, undefined);
    prompt = p.prompt;
  });
  const north = await f.add(1, "蓝色背包放北门", 20000, 30000, 1799990000);
  const south = await f.add(2, "蓝色背包放南楼", 20000, 30000, 1799990001);
  f.memory.append({
    dedupe: "protected-history",
    connectionId: "qq-0",
    conversation: group,
    kind: "message.received",
    body: "蓝色背包内部权限测试",
    payload: { protectedOperations: true },
    occurredAt: new Date(1799990002000).toISOString(),
  });
  const input = await f.add(4, "蓝色背包交给谁拿着？");
  const turn = await f.turn(input);
  const result = clues(prompt);
  assert.deepEqual(
    new Set(result.map(({ id }) => id)),
    new Set([north.id, south.id]),
  );
  assert.ok(
    result.every(
      ({ status, triggers }) =>
        status === "待核对" && triggers[0].inputEventId === input.id,
    ),
  );
  assert.equal(memoryRecallDiagnostic(turn).familiarity.presented, 2);
  const chatter = await f.add(5, "大家好，今天晚上一起聊聊天");
  const next = await f.turn(chatter);
  assert.deepEqual(clues(prompt), []);
  assert.equal(memoryRecallDiagnostic(next).familiarity.status, "empty");
});
