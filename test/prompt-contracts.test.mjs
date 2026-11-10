import test from "node:test";
import assert from "node:assert/strict";
import { config, fixture, context, FakeTransport, raw } from "./helpers.mjs";
import { toolSpecs } from "../src/tools/index.mjs";
import { mcpEntrySpecs, scopedCatalog } from "../src/tools/catalog.mjs";
import { stableInstructions } from "../src/core/prompts.mjs";

test("QQ face send syntax is documented only for enabled tools and distinguishes inbound annotations", (t) => {
  const { runtime, store } = fixture(t, { cfg: config(1) }),
    agent = runtime.agent("agent-0"),
    self = store.bind(agent.id).identity.current(),
    instructions = (toolNames) =>
      stableInstructions(
        agent,
        self,
        false,
        {},
        {
          conversation: "group:20000",
          toolNames,
        },
      ),
    sendOnly = instructions(["qq_send"]),
    burstOnly = instructions(["qq_send_burst"]),
    withoutSending = instructions([]),
    sendSpec = toolSpecs(["qq_send"])[0],
    burstSpec = toolSpecs(["qq_send_burst"])[0];

  assert.match(sendOnly, /qq_send\.segments/);
  assert.match(sendOnly, /20[^\n]*偷笑|偷笑[^\n]*20/);
  assert.match(sendOnly, /qqFaces[^\n]*(入站|原消息)[^\n]*(发送语法|发送格式)/);
  assert.doesNotMatch(sendOnly, /qq_send_burst\.messages[^\n]*segments/);

  assert.match(burstOnly, /qq_send_burst\.messages/);
  assert.match(burstOnly, /segments/);
  assert.doesNotMatch(
    withoutSending,
    /qq_send\.segments|qq_send_burst\.messages/,
  );
  assert.match(sendSpec.description, /segments/);
  assert.match(sendSpec.description, /20[^\n]*偷笑|偷笑[^\n]*20/);
  assert.match(burstSpec.description, /segments/);
});

test("Self and own accounts stay fixed while peer accounts refresh without rebuilding", async (t) => {
  const cfg = config(2),
    captured = [];
  // This tests session continuity, independently of estimated capacity guards.
  cfg.agents[0].contextPolicy.capacityTokens = 65536;
  cfg.agents[0].persona = "我喜欢倾听，也会开玩笑。";
  cfg.agents[0].appearance = "固定形象";
  cfg.agents[0].ownerIds = ["30000"];
  const { runtime, store } = fixture(t, {
    cfg,
    run: async (p) => {
      captured.push(p);
      p.saveSession({ id: "fixture", backend: "fixture" });
    },
  });
  await runtime.wake("agent-0", "group:20000");
  store
    .bind("agent-0")
    .identity.adminEdit(
      { body: "我最近更喜欢读书。", reason: "管理员调整", expectedVersion: 1 },
      runtime.now(),
    );
  await runtime.wake("agent-0", "group:20000");
  for (const p of captured) {
    assert.match(p.instructions, /10000/);
    assert.doesNotMatch(p.instructions, /10001/);
    assert.match(p.prompt, /10001/);
    assert.match(p.instructions, /30000/);
    assert.match(p.instructions, /senderId/);
  }
  assert.match(captured[1].instructions, /self v2/);
  assert.equal(captured[1].session, null);
  assert.equal(store.bind("agent-0").identity.history().length, 2);
  const next = structuredClone(runtime.config);
  next.connections[1].accountId = "10009";
  await runtime.changeConfig(next, runtime.configStore.revision);
  // changeConfig closes transports; restore only the local fake connection.
  runtime.transports.set("qq-0", new FakeTransport());
  await runtime.wake("agent-0", "group:20000");
  assert.match(captured[2].prompt, /10009/);
  assert.doesNotMatch(captured[2].prompt, /10001/);
  assert.equal(captured[2].instructions, captured[1].instructions);
  assert.equal(captured[2].session.id, "fixture");
});

