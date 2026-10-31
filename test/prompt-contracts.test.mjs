import test from "node:test";
import assert from "node:assert/strict";
import { config, fixture, context, FakeTransport } from "./helpers.mjs";
import { toolSpecs } from "../src/tools/index.mjs";
import { mcpEntrySpecs, scopedCatalog } from "../src/tools/catalog.mjs";

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
