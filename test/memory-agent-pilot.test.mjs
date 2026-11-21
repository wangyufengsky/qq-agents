import { safeToolFailure } from "../src/tools/errors.mjs";
import test from "node:test";
import { recordMemoryRecall } from "../src/core/session-records.mjs";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { activityPage } from "../src/core/activity.mjs";
import { validateConfig } from "../src/core/config.mjs";
import { semanticDigest } from "../src/core/semantic-recall.mjs";
import { recallBoundary } from "../src/core/recall-boundary.mjs";
import { memoryRecallDiagnostic } from "../src/core/session-records.mjs";
import { config, fixture, raw, sendReviewed } from "./helpers.mjs";

const group = "group:20000";
const contribution = "补上了上次已经确认的安排。";

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
    extra = {},
  ) {
    await f.runtime.ingest(
      "qq-0",
      raw(num, {
        group_id: groupId,
        user_id: user,
        time,
        message: [{ type: "text", data: { text } }],
        ...extra,
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
      await p.callTool("functional_agent_result", {
        evidenceIds: [old.id],
        contribution,
      });
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
  const delivered = main.split("本轮记忆查证 ")[1].split("。回想资料")[0];
  const { evidence, contribution: explanation } = JSON.parse(delivered);
  const [row] = evidence;
  assert.equal(row.corrects, old.id);
  assert.equal(explanation, undefined);
  assert.doesNotMatch(row.body, /无关任务/);
  assert.doesNotMatch(delivered, /南楼|私密例子/);
  assert.deepEqual(memoryRecallDiagnostic(turn).opening, {
    reason: "past-reference",
    status: "matched",
    matched: 1,
    presented: 1,
    waitMs: turn.memoryRecall.opening.waitMs,
    openingWaitMs: turn.memoryRecall.opening.openingWaitMs,
    presentedAtStage: "opening",
    agentMs: turn.memoryRecall.opening.agentMs,
  });
  assert.equal(f.memory.state(group).readThroughSeq || 0, 0);
});

test("removing a different group's admission and pilot entry preserves in-flight recall", async (t) => {
  const cfg = pilotConfig();
  cfg.agents[0].functionalAgents.memory.pilot.groups.push("20001");
  const entered = Promise.withResolvers();
  const resume = Promise.withResolvers();
  let old;
  const f = setup(
    t,
    async (p) => {
      if (!p.modelSelection) return;
      entered.resolve();
      await resume.promise;
      await p.callTool("memory_read", { id: old.id });
      await p.callTool("functional_agent_result", {
        evidenceIds: [old.id],
        contribution,
      });
    },
    cfg,
  );
  old = await f.add(1, "夹具地点原定在南楼");
  const input = await f.add(2, "还记得上次的夹具地点吗");
  const turn = f.turn(input);
  await entered.promise;
  const next = structuredClone(f.runtime.config);
  next.agents[0].allow.groups = ["20000"];
  next.agents[0].functionalAgents.memory.pilot.groups = ["20000"];
  const save = f.runtime.changeConfig(next, f.configStore.revision);
  resume.resolve();
  const [result, record] = await Promise.all([save, turn]);

  assert.equal(result.revokedGroupScopes, 1);
  assert.equal(record.memoryRecall.opening.status, "matched");
  assert.equal(record.memoryRecall.opening.presented, 1);
});

test("active recall uses a current cue, returns an acknowledged result once and does not run outside the pilot", async (t) => {
  let childCount = 0;
  let old;
  const f = setup(t, async (p) => {
    if (p.modelSelection) {
      childCount++;
      assert.doesNotMatch(p.prompt, /隔壁的隐藏线索/);
      await p.callTool("memory_read", { id: old.id });
      await p.callTool("functional_agent_result", {
        evidenceIds: [old.id],
        contribution,
      });
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
      { status: "no-cue", reason: "cue-not-found" },
    );
    const result = await p.callTool("memory_recall", { cue: "夹具安排" });
    assert.equal(result.status, "matched");
    assert.equal(result.evidence[0].id, old.id);
    assert.equal(result.contribution, contribution);
    assert.equal(
      (await p.callTool("diagnostics_read", {})).memoryRecall.currentTurn.active
        .contribution,
      undefined,
    );
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
  const [entry] = activityPage(f.store, "agent-0").items;
  assert.equal(entry.memoryRecall.active.contribution, contribution);
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

function delayedLookup(t, chat, { correction = false } = {}) {
  const release = Promise.withResolvers();
  let old;
  let lookups = 0;
  const cfg = pilotConfig();
  cfg.agents[0].tools.push("qq_draft");
  cfg.agents[0].maxSendsPerTurn = 3;
  cfg.agents[0].maxConsecutiveSends = 3;
  const f = setup(
    t,
    async (p) => {
      if (!p.modelSelection) return chat(p);
      lookups++;
      const stop = () => release.resolve();
      p.signal.addEventListener("abort", stop, { once: true });
      await release.promise;
      p.signal.removeEventListener("abort", stop);
      if (p.signal.aborted) return;
      await p.callTool("functional_agent_result", {
        evidenceIds: [old.id],
        contribution,
        ...(correction && { correction: true }),
      });
    },
    cfg,
  );
  return {
    ...f,
    release: release.resolve,
    lookups: () => lookups,
    async start() {
      old = await f.add(1, "读书会已从北门改到东门", 20000, 30000, 1799900000);
      const input = await f.add(2, "上次的读书会约在哪里？");
      return f.runtime.runTurn("agent-0", group, {
        reasons: [{ reason: "mention", seq: input.seq }],
      });
    },
  };
}

test("a deferred lookup that finishes before native input is attached at opening", async (t) => {
  let prompt;
  const f = delayedLookup(t, (p) => {
    prompt = p.prompt;
  });
  const adapter = f.runtime.backendConnections.adapter(
    f.runtime.agent("agent-0"),
  );
  const run = adapter.run.bind(adapter);
  adapter.run = async (p) => {
    f.release();
    await [...f.runtime.running.values()][0].openingLookup.done;
    return run(p);
  };
  await f.start();
  assert.match(prompt, /"status":"matched"/);
  assert.equal(f.lookups(), 1);
});

test("memory recall collects the original pending lookup once with a tool receipt", async (t) => {
  let result, repeated;
  const f = delayedLookup(t, async (p) => {
    assert.match(p.prompt, /记忆查证还在进行/);
    const waiting = p.callTool("memory_recall", { opening: true });
    f.release();
    result = await waiting;
    repeated = await p.callTool("memory_recall", { opening: true });
  });
  await f.start();
  assert.equal(result.evidence[0].body, "读书会已从北门改到东门");
  assert.equal(repeated.status, "already-presented");
  assert.equal(f.lookups(), 1);
});

test("pending opening evidence reaches a draft review only once", async (t) => {
  let first, next;
  const f = delayedLookup(t, async (p) => {
    const other = f.runtime.makeContext("agent-0", group);
    const saved = await f.runtime.callTool(other, "qq_send", {
      requestId: "draft-before-clue",
      text: "待核对的约定",
    });
    const args = {
      action: "prepare",
      draftId: saved.draft.draftId,
      expectedVersion: saved.draft.version,
    };
    f.release();
    await [...f.runtime.running.values()][0].openingLookup.done;
    first = await p.callTool("qq_draft", args);
    next = await p.callTool("qq_draft", args);
  });
  const outcome = await f.start();
  assert.equal(outcome.status, "completed-no-send");
  assert.equal(
    first.preparation.memoryRecall.evidence[0].body,
    "读书会已从北门改到东门",
  );
  assert.equal(next.preparation.memoryRecall, undefined);
  const turn = f.memory.identity.get(
    "model_turns",
    f.memory.state(group).lastTurnId,
  );
  assert.equal(memoryRecallDiagnostic(turn).opening.presentedAtStage, "draft");
});

test("concurrent tool outputs reserve a clue once and only record a confirmed receipt", async (t) => {
  const f = delayedLookup(t, async () => {
    const ctx = [...f.runtime.running.values()][0];
    const collect = () =>
      f.runtime.callTool(
        ctx,
        "memory_recall",
        { opening: true },
        { deferInput: true },
      );
    const pending = [collect(), collect()];
    f.release();
    const results = await Promise.all(pending);
    const encode = async (value) => ({
      wire: JSON.stringify(value),
      text: JSON.stringify(value),
    });
    const outputs = await Promise.all(
      results.map((row) => f.runtime.finalizeToolOutput(ctx, row, { encode })),
    );
    assert.equal(
      outputs.filter((out) => JSON.parse(out.wire).evidence).length,
      1,
    );
    const [receipt] = outputs.filter((out) => out.receipt);
    assert.equal(ctx.openingLookup.delivered, undefined);
    assert.equal(
      f.runtime.commitToolOutput(ctx, receipt.receipt, receipt.wire),
      true,
    );
    assert.equal(ctx.openingLookup.delivered, true);
  });
  assert.equal((await f.start()).status, "completed-no-send");
});

test("a chat ending without a send cancels the detached lookup", async (t) => {
  let job;
  const f = delayedLookup(t, async () => {
    job = [...f.runtime.running.values()][0].openingLookup;
  });
  assert.equal((await f.start()).status, "completed-no-send");
  await job.done;
  const turn = f.memory.identity.get(
    "model_turns",
    f.memory.state(group).lastTurnId,
  );
  assert.equal(job.controller.signal.aborted, true);
  assert.equal(turn.memoryRecall.opening.status, "cancelled");
  assert.equal(turn.memoryRecall.opening.presented, 0);
});

test("an unknown delivery cannot trigger a late correction", async (t) => {
  let calls = 0;
  const f = delayedLookup(
    t,
    async (p) => {
      calls++;
      p.saveSession({ id: "unconfirmed-recall-session", backend: "fixture" });
      f.runtime.transports.get("qq-0").failure = "fixture timeout";
      await assert.rejects(
        fixtureReply(p, "unconfirmed-before-clue", "约在北门"),
        /DELIVERY_UNKNOWN/,
      );
      f.release();
    },
    { correction: true },
  );
  await f.start();
  assert.equal(calls, 1);
  assert.equal(f.runtime.transports.get("qq-0").sent.length, 1);
});

async function fixtureReply(p, requestId, text) {
  return sendReviewed(
    (args) => p.callTool("qq_send", args),
    { requestId, text },
    (args) => p.callTool("qq_draft", args),
  );
}

for (const kind of ["correction", "background", "new-input", "withdrawn"]) {
  test(
    "confirmed reply receives one bounded late review: " + kind,
    async (t) => {
      let reviews = 0,
        nativeTools,
        first,
        second,
        duplicate,
        blocked;
      const f = delayedLookup(
        t,
        async (p) => {
          if (p.prompt.includes("本轮回复已确认发送")) {
            reviews++;
            assert.deepEqual(p.tools, nativeTools);
            assert.equal(p.session.id, "late-recall-session");
            await assert.rejects(
              p.callTool("diary_write", { body: "无关工具" }),
              /TOOL_DISABLED/,
            );
            assert.match(p.prompt, /"confirmedReply".*北门/);
            assert.match(p.prompt, /改到东门/);
            if (kind === "withdrawn") {
              f.memory.db
                .prepare(
                  "UPDATE events SET status='recalled' WHERE message_id='1'",
                )
                .run();
              await assert.rejects(
                fixtureReply(p, "late-correction", "更正为东门"),
                /RECALL_SOURCE_NOT_ALLOWED/,
              );
              blocked = true;
              return;
            }
            second = await fixtureReply(p, "late-correction", "更正为东门");
            try {
              await fixtureReply(p, "late-extra", "再发一条");
            } catch (error) {
              duplicate = error.message;
            }
            return;
          }
          nativeTools = p.tools;
          p.saveSession({ id: "late-recall-session", backend: "fixture" });
          first = await fixtureReply(p, "before-clue", "约在北门");
          if (kind === "new-input") await f.add(3, "聊个新话题");
          f.release();
        },
        { correction: kind !== "background" },
      );
      const outcome = await f.start();
      assert.equal(first?.status, "sent");
      assert.equal(outcome.status, "sent");
      assert.equal(f.lookups(), 1);
      assert.equal(
        reviews,
        kind === "correction" || kind === "withdrawn" ? 1 : 0,
      );
      if (kind === "correction") {
        assert.equal(second?.status, "sent");
        assert.equal(duplicate, "REPLY_BURST_LIMIT");
      }
      if (kind === "withdrawn") assert.equal(blocked, true);
      assert.equal(
        f.runtime.transports.get("qq-0").sent.length,
        kind === "correction" ? 2 : 1,
      );
    },
  );
}

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
    assert.match(p.instructions, /"evidenceIds":\[\].*省略 contribution/);
    assert.match(p.instructions, /1 至 80 字符/);
    const spec = p.tools.find(({ name }) => name === "functional_agent_result");
    assert.equal(spec.inputSchema.if.properties.evidenceIds.maxItems, 0);
    assert.deepEqual(spec.inputSchema.then.not.required, ["contribution"]);
    assert.deepEqual(spec.inputSchema.else.required, ["contribution"]);
    const invalidContribution = (rule, hint) => (error) => {
      const failure = safeToolFailure(error);
      assert.equal(failure.code, "INVALID_TOOL_ARGUMENTS");
      assert.equal(failure.issues[0].field, "contribution");
      assert.equal(failure.issues[0].rule, rule);
      assert.match(failure.hint, hint);
      assert.doesNotMatch(
        JSON.stringify(failure),
        /SYNTHETIC_PRIVATE_CONTRIBUTION/,
      );
      return true;
    };
    await assert.rejects(
      p.callTool("functional_agent_result", { evidenceIds: [old.id] }),
      invalidContribution("contribution_required", /必须填写 contribution/),
    );
    await assert.rejects(
      p.callTool("functional_agent_result", {
        evidenceIds: [],
        contribution: "SYNTHETIC_PRIVATE_CONTRIBUTION",
      }),
      invalidContribution("contribution_must_be_omitted", /省略 contribution/),
    );
    await assert.rejects(
      p.callTool("functional_agent_result", {
        evidenceIds: [old.id],
        contribution: "长".repeat(81),
      }),
      (error) => {
        assert.deepEqual(safeToolFailure(error).issues, [
          { field: "contribution", code: "too_big", maximum: 80 },
        ]);
        return true;
      },
    );
    const token = /context=([A-Za-z0-9_-]+)/u.exec(p.prompt)?.[1];
    assert.ok(token);
    await assert.rejects(
      p.callTool("functional_agent_result", {
        evidenceIds: [old.id],
        contribution: token,
      }),
      /CAPABILITY_EXFILTRATION_BLOCKED/,
    );
    await assert.rejects(
      p.callTool("functional_agent_result", {
        evidenceIds: [old.id],
        contribution: "Bearer " + "x".repeat(24),
      }),
      /SENSITIVE_OUTPUT_BLOCKED/,
    );
    await p.callTool("functional_agent_result", {
      evidenceIds: [old.id],
      contribution,
    });
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
  assert.doesNotMatch(suffix, /补上了上次已经确认的安排/);
  assert.equal(
    memoryRecallDiagnostic(turn, { includeContribution: true }).opening
      .contribution,
    undefined,
  );
});

function openingEvidence(prompt) {
  const section = prompt.split("本轮记忆查证 ")[1];
  return section ? JSON.parse(section.split("。回想资料")[0]).evidence : [];
}

function setupFamiliarity(t, run) {
  const cfg = pilotConfig();
  cfg.agents[0].behavior.optionalGroupBacklog = true;
  return setup(t, run, cfg);
}

test("intake matches across a reply batch deliver one verified source", async (t) => {
  let prompt, history;
  const f = setupFamiliarity(t, async (p) => {
    if (p.modelSelection) {
      assert.match(p.prompt, /"recent":\[/);
      assert.match(p.prompt, /蓝色背包要带去北门吗/);
      assert.doesNotMatch(p.prompt, /隔壁群|南楼/);
      await p.callTool("functional_agent_result", {
        evidenceIds: [history.id],
        contribution,
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
  await f.add(4, "蓝色背包可以先放着吗");
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
  const result = openingEvidence(prompt);
  assert.equal(result.length, 1);
  assert.equal(result[0].id, history.id);
  assert.notEqual(result[0].id, later.id);
  assert.match(result[0].body, /柜子/);
  assert.doesNotMatch(prompt, /同群眼熟线索/);
  const diagnostic = memoryRecallDiagnostic(turn).familiarity;
  assert.equal(diagnostic.checked, 2);
  assert.equal(diagnostic.presented, 1);
});

test("an unsegmented name can be approved by the agent and a recalled source is withheld", async (t) => {
  let prompt, old;
  const f = setupFamiliarity(t, async (p) => {
    if (p.modelSelection)
      await p.callTool("functional_agent_result", {
        evidenceIds: [old.id],
        contribution,
      });
    else prompt = p.prompt;
  });
  old = await f.add(1, "群里约过北门碰头", 20000, 30000, 1799990000);
  const input = await f.add(2, "北门还封着，咱们走哪边？");
  await f.turn(input);
  assert.deepEqual(
    openingEvidence(prompt).map(({ id, body }) => ({ id, body })),
    [{ id: old.id, body: "群里约过北门碰头" }],
  );
  const next = await f.add(3, "北门还封着，咱们走哪边？");
  f.memory.db
    .prepare("UPDATE events SET status='recalled' WHERE id=?")
    .run(old.id);
  const turn = await f.turn(next);
  assert.deepEqual(openingEvidence(prompt), []);
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
  assert.deepEqual(openingEvidence(prompt), []);
  const diagnostic = memoryRecallDiagnostic(turn, {
    includeContribution: true,
  });
  assert.equal(diagnostic.opening.status, "empty");
  assert.equal(diagnostic.opening.contribution, undefined);
  assert.equal(diagnostic.familiarity.presented, 0);
  assert.doesNotMatch(prompt.split("本轮记忆查证 ")[1], /"contribution"/);
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
  assert.deepEqual(openingEvidence(prompt), []);
  assert.equal(memoryRecallDiagnostic(turn).opening.status, "skipped");
  assert.equal(memoryRecallDiagnostic(turn).familiarity.status, "empty");
});

test("identical commitments from different speakers remain distinct evidence", async (t) => {
  const cfg = pilotConfig();
  cfg.agents[0].memoryRecall = "enabled";
  cfg.agents[0].behavior.optionalGroupBacklog = true;
  const text = "我可以负责周六的读书会";
  let first, main;
  const f = setup(
    t,
    async (p) => {
      if (!p.modelSelection) {
        main = p.prompt;
        return;
      }
      const data = JSON.parse(p.prompt.split("任务资料：\n")[1]);
      assert.ok(
        data.recent.some(
          (row) => row.body === text && row.senderId === "30002",
        ),
      );
      assert.ok(
        data.candidates.some(
          (row) => row.id === first.id && row.senderId === "30001",
        ),
      );
      await p.callTool("functional_agent_result", {
        evidenceIds: [first.id],
        contribution: "另一位发言者也报名负责。",
      });
    },
    cfg,
  );
  first = await f.add(1, text, 20000, 30001, 1799900000);
  for (let i = 2; i < 28; i++)
    await f.add(i, "路过", 20000, 30001, 1799910000 + i);
  await f.add(28, text, 20000, 30002, 1799999960);
  await f.turn(await f.add(29, "周六的读书会有谁报名负责？"));
  assert.equal(openingEvidence(main)[0]?.id, first.id);
});

test("recent context removes repetition and lets the agent search for an extra detail", async (t) => {
  let prompt, route, repeated;
  let reviews = 0;
  const f = setupFamiliarity(t, async (p) => {
    if (p.modelSelection) {
      reviews++;
      const data = JSON.parse(p.prompt.split("任务资料：\n")[1]);
      assert.ok(data.recent.some(({ body }) => body === "北门今天封了"));
      assert.ok(data.candidates.every(({ id }) => id !== repeated.id));
      const result = await p.callTool("memory_search", { query: "东门绕行" });
      assert.ok(result.items.some(({ id }) => id === route.id));
      await p.callTool("functional_agent_result", {
        evidenceIds: [route.id],
        contribution,
      });
    } else prompt = p.prompt;
  });
  repeated = await f.add(1, "北门今天封了", 20000, 30001, 1799990000);
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
  assert.deepEqual(openingEvidence(prompt), []);
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
    await p.callTool("functional_agent_result", {
      evidenceIds: [old.id],
      contribution,
    });
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
      await p.callTool("functional_agent_result", {
        evidenceIds: [old.id],
        contribution,
      });
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
  const header = prompt.split("本轮记忆查证 ")[1].split("。回想资料")[0];
  assert.equal(JSON.parse(header).contribution, contribution);
  const [entry] = activityPage(f.store, "agent-0").items;
  assert.equal(entry.memoryRecall.opening.contribution, contribution);
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
      await p.callTool("functional_agent_result", {
        evidenceIds: [old.id],
        contribution,
      });
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
        contribution,
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

test("active question carries speaker metadata and expands only the selected original quote", async (t) => {
  const entered = Promise.withResolvers();
  const finish = Promise.withResolvers();
  let old,
    quoted,
    reviews = 0,
    attempts = 0;
  const f = setupFamiliarity(t, async (p) => {
    if (p.modelSelection) {
      reviews++;
      const data = JSON.parse(p.prompt.split("任务资料：\n")[1]);
      assert.equal(data.query, "青铜牌最早摆在哪？");
      assert.ok(
        data.current.some(
          ({ body, senderId }) =>
            body === "这件东西原来摆在哪里？" && senderId === "30000",
        ),
      );
      const candidate = data.candidates.find(({ id }) => id === old.id);
      assert.equal(candidate.senderId, "30002");
      assert.equal(candidate.senderName, "记录员");
      assert.equal(candidate.occurredAt, new Date(1799990100000).toISOString());
      assert.equal(candidate.direction, "in");
      assert.equal(candidate.scene, undefined);
      entered.resolve();
      await finish.promise;
      await p.callTool("functional_agent_result", {
        evidenceIds: [old.id],
        contribution,
      });
      return;
    }
    const pending = p.callTool("memory_recall", {
      cue: "不是本轮的原话",
      query: "青铜牌最早摆在哪？",
    });
    try {
      await Promise.race([
        entered.promise,
        pending.then(() => assert.fail("child did not start")),
      ]);
      assert.deepEqual(
        await p.callTool("memory_recall", { query: "另一个问题" }),
        { status: "busy" },
      );
    } finally {
      finish.resolve();
    }
    const result = await pending;
    assert.equal(result.status, "matched");
    const [row] = result.evidence;
    assert.equal(row.senderName, "记录员");
    assert.equal(row.scene.kind, "quote");
    assert.deepEqual(
      row.scene.messages.map(({ id, senderName, excerpt }) => ({
        id,
        senderName,
        excerpt,
      })),
      [{ id: quoted.id, senderName: "访客甲", excerpt: "展柜还没腾空" }],
    );
    assert.deepEqual(await p.callTool("memory_recall", { query: "再问一遍" }), {
      status: "budget",
    });
  });
  const delegate = f.runtime.functionalDelegation.run.bind(
    f.runtime.functionalDelegation,
  );
  f.runtime.functionalDelegation.run = (parent, target, options) => {
    if (!options.opening && ++attempts === 1) return { status: "busy" };
    return delegate(parent, target, options);
  };
  quoted = await f.add(1, "展柜还没腾空", 20000, 30001, 1799989800, {
    sender: { nickname: "访客甲" },
  });
  old = await f.add(2, "", 20000, 30002, 1799990100, {
    sender: { nickname: "记录员" },
    message: [
      { type: "reply", data: { id: "1" } },
      { type: "text", data: { text: "青铜牌放在靠窗的架子" } },
    ],
  });
  await f.add(3, "旁边一句与摆放无关", 20000, 30001, 1799990110);
  const turn = await f.turn(await f.add(4, "这件东西原来摆在哪里？"));
  assert.equal(attempts, 2);
  assert.equal(reviews, 1);
  assert.equal(memoryRecallDiagnostic(turn).active.presented, 1);
  assert.ok(f.memory.state(group).continuity.recent.includes(quoted.id));
});

test("opening evidence omits protected and recalled context and keeps authorized neighbors", async (t) => {
  let old, prompt;
  const f = setupFamiliarity(t, async (p) => {
    if (p.modelSelection) {
      const { candidates } = JSON.parse(p.prompt.split("任务资料：\n")[1]);
      assert.equal(candidates.find(({ id }) => id === old.id).scene, undefined);
      assert.doesNotMatch(
        JSON.stringify(candidates),
        /开门说明|墙上挂牌|受保护片段|已撤回片段/,
      );
      await p.callTool("functional_agent_result", {
        evidenceIds: [old.id],
        contribution,
      });
    } else {
      prompt = p.prompt;
    }
  });
  const before = await f.add(1, "开门说明", 20000, 30001, 1799990000);
  const recalled = await f.add(2, "已撤回片段", 20000, 30001, 1799990010);
  f.memory.db
    .prepare("UPDATE events SET status='recalled' WHERE id=?")
    .run(recalled.id);
  old = await f.add(3, "陶器展台周末暂停使用", 20000, 30002, 1799990020);
  f.memory.append({
    dedupe: "protected-recall-neighbor",
    connectionId: "qq-0",
    conversation: group,
    kind: "message.received",
    status: "observed",
    body: "受保护片段",
    payload: { protectedOperations: true },
    occurredAt: new Date(1799990025000).toISOString(),
  });
  const after = await f.add(4, "墙上挂牌", 20000, 30001, 1799990030);
  await f.add(5, "其他群的附近内容", 20001, 30001, 1799990031);
  const turn = await f.turn(await f.add(6, "还记得上次陶器展台的安排吗？"));
  const suffix = prompt.split("本轮记忆查证 ")[1];
  const { evidence } = JSON.parse(suffix.split("。回想资料")[0]);
  const row = evidence.find(({ id }) => id === old.id);
  assert.ok(row, suffix);
  assert.equal(row.id, old.id);
  assert.equal(row.scene.kind, "nearby");
  assert.deepEqual(
    row.scene.messages.map(({ id, position }) => [id, position]),
    [
      [before.id, "before"],
      [after.id, "after"],
    ],
  );
  assert.doesNotMatch(suffix, /受保护片段|已撤回片段|其他群的附近内容/);
  assert.equal(memoryRecallDiagnostic(turn).opening.presented, 1);
});

test("an active question requires a current owner message", async (t) => {
  let ordinary = 0;
  const f = setupFamiliarity(t, async (p) => {
    assert.equal(p.modelSelection, undefined);
    ordinary++;
    assert.deepEqual(
      await p.callTool("memory_recall", { query: "旧的访客安排是什么？" }),
      { status: "no-cue", reason: "no-owner-input" },
    );
  });
  await f.add(1, "之前的安排只在同群讨论过", 20000, 30000, 1799990000);
  const input = await f.add(2, "能查一下吗？", 20000, 30001);
  const turn = await f.turn(input);
  assert.equal(ordinary, 1);
  assert.equal(memoryRecallDiagnostic(turn).active.status, "no-cue");
  assert.equal(memoryRecallDiagnostic(turn).active.reason, "no-owner-input");
});

test("automatic recall gives the reviewer current and recent speakers and delivers selected evidence intact", async (t) => {
  let confirmed, reviewInput, dialogue;
  const f = setupFamiliarity(t, async (p) => {
    if (p.modelSelection) {
      reviewInput = JSON.parse(p.prompt.split("任务资料：\n")[1]);
      await p.callTool("functional_agent_result", {
        evidenceIds: [confirmed.id],
        contribution,
      });
    } else dialogue = p.prompt;
  });
  confirmed = await f.add(1, "帐篷安检记录已签字", 20000, 30000, 1799990000);
  await f.add(2, "参观员在问帐篷安检", 20000, 30001, 1799999990);
  const trigger = await f.add(3, "我这次还得做帐篷安检吗？");
  const turn = await f.turn(trigger);
  assert.equal(reviewInput.current[0].senderId, "30000");
  assert.equal(reviewInput.current[0].id, trigger.id);
  assert.equal(
    reviewInput.recent.find(({ body }) => body.includes("参观员")).senderId,
    "30001",
  );
  const section = dialogue.split("本轮记忆查证 ")[1];
  const delivered = JSON.parse(section.split("。回想资料")[0]);
  assert.equal(delivered.status, "matched");
  assert.equal(delivered.evidence[0].id, confirmed.id);
  assert.equal(delivered.evidence[0].body, "帐篷安检记录已签字");
  assert.equal(turn.memoryRecall.opening.presented, 1);
});

test("active query keeps a current owner anchor when other speakers fill the end of the batch", async (t) => {
  let old,
    answer,
    requests = 0;
  const f = setup(t, async (p) => {
    if (p.modelSelection) {
      requests++;
      const data = JSON.parse(p.prompt.split("任务资料：\n")[1]);
      assert.equal(data.query, "展台接线用什么接口？");
      await p.callTool("functional_agent_result", {
        evidenceIds: [old.id],
        contribution,
      });
      return;
    }
    answer = await p.callTool("memory_recall", {
      query: "展台接线用什么接口？",
    });
  });
  old = await f.add(1, "展台接线使用圆形接口", 20000, 30000, 1799990000);
  const owner = await f.add(2, "帮我查一下展台接线。");
  for (let i = 3; i <= 6; i++)
    await f.add(i, "其他人正在讨论布置", 20000, 30001);
  await f.turn(owner);
  assert.equal(requests, 1);
  assert.equal(answer.status, "matched");
  assert.equal(answer.evidence[0].id, old.id);
});

test("active recall timeout tells the dialogue how to search without claiming verified evidence", async (t) => {
  let answer;
  const f = setup(t, async (p) => {
    if (!p.modelSelection)
      answer = await p.callTool("memory_recall", {
        query: "展台接线用什么接口？",
      });
  });
  const run = f.runtime.functionalDelegation.run.bind(
    f.runtime.functionalDelegation,
  );
  f.runtime.functionalDelegation.run = (parent, target, options) =>
    options.opening ? run(parent, target, options) : { status: "timeout" };
  await f.add(1, "展台接线使用圆形接口", 20000, 30000, 1799990000);
  const turn = await f.turn(await f.add(2, "帮我查一下展台接线。"));
  assert.equal(answer.status, "timeout");
  assert.equal(answer.evidence, undefined);
  assert.match(answer.notice, /memory_search/);
  assert.equal(turn.memoryRecall.active.presented, 0);
  assert.ok(Number.isInteger(turn.memoryRecall.active.agentMs));
});

test("expanded group recall combines a non-owner question with a later speaker in the same batch", async (t) => {
  const cfg = pilotConfig();
  cfg.agents[0].memoryRecall = "enabled";
  let past, early, followup, modelInput, prompt;
  const f = setup(
    t,
    async (p) => {
      if (!p.modelSelection) {
        prompt = p.prompt;
        return;
      }
      modelInput = JSON.parse(p.prompt.split("任务资料：\n")[1]);
      const result = await p.callTool("memory_search", { query: "夹具地点" });
      assert.deepEqual(
        result.items.map(({ id }) => id),
        [past.id],
      );
      await p.callTool("functional_agent_result", {
        evidenceIds: [past.id],
        contribution,
      });
    },
    cfg,
  );
  past = await f.add(100, "周六那场夹具地点在北楼", 20001, 30001, 1799990000);
  await f.add(101, "夹具地点在别的群里", 20000, 30000, 1799990001);
  early = await f.add(102, "还记得上次的夹具地点吗？", 20001, 30001);
  for (let num = 103; num < 107; num++)
    await f.add(num, "我也想知道", 20001, 30002);
  followup = await f.add(107, "我是指周六那场", 20001, 30003);
  const turn = await f.turn(early, "group:20001");
  assert.equal(
    modelInput.current.some(
      ({ id, senderId }) => id === early.id && senderId === "30001",
    ),
    true,
  );
  assert.equal(
    [...modelInput.current, ...modelInput.recent].some(
      ({ id, senderId }) => id === followup.id && senderId === "30003",
    ),
    true,
  );
  assert.doesNotMatch(JSON.stringify(modelInput), /在别的群里/);
  assert.match(prompt.split("本轮记忆查证 ")[1], /北楼/);
  assert.equal(memoryRecallDiagnostic(turn).opening.presented, 1);
});

test("expanded private recall is on demand and confined to the current allowed contact", async (t) => {
  const cfg = pilotConfig();
  cfg.agents[0].memoryRecall = "enabled";
  cfg.agents[0].allow.users.push("30001", "30002");
  cfg.agents[0].wake.private = false;
  let past,
    other,
    result,
    attempts = 0;
  const f = setup(
    t,
    async (p) => {
      if (p.modelSelection) {
        attempts++;
        const found = await p.callTool("memory_search", {
          query: "夹具地点",
          conversation: "private:30002",
        });
        assert.deepEqual(
          found.items.map(({ id }) => id),
          [past.id],
        );
        await assert.rejects(
          p.callTool("memory_read", { id: other.id }),
          /RECALL_SOURCE_NOT_ALLOWED/,
        );
        await p.callTool("functional_agent_result", {
          evidenceIds: [past.id],
          contribution,
        });
      } else {
        assert.equal(attempts, 0);
        assert.doesNotMatch(p.prompt, /本轮记忆查证/);
        result = await p.callTool("memory_recall", {
          query: "上次的夹具地点是什么？",
        });
      }
    },
    cfg,
  );
  const extra = { message_type: "private", group_id: undefined };
  past = await f.add(
    110,
    "夹具地点在北楼",
    undefined,
    30001,
    1799990000,
    extra,
  );
  other = await f.add(
    111,
    "夹具地点在南楼",
    undefined,
    30002,
    1799990001,
    extra,
  );
  await f.add(112, "群聊的夹具地点在西楼", 20000, 30000, 1799990002);
  const input = await f.add(
    113,
    "你还记得上次的夹具地点吗？",
    undefined,
    30001,
    1800000000,
    extra,
  );
  const turn = await f.turn(input, "private:30001");
  assert.equal(attempts, 1, JSON.stringify(memoryRecallDiagnostic(turn)));
  assert.equal(result.status, "matched");
  assert.deepEqual(
    result.evidence.map(({ id }) => id),
    [past.id],
  );
  assert.equal(memoryRecallDiagnostic(turn).opening, undefined);
  assert.equal(memoryRecallDiagnostic(turn).active.presented, 1);
});

test("a compact opening with a resolved quote keeps the source and a short recall notice", async (t) => {
  const cfg = pilotConfig();
  const role = cfg.agents[0];
  role.behavior.compactChatGroups = ["20000"];
  role.behavior.relationshipRecallGroups = ["20000"];
  role.wake.mentions = false;
  role.contextPolicy.capacityTokens = 1000000;
  role.memoryRecall = "enabled";
  const prompts = [];
  let old;
  const f = setup(
    t,
    async (p) => {
      assert.equal(p.modelSelection, undefined);
      prompts.push(p.prompt);
      p.saveSession({ id: "compact-recall", backend: "fixture" });
      if (prompts.length === 1)
        await p.callTool("qq_mark_read", { throughSeq: old.seq });
    },
    cfg,
  );
  old = await f.add(120, "展板的试装在明天进行");
  await f.turn(old);
  const incoming = await f.add(121, "", 20000, 30001, 1800000001, {
    message: [
      { type: "at", data: { qq: "10000" } },
      { type: "reply", data: { id: "120" } },
      { type: "text", data: { text: "接着这条聊" } },
    ],
  });
  const turn = await f.turn(incoming);
  const prompt = prompts.at(-1);
  assert.match(prompt, /本轮相关相处与原话.*展板的试装在明天进行/);
  assert.match(
    prompt,
    /本轮记忆查证：已展开原引用。需要补查可用 memory_recall。/,
  );
  assert.doesNotMatch(prompt, /回想资料属于当前会话历史/);
  assert.equal(
    memoryRecallDiagnostic(turn).opening.reason,
    "explicit-reference",
  );
  assert.equal(memoryRecallDiagnostic(turn).opening.presented, 0);
});

test("recall service history preserves legacy turns, empty reviews and committed receipts independently", (t) => {
  const f = setupFamiliarity(t, async () => {});
  const history = () => f.runtime.status().agents[0].recallHealth;
  assert.deepEqual(history(), {
    backendId: "recall-fixture",
    completed: null,
    delivered: null,
  });
  f.memory.identity.put("model_turns", {
    id: "legacy",
    startedAt: 10,
    memoryRecall: { active: { status: "matched", presented: 1 } },
  });
  assert.deepEqual(history().completed, {
    at: 10,
    estimated: true,
    empty: false,
  });
  assert.deepEqual(history().delivered, { at: 10, estimated: true });
  f.memory.identity.put("model_turns", { id: "second", startedAt: 11 });
  const write = (route, details, at) =>
    recordMemoryRecall(f.memory, "second", route, details, at);
  write("familiarity", { status: "matched", presented: 2 }, 12);
  write("opening", { status: "unavailable", presented: 0 }, 13);
  assert.equal(history().completed.at, 10);
  write("opening", { status: "empty", presented: 0 }, 14);
  assert.deepEqual(history().completed, {
    at: 14,
    estimated: false,
    empty: true,
  });
  assert.equal(history().delivered.at, 10);
  write("active", { status: "matched", presented: 0 }, 15);
  assert.equal(history().delivered.at, 10);
  write("active", { presented: 1 }, 16);
  assert.deepEqual(history().completed, {
    at: 15,
    estimated: false,
    empty: false,
  });
  assert.deepEqual(history().delivered, { at: 16, estimated: false });
  f.runtime.config.agents[0].memoryRecall = "disabled";
  assert.equal(history(), undefined);
});