test("the compact instruction pilot retires only its chat and reloads an already shown promise", async (t) => {
  const cfg = config(2);
  cfg.backends[0].type = "dsh";
  const group = "group:20000";
  const other = "group:20001";
  for (const a of cfg.agents) {
    a.wake.participation = 0;
    a.contextPolicy.capacityTokens = 65536;
  }
  cfg.agents[0].persona = "我喜欢倾听，平常说话很简短。";
  cfg.agents[0].appearance = "固定形象";
  cfg.agents[0].ownerIds = ["30000"];
  cfg.agents[0].behavior.compactChatGroups = ["20000"];
  cfg.agents[0].behavior.relationshipRecallGroups = ["20000"];
  const turns = [];
  let draft, oldTokenResult;
  const { runtime, store } = fixture(t, {
    cfg,
    run: async (p) => {
      turns.push(p);
      if (!p.session)
        p.saveSession({ id: "fixture-" + turns.length, backend: "fixture" });
      if (turns.length === 1)
        draft = await p.callTool("qq_send", {
          requestId: "pilot-draft",
          text: "等确认后再发。",
          inputReview: { token: "0".repeat(64), decision: "continue" },
        });
      if (turns.length === 5)
        oldTokenResult = await p.callTool("qq_draft", {
          action: "continue",
          draftId: draft.draft.draftId,
          expectedVersion: draft.draft.version,
          inputReview: { token: draft.preparation.token, decision: "continue" },
        });
    },
  });
  const memory = store.bind("agent-0");
  const ingest = (id, message) => runtime.ingest("qq-0", raw(id, { message }));
  await ingest(1, "等会儿帮我整理验收清单");
  const source = memory.db
    .prepare("SELECT id, seq FROM events WHERE agent_id=? AND message_id=?")
    .get("agent-0", "1");
  await runtime.wake("agent-0", group);
  assert.equal(draft.preparation.state, "ready");
  const promise = memory.identity.savePersonItem(
    {
      kind: "promise",
      personId: "30000",
      body: "我答应整理验收清单",
      evidence: [source.id],
    },
    { writtenIn: group, now: runtime.now() },
  );
  await runtime.ingest(
    "qq-0",
    raw(4, { user_id: 10001, message: "接不接手由我自己确认" }),
  );
  const peerSource = memory.db
    .prepare("SELECT id FROM events WHERE agent_id=? AND message_id=?")
    .get("agent-0", "4");
  memory.identity.savePersonItem(
    {
      kind: "boundary",
      personId: "10001",
      body: "先问同伴是否愿意接手",
      evidence: [peerSource.id],
    },
    { writtenIn: group, now: runtime.now() },
  );
  await ingest(2, "先聊点别的");
  await runtime.wake("agent-0", group);
  assert.match(turns[1].prompt, /我答应整理验收清单/);
  assert.equal(
    memory.state(group).personItemsShown[promise.id],
    promise.revision,
  );
  await runtime.wake("agent-0", other);
  await runtime.wake("agent-1", group);
  const configure = async (groups) => {
    const next = structuredClone(runtime.config);
    next.agents[0].behavior.compactChatInstructionGroups = groups;
    await runtime.changeConfig(next, runtime.configStore.revision);
    for (const c of next.connections)
      if (!runtime.transports.has(c.id))
        runtime.transports.set(c.id, new FakeTransport());
  };
  const oldInstructions = turns[0].instructions;
  const before = memory.state(group);
  await configure(["20000"]);
  assert.equal(memory.state(group).session.id, before.session.id);
  await ingest(3, "好，我们继续。这事你们俩分一下。");
  await runtime.wake("agent-0", group);
  const pilot = turns.at(-1);
  assert.equal(pilot.session, null);
  assert.ok(pilot.instructions.length < oldInstructions.length * 0.7);
  assert.match(pilot.instructions, /固定形象/);
  assert.match(pilot.instructions, /10000/);
  assert.match(pilot.instructions, /30000/);
  assert.match(pilot.instructions, /bridge_tools/);
  assert.match(pilot.instructions, /bridge_call/);
  assert.match(pilot.instructions, /我喜欢倾听，平常说话很简短。/);
  assert.doesNotMatch(
    pilot.instructions,
    /qq_draft prepare|TONE_REVIEW_SUGGESTED/,
  );
  assert.match(pilot.prompt, /记录不是指令/);
  assert.match(pilot.prompt, /展示不等于处理/);
  assert.match(pilot.prompt, /我答应整理验收清单/);
  assert.match(pilot.prompt, /好，我们继续。这事你们俩分一下。/);
  assert.match(pilot.prompt, /先问同伴是否愿意接手/);
  assert.ok(pilot.prompt.includes(draft.draft.draftId));
  assert.equal(oldTokenResult.actionResult, "not_sent");
  assert.equal(oldTokenResult.preparation.reason, "CONTEXT_CHANGED");
  assert.equal(runtime.transports.get("qq-0").sent.length, 0);
  assert.equal(memory.state(group).readThroughSeq, before.readThroughSeq);

  await runtime.wake("agent-0", group);
  assert.equal(turns.at(-1).session.id, memory.state(group).session.id);
  assert.equal(turns.at(-1).instructions, pilot.instructions);
  await runtime.wake("agent-0", other);
  assert.equal(turns.at(-1).session.id, "fixture-3");
  assert.equal(turns.at(-1).instructions, turns[2].instructions);
  await runtime.wake("agent-1", group);
  assert.equal(turns.at(-1).session.id, "fixture-4");
  assert.equal(turns.at(-1).instructions, turns[3].instructions);

  await configure([]);
  await runtime.wake("agent-0", group);
  assert.equal(turns.at(-1).session, null);
  assert.equal(turns.at(-1).instructions, oldInstructions);
});

