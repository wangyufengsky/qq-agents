import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { validateConfig } from "../src/core/config.mjs";
import { semanticDigest } from "../src/core/semantic-recall.mjs";
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

test("pilot opening timeout accepts six seconds while the default stays four", () => {
  const cfg = pilotConfig();
  const pilot = cfg.agents[0].functionalAgents.memory.pilot;
  assert.equal(
    validateConfig(cfg).agents[0].functionalAgents.memory.pilot
      .openingTimeoutMs,
    4000,
  );
  pilot.openingTimeoutMs = 6000;
  assert.equal(
    validateConfig(cfg).agents[0].functionalAgents.memory.pilot
      .openingTimeoutMs,
    6000,
  );
  pilot.openingTimeoutMs = 6001;
  assert.throws(
    () => validateConfig(cfg),
    (error) => error.issues?.[0]?.maximum === 6000,
  );
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

function setupFamiliarity(t, run) {
  const cfg = pilotConfig();
  cfg.agents[0].behavior.optionalGroupBacklog = true;
  return setup(t, run, cfg);
}

test("natural messages are scanned at intake and share one clue across the reply batch", async (t) => {
  let prompt, history;
  const f = setupFamiliarity(t, async (p) => {
    if (p.modelSelection) {
      assert.match(p.prompt, /"recent":\[/);
      assert.match(p.prompt, /蓝色背包要带去北门吗/);
      assert.doesNotMatch(p.prompt, /隔壁群|南楼/);
      await p.callTool("functional_agent_result", {
        evidenceIds: [history.id],
      });
    } else prompt = p.prompt;
  });
  history = await f.add(
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

test("an unsegmented name can be approved by the agent and a recalled source is withheld", async (t) => {
  let prompt, old;
  const f = setupFamiliarity(t, async (p) => {
    if (p.modelSelection)
      await p.callTool("functional_agent_result", { evidenceIds: [old.id] });
    else prompt = p.prompt;
  });
  old = await f.add(1, "群里约过北门碰头", 20000, 30000, 1799990000);
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
        status: "眼熟",
        excerpt: "群里约过北门碰头",
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

test("the agent can reject all competing clues without seeing a protected candidate", async (t) => {
  let prompt;
  let reviews = 0;
  const f = setupFamiliarity(t, async (p) => {
    if (p.modelSelection) {
      reviews++;
      assert.match(p.prompt, /背包放北门/);
      assert.match(p.prompt, /背包放南楼/);
      assert.doesNotMatch(p.prompt, /内部权限测试/);
      await p.callTool("functional_agent_result", { evidenceIds: [] });
    } else prompt = p.prompt;
  });
  await f.add(1, "蓝色背包放北门", 20000, 30000, 1799990000);
  await f.add(2, "蓝色背包放南楼", 20000, 30000, 1799990001);
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
  assert.equal(reviews, 1);
  assert.deepEqual(clues(prompt), []);
  assert.equal(memoryRecallDiagnostic(turn).opening.status, "empty");
  assert.equal(memoryRecallDiagnostic(turn).familiarity.presented, 0);
});

test("interjections and a speaker's catchphrase do not launch memory review", async (t) => {
  let prompt;
  const f = setupFamiliarity(t, async (p) => {
    assert.equal(p.modelSelection, undefined);
    prompt = p.prompt;
  });
  for (let i = 1; i <= 4; i++) {
    await f.add(
      i,
      "叮咚，喵喵喵，哈哈哈，诶，看来好了",
      20000,
      30000,
      1799990000 + i,
    );
  }
  for (let i = 5; i <= 30; i++) {
    await f.add(i, "其他人的日常内容", 20000, 30001, 1799990000 + i);
  }
  const input = await f.add(31, "看来好了！叮咚，喵喵喵，哈哈哈，诶");
  const turn = await f.turn(input);
  assert.deepEqual(clues(prompt), []);
  assert.equal(memoryRecallDiagnostic(turn).opening.status, "skipped");
  assert.equal(memoryRecallDiagnostic(turn).familiarity.status, "empty");
});

test("recent context removes repetition and lets the agent search for an extra detail", async (t) => {
  let prompt, route;
  let reviews = 0;
  const f = setupFamiliarity(t, async (p) => {
    if (p.modelSelection) {
      reviews++;
      const data = JSON.parse(p.prompt.split("任务资料：\n")[1]);
      assert.ok(data.recent.some(({ body }) => body === "北门今天封了"));
      assert.ok(data.candidates.every(({ body }) => body !== "北门今天封了"));
      const result = await p.callTool("memory_search", { query: "东门绕行" });
      assert.ok(result.items.some(({ id }) => id === route.id));
      await p.callTool("functional_agent_result", { evidenceIds: [route.id] });
    } else prompt = p.prompt;
  });
  await f.add(1, "北门今天封了", 20000, 30000, 1799990000);
  await f.add(2, "北门维修期间临时关闭", 20000, 30000, 1799990001);
  route = await f.add(3, "走东门绕行，穿过小广场", 20000, 30000, 1799990002);
  await f.add(4, "北门今天封了", 20000, 30001, 1799999880);
  const input = await f.add(5, "北门还封着的话，从哪里进去？");
  const turn = await f.turn(input);
  assert.equal(reviews, 1);
  assert.match(prompt.split("本轮记忆查证 ")[1], /走东门绕行/);
  assert.doesNotMatch(prompt.split("本轮记忆查证 ")[1], /今天封了/);
  assert.equal(memoryRecallDiagnostic(turn).opening.presented, 1);
});

test("a source already visible in the dialogue input is not sent again", async (t) => {
  let prompt;
  const f = setup(t, async (p) => {
    assert.equal(p.modelSelection, undefined);
    prompt = p.prompt;
  });
  await f.add(1, "蓝色背包存放在北门", 20000, 30000, 1799990000);
  const turn = await f.turn(await f.add(2, "蓝色背包在哪里？"));
  assert.match(prompt.split("本轮记忆查证 ")[0], /蓝色背包存放在北门/);
  assert.deepEqual(clues(prompt), []);
  assert.equal(memoryRecallDiagnostic(turn).opening.status, "skipped");
  assert.equal(memoryRecallDiagnostic(turn).familiarity.presented, 0);
});

test("opening retrieves a short topic from beyond the recent window", async (t) => {
  let old, prompt;
  let reviews = 0;
  const f = setupFamiliarity(t, async (p) => {
    if (!p.modelSelection) {
      prompt = p.prompt;
      return;
    }
    reviews++;
    const data = JSON.parse(p.prompt.split("任务资料：\n")[1]);
    assert.deepEqual(
      data.candidates.map(({ id }) => id),
      [old.id],
    );
    assert.match(data.candidates[0].body, /木牌/);
    await p.callTool("functional_agent_result", { evidenceIds: [old.id] });
  });
  old = await f.add(1, "小亭的入口有一块木牌", 20000, 30000, 1799990000);
  await f.add(2, "小亭在另一座城", 20001, 30000, 1799990100);
  for (let i = 0; i < 260; i++)
    f.memory.append({
      dedupe: "historical-window-" + i,
      connectionId: "qq-0",
      conversation: group,
      kind: "message.received",
      body: "应该触发词表",
      occurredAt: new Date(1799990200000 + i * 1000).toISOString(),
    });
  const input = await f.add(300, "AI 小亭的情况怎么样？");
  const turn = await f.turn(input);
  assert.equal(reviews, 1);
  assert.equal(memoryRecallDiagnostic(turn).familiarity.matched, 0);
  assert.equal(memoryRecallDiagnostic(turn).opening.presented, 1);
  assert.match(prompt.split("本轮记忆查证 ")[1], /木牌/);
  assert.doesNotMatch(prompt.split("本轮记忆查证 ")[1], /另一座城|词表/);
});

test("generic discussion words alone do not nominate previous evidence", async (t) => {
  let reviews = 0;
  const f = setupFamiliarity(t, async (p) => {
    if (p.modelSelection) reviews++;
  });
  await f.add(1, "应该触发词表", 20000, 30000, 1799990000);
  const turn = await f.turn(await f.add(2, "应该、触发、词表"));
  assert.equal(reviews, 0);
  assert.equal(memoryRecallDiagnostic(turn).familiarity.matched, 0);
  assert.equal(memoryRecallDiagnostic(turn).opening.status, "skipped");
});

function enableSemanticPilot() {
  const cfg = pilotConfig();
  cfg.agents[0].functionalAgents.memory.pilot.semantic = true;
  cfg.agents[0].behavior.optionalGroupBacklog = true;
  return cfg;
}

test("semantic pilot reviews a paraphrase, withholds recent and unauthorized sources, and skips reactions", async (t) => {
  let old,
    recent,
    other,
    reviews = 0,
    searches = 0,
    prompt;
  const oldText = "小亭入口的木牌写着暂停来访";
  const recentText = "门口的钥匙已经交给值班人";
  const privateText = "隔壁的入场暗号";
  const f = setup(
    t,
    async (p) => {
      if (!p.modelSelection) {
        prompt = p.prompt;
        return;
      }
      reviews++;
      assert.match(p.prompt, /小亭入口的木牌/);
      const candidateText = p.prompt.split('"candidates":')[1];
      assert.doesNotMatch(candidateText, /门口的钥匙|隔壁的入场暗号/);
      await p.callTool("functional_agent_result", { evidenceIds: [old.id] });
    },
    enableSemanticPilot(),
  );
  old = await f.add(1, oldText, 20000, 30000, 1799990000);
  recent = await f.add(2, recentText, 20000, 30000, 1799999940);
  other = await f.add(3, privateText, 20001, 30000, 1799990000);
  f.runtime.semanticRecall.search = async (_role, conversation, text) => {
    searches++;
    assert.equal(conversation, group);
    assert.match(text, /^客人还能进来吗/u);
    return {
      status: "ready",
      waitMs: 4,
      hits: [
        { id: recent.id, digest: semanticDigest(recentText) },
        { id: other.id, digest: semanticDigest(privateText) },
        { id: old.id, digest: semanticDigest(oldText) },
      ],
    };
  };
  const turn = await f.turn(await f.add(4, "客人还能进来吗？"));
  assert.match(prompt.split("本轮记忆查证 ")[1], /暂停来访/);
  const trace = memoryRecallDiagnostic(turn).opening;
  assert.equal(trace.reason, "local-semantic");
  assert.equal(trace.presented, 1);
  assert.deepEqual(trace.semantic, {
    status: "matched",
    candidates: 1,
    waitMs: 4,
  });
  assert.ok(Number.isSafeInteger(trace.agentMs));
  const reaction = await f.turn(await f.add(5, "喵，哈哈，诶"));
  assert.equal(
    memoryRecallDiagnostic(reaction).opening.semantic.status,
    "no-cue",
  );
  assert.equal(searches, 1);
  assert.equal(reviews, 1);
});

test("semantic recall falls back to lexical evidence on worker timeout", async (t) => {
  let old,
    reviews = 0;
  const f = setup(
    t,
    async (p) => {
      if (!p.modelSelection) return;
      reviews++;
      await p.callTool("functional_agent_result", { evidenceIds: [old.id] });
    },
    enableSemanticPilot(),
  );
  old = await f.add(1, "橙色雨伞放在值班室", 20000, 30000, 1799990000);
  f.runtime.semanticRecall.search = async () => ({
    status: "timeout",
    waitMs: 150,
  });
  const turn = await f.turn(await f.add(2, "橙色雨伞放哪了？"));
  assert.equal(reviews, 1);
  const trace = memoryRecallDiagnostic(turn).opening;
  assert.equal(trace.presented, 1);
  assert.equal(trace.semantic.status, "timeout");
});

test("the worker receives only its eligible pilot scope and picks up new history after an empty scan", async (t) => {
  const f = setup(t, undefined, enableSemanticPilot());
  const service = f.runtime.semanticRecall;
  service.tick();
  assert.equal(service.pending, undefined);

  const writes = [];
  let starts = 0;
  service.start = () => {
    starts++;
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.kill = () => child.stdout.end();
    child.stdin.on("data", (chunk) => {
      const request = JSON.parse(chunk.toString());
      writes.push(request);
      child.stdout.write("[]\n");
    });
    return child;
  };
  await f.add(1, "另一个群的旧话", 20001, 30000, 1799990000);
  const eligible = await f.add(2, "试点群的旧话", 20000, 30000, 1799990000);
  const protectedRow = f.memory.append({
    dedupe: "protected-semantic-history",
    connectionId: "qq-0",
    conversation: group,
    kind: "message.received",
    status: "observed",
    body: "受保护的旧话",
    payload: { protectedOperations: true },
    occurredAt: new Date(1799990002000).toISOString(),
  });
  service.tick();
  assert.deepEqual(
    writes[0].rows.map(({ id }) => id),
    [eligible.id],
  );
  assert.notEqual(eligible.id, protectedRow.id);
  const role = f.runtime.agent("agent-0");
  const options = {
    beforeSeq: 9999,
    to: Date.parse("2027-01-01"),
    known: [],
    signal: new AbortController().signal,
    budget: 150,
  };
  assert.equal(
    (await service.search(role, "group:20001", "另一个群", options)).status,
    "unavailable",
  );
  const result = await service.search(role, group, "试点群", options);
  assert.equal(result.status, "ready");
  assert.equal(writes.length, 2);
  assert.equal(writes[0].scope, writes[1].scope);
  assert.equal(starts, 1);
});

test("semantic recall shows the tenth candidate and stops at ten", async (t) => {
  const hits = [];
  let reviews = 0;
  const cfg = enableSemanticPilot();
  cfg.agents[0].functionalAgents.memory.effort = "off";
  const f = setup(
    t,
    async (p) => {
      if (!p.modelSelection) return;
      reviews++;
      assert.equal(p.modelSelection.effort, "off");
      const { candidates } = JSON.parse(p.prompt.split("任务资料：\n")[1]);
      assert.deepEqual(
        candidates.map(({ id }) => id),
        hits.slice(0, 10).map(({ id }) => id),
      );
      await p.callTool("functional_agent_result", {
        evidenceIds: [hits[9].id],
      });
    },
    cfg,
  );
  for (let i = 1; i <= 12; i++) {
    const body = `石碑的刻字是第${i}号标记`;
    const { id } = await f.add(i, body, 20000, 30000, 1799990000 + i);
    hits.push({ id, digest: semanticDigest(body) });
  }
  f.runtime.semanticRecall.search = async () => ({
    status: "ready",
    hits,
    waitMs: 4,
  });
  const turn = await f.turn(await f.add(13, "游客可以进入建筑吗？"));
  assert.equal(reviews, 1);
  assert.equal(memoryRecallDiagnostic(turn).opening.presented, 1);
});