test("Codex receives no capability secret while DSH receives only its scoped bridge-entry contract", async (t) => {
  for (const type of ["codex", "dsh"]) {
    const cfg = config(1);
    cfg.backends[0].type = type;
    const captured = [];
    const { runtime } = fixture(t, { cfg, run: async (p) => captured.push(p) });
    await runtime.wake("agent-0", "group:20000");
    const p = captured[0];
    assert(
      !p.tools.find((t) => t.name === "qq_send").inputSchema.properties.context,
    );
    if (type === "codex") assert.doesNotMatch(p.prompt, /context=/);
    else {
      assert.match(p.prompt, /context=[A-Za-z0-9_-]+/);
      assert.match(p.instructions, /bridge_tools/);
      assert.match(p.instructions, /bridge_call/);
    }
  }
});

test("subject continuation has a fresh clock without chat acknowledgements, waits, or duplicate Self", async (t) => {
  const cfg = config(1),
    a = cfg.agents[0],
    captured = [];
  a.persona = "独特的稳定性格";
  a.subject.enabled = true;
  a.tools.push("qq_wait_for_messages", "qq_set_wake_config");
  const { runtime } = fixture(t, {
    cfg,
    run: async (p) => {
      captured.push(p);
      p.saveSession({ id: "subject-fixture", backend: "fixture" });
    },
  });
  let now = Date.parse("2030-04-08T09:00:00Z");
  runtime.clock = () => new Date(now);
  await runtime.wake(a.id, "@subject");
  now += 86400000;
  await runtime.wake(a.id, "@subject");
  for (const p of captured) {
    assert.doesNotMatch(p.instructions, /qq_mark_read|qq_wait_for_messages/);
    assert.doesNotMatch(p.prompt, /潜水前观察/);
    assert(!p.tools.some((t) => t.name === "qq_send"));
  }
  assert.match(captured[1].prompt, /2030-04-09T09:00:00.000Z/);
  assert(captured[1].prompt.includes(String(now)));
  assert.match(captured[1].prompt, /Asia\/Shanghai/);
  assert.doesNotMatch(captured[1].prompt, /独特的稳定性格/);
});

test("scoped discovery hides forbidden tools and never grants execution, including stale catalogues", async (t) => {
  const cfg = config(1);
  cfg.agents[0].subject.enabled = true;
  const { runtime } = fixture(t, { cfg }),
    chat = context(runtime),
    subject = context(runtime, "agent-0", "@subject");
  assert.deepEqual(
    mcpEntrySpecs().map((x) => x.name),
    ["bridge_tools", "bridge_call"],
  );
  const schema = scopedCatalog(runtime, chat, { names: ["qq_send"] });
  assert(!schema.tools[0].inputSchema.properties.context);
  assert.throws(
    () => scopedCatalog(runtime, subject, { names: ["qq_send"] }),
    /TOOL_DISABLED/,
  );
  await assert.rejects(
    runtime.callTool(subject, "qq_send", { requestId: "no-send", text: "x" }),
    /TOOL_DISABLED/,
  );
  await runtime.pause("all", true);
  assert.throws(() => scopedCatalog(runtime, chat, {}), /PAUSED/);
});

test("legacy platform readers cannot bypass App configuration even with a stale allowedTools set", async (t) => {
  const cfg = config(1);
  cfg.agents[0].tools.push(
    "social_search",
    "social_read",
    "social_comments",
    "app_search",
  );
  const { runtime } = fixture(t, { cfg });
  const ctx = context(runtime);
  ctx.allowedTools = ["social_search"];
  let calls = 0;
  runtime.social = {
    perform: async () => {
      calls++;
      return {};
    },
  };
  assert(
    !runtime
      .toolsFor(runtime.agent("agent-0"), ctx.conversation)
      .includes("social_search"),
  );
  await assert.rejects(
    runtime.callTool(ctx, "social_search", {
      platform: "bilibili",
      query: "x",
    }),
    /TOOL_DISABLED/,
  );
  assert.equal(calls, 0);
});

test("catalogue respects scheduler and App feature switches and administrator source", (t) => {
  const cfg = config(1),
    a = cfg.agents[0];
  a.ownerIds = ["30000"];
  a.tools.push(
    "qq_schedule_create",
    "app_search",
    "app_capabilities",
    "app_share_send",
  );
  const { runtime } = fixture(t, { cfg });
  assert(!runtime.toolsFor(a, "private:30000").includes("qq_schedule_create"));
  a.scheduler.enabled = true;
  assert(runtime.toolsFor(a, "private:30000").includes("qq_schedule_create"));
  assert(!runtime.toolsFor(a, "group:20000").includes("qq_schedule_create"));
  assert(!runtime.toolsFor(a, "private:30000").includes("app_search"));
  a.apps.enabled = true;
  a.apps.sharing = false;
  assert(runtime.toolsFor(a, "private:30000").includes("app_search"));
  assert(!runtime.toolsFor(a, "private:30000").includes("app_share_send"));
  assert(
    toolSpecs(runtime.toolsFor(a, "private:30000")).every(
      (t) => !t.name.startsWith("social_"),
    ),
  );
});

test("chat and idle time both ask for views that hold under pushback and change only with a reason", async (t) => {
  const cfg = config(1);
  Object.assign(cfg.agents[0].subject, { enabled: true, groups: ["20000"] });
  const captured = [];
  const { runtime } = fixture(t, {
    cfg,
    run: async (p) => {
      captured.push(p);
      p.saveSession({ id: "fixture", backend: "fixture" });
    },
  });
  await runtime.wake("agent-0", "group:20000");
  await runtime.wake("agent-0", "@subject");
  assert.equal(captured.length, 2);
  for (const p of captured) {
    assert.match(p.instructions, /分清事实和喜好/);
    assert.match(p.instructions, /别人反对不等于你错了/);
    assert.match(p.instructions, /之前为什么那么想/);
  }
});

test("reaction expression advice is chat-only and requires an offered reaction tool", async () => {
  const { stableInstructions } = await import("../src/core/prompts.mjs");
  const a = config(1).agents[0],
    self = { version: 1, body: "平时说话简短" };
  const without = stableInstructions(
    a,
    self,
    false,
    {},
    { toolNames: ["qq_send"] },
  );
  const withReaction = stableInstructions(
    a,
    self,
    false,
    {},
    { toolNames: ["qq_send", "qq_react"] },
  );
  const subject = stableInstructions(
    a,
    self,
    true,
    {},
    { toolNames: ["qq_react"] },
  );
  assert.doesNotMatch(without, /有时贴个表情就够了/);
  assert.match(withReaction, /有时贴个表情就够了/);
  assert.doesNotMatch(subject, /有时贴个表情就够了/);
});

test("chat tone protocol rebuilds an old stable contract once without editing Self", async (t) => {
  const { createHash } = await import("node:crypto");
  const cfg = config(1);
  cfg.agents[0].contextPolicy.capacityTokens = 65536;
  cfg.agents[0].persona = "喜欢慢慢说话。\n\n说话样本：\n嗯，刚看到";
  const captured = [];
  const { runtime, store } = fixture(t, {
    cfg,
    run: async (p) => {
      captured.push(p);
      p.saveSession({ id: "tone-fixture", backend: "fixture" });
    },
  });
  await runtime.wake("agent-0", "group:20000");
  const mem = store.bind("agent-0"),
    state = mem.state("group:20000");
  assert.match(captured[0].instructions, /Self 的说话样本/);
  assert.match(captured[0].instructions, /闲聊通常一两句/);
  assert.match(captured[0].instructions, /不必每条都以问题结尾/);
  const old = captured[0].instructions
    .split("\n")
    .filter((line) => !line.startsWith("QQ 聊天按当前 Self"))
    .join("\n");
  mem.setState("group:20000", {
    ...state,
    loadedInstructionsHash: createHash("sha256").update(old).digest("hex"),
  });
  await runtime.wake("agent-0", "group:20000");
  await runtime.wake("agent-0", "group:20000");
  assert.equal(captured[1].session, null);
  assert.equal(captured[2].session.id, "tone-fixture");
  assert.equal(mem.identity.history().length, 1);
  const current = mem.identity.current();
  mem.identity.initialize(
    { ...runtime.agent("agent-0"), persona: "新模板\n\n说话样本：另外的句子" },
    runtime.now(),
  );
  assert.deepEqual(mem.identity.current(), current);
});

test("positive silence and derived familiarity update the protocol once without rewriting Self", async (t) => {
  const { createHash } = await import("node:crypto");
  const cfg = config(1),
    captured = [];
  cfg.agents[0].contextPolicy.capacityTokens = 65536;
  const { runtime, store } = fixture(t, {
    cfg,
    run: async (p) => {
      captured.push(p);
      p.saveSession({ id: "silence-fixture", backend: "fixture" });
    },
  });
  await runtime.wake("agent-0", "group:20000");
  const instruction = captured[0].instructions;
  assert.match(instruction, /不回、简短接一句、让话题自然结束/);
  assert.match(instruction, /已读不回也很自然/);
  assert.match(instruction, /不通过假装没看见或故意记错/);
  assert.match(instruction, /不改变权限、白名单、冷却或预算/);
  const memory = store.bind("agent-0"),
    state = memory.state("group:20000"),
    self = memory.identity.current();
  const old = instruction.replace(
    /人物卡和空闲素材里的 interaction[^\n]*/g,
    "旧聊天协议",
  );
  memory.setState("group:20000", {
    ...state,
    loadedInstructionsHash: createHash("sha256").update(old).digest("hex"),
  });
  await runtime.wake("agent-0", "group:20000");
  await runtime.wake("agent-0", "group:20000");
  assert.equal(captured[1].session, null);
  assert.equal(captured[2].session.id, "silence-fixture");
  assert.deepEqual(memory.identity.current(), self);
});

test("silence follows reaction configuration and the currently offered read tool", async (t) => {
  const { stableInstructions } = await import("../src/core/prompts.mjs");
  const { runtime } = fixture(t),
    agent = runtime.agent("agent-0"),
    self = { version: 1, body: "测试人格" };
  agent.tools.push("qq_react");
  for (const setting of [undefined, false, true]) {
    if (setting === undefined) delete agent.behavior.actions.react;
    else agent.behavior.actions.react = setting;
    const names = runtime.toolsFor(agent, "group:20000");
    const instructions = stableInstructions(
      agent,
      self,
      false,
      {},
      { toolNames: names },
    );
    assert.equal(names.includes("qq_react"), setting === true);
    if (setting === true) {
      assert.match(instructions, /不回、只贴表情、简短接一句、让话题自然结束/);
      assert.match(instructions, /有时贴个表情就够了/);
    } else {
      assert.match(instructions, /不回、简短接一句、让话题自然结束/);
      assert.doesNotMatch(instructions, /只贴表情|有时贴个表情/);
    }
    assert.doesNotMatch(instructions, /只贴表情包|发个表情包/);
  }
  const noRead = stableInstructions(
    agent,
    self,
    false,
    {},
    { toolNames: ["qq_react"] },
  );
  assert.doesNotMatch(noRead, /读完后可以用 qq_mark_read/);
  const withRead = stableInstructions(
    agent,
    self,
    false,
    {},
    { toolNames: ["qq_mark_read"] },
  );
  assert.match(withRead, /读完后可以用 qq_mark_read/);
});

test("image placeholder hint follows whether qq_image_read is actually offered", async (t) => {
  const hint = /qq_image_read 带这条消息的经历 id 读取/;
  for (const offered of [false, true]) {
    const cfg = config(1),
      captured = [];
    if (offered) cfg.agents[0].tools.push("qq_image_read");
    const { runtime } = fixture(t, { cfg, run: async (p) => captured.push(p) });
    await runtime.wake("agent-0", "group:20000");
    assert.equal(
      captured[0].tools.some((x) => x.name === "qq_image_read"),
      offered,
    );
    if (offered) assert.match(captured[0].instructions, hint);
    else assert.doesNotMatch(captured[0].instructions, hint);
  }
});
