import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createServer } from "../src/server.mjs";
import { deriveRelayToken } from "../src/core/relay-auth.mjs";
import { scopedCatalog } from "../src/tools/catalog.mjs";
import { dreamAgentProfile } from "../src/core/functional-agents.mjs";
import { DreamScheduler } from "../src/dream/scheduler.mjs";
import { sampleStoryMaterial, storyPatch } from "../src/dream/story.mjs";
import { config, fixture } from "./helpers.mjs";

const role = "agent-0";
const minute = 60000;
const story = {
  schemaVersion: 1,
  title: "纸月茶会",
  narrative: "纸月在桥边弯成了小船，邀请陌生旅人喝茶。",
  reflection: "梦醒后想起小小的善意。",
  themes: ["月亮", "茶"],
  inspirations: [{ kind: "diary", content: "可以写一篇关于失而复得的小记。" }],
};
const empty = {
  schemaVersion: 1,
  operations: [],
  awakeningSummary: "",
  noChangesReason: "没有新增认知。",
};
function configured(count = 1) {
  const cfg = config(count);
  for (const agent of cfg.agents) {
    agent.dream.enabled = true;
    agent.dream.imaginative.enabled = true;
    agent.behavior.proactive.timezone = "UTC";
  }
  return cfg;
}
function append(f, dedupe, fields = {}, agentId = role) {
  return f.store.bind(agentId).append({
    dedupe,
    conversation: "group:20000",
    kind: "message.received",
    direction: "in",
    body: "公开群聊正文",
    senderId: "30000",
    connectionId: "qq-0",
    payload: { trustedInput: true },
    ...fields,
  });
}
async function idle(f) {
  while (f.runtime.work.size) await Promise.allSettled([...f.runtime.work]);
}

test("imaginative route inherits mode, dream and backend overrides without enabling cognitive access", () => {
  const cfg = configured(),
    agent = cfg.agents[0];
  const resolve = () => dreamAgentProfile(agent, cfg, "dream-imaginative");
  cfg.backends[0].model = "backend-model";
  cfg.backends[0].effort = "backend-effort";
  assert.equal(resolve().definition.model, "backend-model");
  assert.equal(resolve().definition.effort, "backend-effort");
  cfg.backends.push({
    ...cfg.backends[0],
    id: "dedicated",
    functionalAgentOnly: true,
    provider: "fixture",
    model: "dedicated-model",
  });
  assert.equal(resolve().definition.model, "dedicated-model");
  cfg.backends.push({ ...cfg.backends[1], id: "other-dedicated" });
  assert.equal(resolve().definition.backendId, agent.backendId);
  agent.dream.backendId = "dedicated";
  agent.dream.model = "dream-model";
  agent.dream.effort = "dream-effort";
  assert.equal(resolve().definition.model, "dream-model");
  assert.equal(resolve().definition.backendId, "dedicated");
  assert.equal(resolve().definition.effort, "dream-effort");
  agent.dream.imaginative.model = "imagination-model";
  agent.dream.imaginative.effort = "imagination-effort";
  agent.dream.cognitive.enabled = false;
  assert.equal(resolve().definition.model, "imagination-model");
  assert.equal(resolve().definition.effort, "imagination-effort");
  assert.deepEqual(resolve().definition.tools, ["dream_story_submit"]);
  assert.equal(dreamAgentProfile(agent, cfg), undefined);
});

test("imaginative input provides only coarse safe themes; its transaction never changes cognition or sends anything", async (t) => {
  const cfg = configured();
  let seen;
  const f = fixture(t, {
    cfg,
    run: async (p) => {
      if (!p.conversation.includes("dream-imaginative")) {
        await assert.rejects(
          p.callTool("dream_story_submit", story),
          /TOOL_DISABLED/,
        );
        await p.callTool("dream_cognition_submit", empty);
        return;
      }
      seen = p.prompt;
      assert.equal(p.session, null);
      assert.deepEqual(
        p.tools.map(({ name }) => name),
        ["dream_story_submit"],
      );
      const ctx = f.runtime.capability(/context=(\S+)/.exec(p.prompt)[1]);
      assert.deepEqual(
        scopedCatalog(f.runtime, ctx, { names: ["dream_story_submit"] }).tools,
        p.tools,
      );
      for (const name of [
        "memory_read",
        "memory_search",
        "memory_related",
        "dream_cognition_list",
        "dream_cognition_submit",
        "qq_send",
        "room_publish",
        "garden_act",
        "file_create",
        "web_fetch",
      ]) {
        assert.throws(
          () => scopedCatalog(f.runtime, ctx, { names: [name] }),
          /TOOL_DISABLED/,
        );
        await assert.rejects(p.callTool(name, {}), /TOOL_DISABLED/);
      }
      await assert.rejects(
        p.callTool("dream_story_submit", { ...story, runId: "forged" }),
        /DREAM_INVALID_PATCH/,
      );
      await assert.rejects(
        p.callTool("dream_story_submit", {
          ...story,
          inspirations: [{ kind: "diary", content: "内容", action: "publish" }],
        }),
        /DREAM_INVALID_PATCH/,
      );
      assert.deepEqual(await p.callTool("dream_story_submit", story), {
        status: "accepted",
      });
      await assert.rejects(
        p.callTool("dream_story_submit", story),
        /FUNCTIONAL_AGENT_RESULT_ALREADY_SUBMITTED/,
      );
      p.saveSession({ id: "must-not-persist", backend: "codex" });
    },
  });
  const db = f.store.db,
    mem = f.store.bind(role);
  const publicRow = append(f, "public");
  const desktopRow = append(f, "desktop", {
    conversation: "@desktop",
    body: "桌边资料原文",
  });
  const excluded = [
    append(f, "private", { conversation: "private:30000", body: "私密内容" }),
    append(f, "protected-desktop", {
      conversation: "@desktop",
      body: "桌边私密内容",
      payload: { protectedOperations: true },
    }),
    append(f, "ops", { payload: { protectedOperations: true } }),
    append(f, "repository", {
      payload: { protectedRepositories: ["fixture/repository"] },
    }),
    append(f, "qzone", { payload: { protectedPeerQzoneTargets: ["30000"] } }),
    append(f, "work", { conversation: "@work:fixture" }),
    append(f, "other-agent", {}, "agent-1"),
  ];
  excluded.push(
    mem.diaryWrite({
      title: "依赖私聊",
      body: "不会作为创作主题",
      evidence: [excluded[0].id],
    }),
  );
  const material = sampleStoryMaterial(f.runtime, {
    agentId: role,
    conversation: "@dream",
  });
  assert.deepEqual(
    material.map(({ id }) => id),
    [desktopRow.id, publicRow.id],
  );
  assert.equal((await f.runtime.dreams.run(role)).status, "COMMITTED");
  const checkpoints = db.prepare("SELECT * FROM dream_checkpoints").all();
  const result = await f.runtime.dreams.run(role, {
    mode: "imaginative",
    idempotencyKey: "once",
  });
  assert.equal(result.status, "COMMITTED");
  assert.deepEqual(
    await f.runtime.dreams.run(role, {
      mode: "imaginative",
      idempotencyKey: "once",
    }),
    { status: "COMMITTED", runId: result.runId },
  );
  assert.equal(
    seen.split("创作主题（JSON）：\n")[1],
    '["相遇与交谈","桌边相伴"]',
  );
  for (const record of [publicRow, desktopRow, ...excluded])
    assert.ok(!seen.includes(record.id));
  assert.doesNotMatch(
    seen,
    /公开群聊正文|桌边资料原文|桌边私密内容|私密内容|fixture\/repository|30000/,
  );
  const saved = db.prepare("SELECT * FROM imaginative_dreams").get();
  assert.equal(saved.fictional, 1);
  assert.equal(saved.title, story.title);
  assert.deepEqual(JSON.parse(saved.inspirations_json), story.inspirations);
  assert.equal(saved.published_room_slot, null);
  assert.equal(saved.published_at, null);
  assert.equal(saved.inspiration_consumed_at, null);
  assert.deepEqual(
    db.prepare("SELECT * FROM dream_checkpoints").all(),
    checkpoints,
  );
  assert.equal(db.prepare("SELECT count(*) AS n FROM cognitions").get().n, 0);
  assert.equal(db.prepare("SELECT count(*) AS n FROM intentions").get().n, 0);
  assert.equal(f.runtime.transports.get("qq-0").sent.length, 0);
});

test("authenticated DSH-style discovery, call and result receipt expose only the story submission", async (t) => {
  const cfg = configured();
  cfg.agents[0].dream.cognitive.enabled = false;
  let host;
  const admin = randomBytes(32).toString("hex"),
    relay = deriveRelayToken(admin);
  const f = fixture(t, {
    cfg,
    run: async (p) => {
      const capability = /context=(\S+)/.exec(p.prompt)[1];
      const post = (route, body) =>
        fetch(host + route, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-agent-capability": capability,
            "x-agent-output-protocol": "stdio-v1",
            "x-agent-output-request": "story-test",
            "x-agent-relay-token": relay,
          },
          body: JSON.stringify(body),
        });
      const catalog = await post("/agent/catalog", {
        names: ["dream_story_submit"],
      });
      const discovery = JSON.parse((await catalog.json()).content[0].text);
      assert.deepEqual(discovery.tools, p.tools);
      const denied = await post("/agent/tools", {
        name: "memory_read",
        arguments: { id: "synthetic" },
      });
      assert.equal(
        JSON.parse((await denied.json()).content[0].text).code,
        "TOOL_DISABLED",
      );
      const output = await post("/agent/tools", {
        name: "dream_story_submit",
        arguments: story,
      });
      assert.deepEqual(JSON.parse((await output.json()).content[0].text), {
        status: "accepted",
      });
      const receipt = output.headers.get("x-agent-output-receipt"),
        digest = output.headers.get("x-agent-output-digest");
      assert.ok(receipt);
      const ack = await post("/agent/output-ack", {
        receipt,
        digest,
        requestId: "story-test",
      });
      assert.deepEqual(await ack.json(), { accepted: true });
    },
  });
  const server = createServer({ runtime: f.runtime, token: admin });
  host = "http://127.0.0.1:" + (await server.listen());
  t.after(() => server.close());
  const result = await f.runtime.dreams.run(role, { mode: "imaginative" });
  assert.equal(result.status, "COMMITTED");
  assert.equal(
    f.store.db.prepare("SELECT count(*) AS n FROM dream_checkpoints").get().n,
    0,
  );
});

test("unacknowledged, invalid, cancelled and failed stories leave no derived data", async (t) => {
  for (const status of [
    "unacknowledged",
    "invalid",
    "cancel",
    "timeout",
    "failed",
    "source-revoked",
  ])
    await t.test(status, async (t) => {
      const cfg = configured();
      cfg.agents[0].dream.imaginative.timeoutMs =
        status === "timeout" || status === "unacknowledged" ? 80 : 1000;
      const ready = Promise.withResolvers(),
        controller = new AbortController();
      let source;
      const f = fixture(t, {
        cfg,
        run: async (p) => {
          ready.resolve();
          if (status === "cancel" || status === "timeout") {
            await new Promise((resolve) =>
              p.signal.addEventListener("abort", resolve, { once: true }),
            );
            return;
          }
          if (status === "invalid") {
            await assert.rejects(
              p.callTool("dream_story_submit", {
                ...story,
                narrative: "梦".repeat(1201),
              }),
              /DREAM_INVALID_PATCH/,
            );
            return;
          }
          await p.callTool("dream_story_submit", story);
          if (status === "failed") throw Error("ABORTED");
          if (status === "source-revoked")
            f.store.db
              .prepare("UPDATE events SET payload=? WHERE id=?")
              .run(JSON.stringify({ protectedOperations: true }), source.id);
        },
      });
      source = append(f, "source-for-revalidation");
      if (status === "unacknowledged")
        f.runtime.backendFactory = () => ({
          async run(p) {
            p.onInputSubmitted();
            await p.callTool("dream_story_submit", story);
          },
          close() {},
        });
      const run = f.runtime.dreams.run(role, {
        mode: "imaginative",
        signal: controller.signal,
      });
      if (status === "cancel") {
        await ready.promise;
        controller.abort();
      }
      assert.equal(
        (await run).status,
        status === "cancel" ? "CANCELLED" : "FAILED",
      );
      for (const table of [
        "imaginative_dreams",
        "cognitions",
        "dream_checkpoints",
      ])
        assert.equal(
          f.store.db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n,
          0,
        );
    });
});

test("imaginative daily cap, idle limit and a single probabilistic chance after a committed deep run", async (t) => {
  for (const mode of [
    "idle",
    "pass",
    "miss",
    "budget",
    "cognitive-first",
    "disabled",
  ])
    await t.test(mode, async (t) => {
      const cfg = configured(mode === "cognitive-first" ? 2 : 1);
      for (const agent of cfg.agents) {
        agent.dream.imaginative.dailyMax = mode === "idle" ? 2 : 1;
        agent.dream.cognitive.enabled = mode !== "idle";
        agent.dream.cognitive.napMinEvents = 1;
        agent.dream.budget.maxGlobalConcurrency = 1;
      }
      if (mode === "budget") cfg.agents[0].dream.budget.maxRunsPerDay = 1;
      if (mode === "disabled") cfg.agents[0].dream.imaginative.enabled = false;
      if (mode === "cognitive-first")
        cfg.agents[0].dream.cognitive.enabled = false;
      const f = fixture(t, {
        cfg,
        run: (p) =>
          p.conversation.includes("dream-imaginative")
            ? p.callTool("dream_story_submit", story)
            : p.callTool("dream_cognition_submit", empty),
      });
      let now = Date.UTC(2026, 0, 1);
      let draws = 0;
      f.runtime.clock = () => new Date(now);
      f.runtime.random = () => {
        draws++;
        return mode === "miss" ? 0.9 : 0.1;
      };
      f.runtime.dreamScheduler = new DreamScheduler(f.runtime);
      const ticks = async (number) => {
        for (let i = 0; i < number; i++) {
          now += minute;
          await f.runtime.dreamScheduler.tick();
          await idle(f);
        }
      };
      if (["pass", "miss", "budget", "disabled"].includes(mode))
        append(f, "delta");
      if (mode === "cognitive-first")
        append(f, "role-two-delta", {}, "agent-1");
      await ticks(17);
      const runs = () =>
        f.store.db.prepare("SELECT * FROM dream_runs ORDER BY rowid").all();
      if (mode === "idle") {
        assert.deepEqual(
          runs().map(({ mode, trigger }) => [mode, trigger]),
          [["imaginative", "idle"]],
        );
        const receipt = f.runtime.dreams.trigger(role, "imaginative");
        assert.ok(receipt.runId);
        await idle(f);
        assert.throws(
          () => f.runtime.dreams.trigger(role, "imaginative"),
          /DREAM_BUDGET_EXCEEDED/,
        );
      } else if (mode === "pass") {
        assert.deepEqual(
          runs().map(({ mode, trigger }) => [mode, trigger]),
          [
            ["deep", "idle"],
            ["imaginative", "threshold"],
          ],
        );
        assert.equal(draws, 1);
      } else if (mode === "cognitive-first") {
        assert.equal(runs()[0].mode, "deep");
        assert.equal(runs()[0].agent_id, "agent-1");
        assert.ok(runs().some(({ mode }) => mode === "imaginative"));
      } else {
        assert.deepEqual(
          runs().map(({ mode }) => mode),
          ["deep"],
        );
        assert.equal(draws, mode === "miss" ? 1 : 0);
        if (mode === "disabled")
          await assert.rejects(
            f.runtime.dreams.run(role, { mode: "imaginative" }),
            /DREAM_DISABLED/,
          );
      }
    });
});

test("story schema strictly caps titles, reflections, themes and inspirations", () => {
  assert.ok(storyPatch.safeParse(story).success);
  for (const bad of [
    { title: "长".repeat(61) },
    { reflection: "长".repeat(301) },
    { themes: Array(6).fill("星") },
    { inspirations: Array(4).fill(story.inspirations[0]) },
    { inspirations: [{ kind: "other", content: "长".repeat(161) }] },
    { schemaVersion: 2 },
    { fictional: false },
  ])
    assert.equal(storyPatch.safeParse({ ...story, ...bad }).success, false);
});

test("an acknowledged story and the robot's later retelling never supply observed evidence", async (t) => {
  let storyId, outgoing;
  const f = fixture(t, {
    cfg: configured(),
    run: async (params) => {
      if (params.conversation.includes("dream-imaginative")) {
        await params.callTool("dream_story_submit", story);
        return;
      }
      const request = (id, epistemicStatus) => ({
        schemaVersion: 1,
        operations: [
          {
            op: "ADD",
            category: "fact",
            scopeId: "group:20000",
            subjectKey: "fixture:retelling",
            content: "角色曾讲过纸月茶会。",
            reason: "只有角色的转述。",
            evidenceIds: [id],
            epistemicStatus,
            confidence: 0.5,
            importance: 0.5,
          },
        ],
        awakeningSummary: "",
        noChangesReason: null,
      });
      await assert.rejects(
        params.callTool("dream_cognition_submit", request(storyId, "reported")),
        /DREAM_EVIDENCE_NOT_FOUND/,
      );
      await assert.rejects(
        params.callTool(
          "dream_cognition_submit",
          request(outgoing.id, "observed"),
        ),
        /DREAM_SELF_EVIDENCE_ONLY/,
      );
      await params.callTool(
        "dream_cognition_submit",
        request(outgoing.id, "reported"),
      );
    },
  });
  const result = await f.runtime.dreams.run(role, { mode: "imaginative" });
  assert.equal(result.status, "COMMITTED");
  storyId = result.dreamId;
  outgoing = append(f, "retold-story", {
    kind: "message.sent",
    direction: "out",
    status: "confirmed",
    body: "我昨天梦见纸月在桥边弯成小船。",
  });
  assert.equal((await f.runtime.dreams.run(role)).status, "COMMITTED");
  const row = f.store.db
    .prepare("SELECT epistemic_status FROM cognitions")
    .get();
  assert.equal(row.epistemic_status, "reported");
});

test("a late, authenticated story receipt can arrive after the backend reports completion", async (t) => {
  const f = fixture(t, { cfg: configured() });
  let receipt;
  f.runtime.backendFactory = () => ({
    async run(params) {
      params.onInputSubmitted();
      const output = await params.callTool("dream_story_submit", story);
      const encoded = await params.finalizeToolOutput(output, {
        encode: (value) => {
          const wire = JSON.stringify(value);
          return { wire, text: wire };
        },
      });
      receipt = new Promise((resolve) => {
        setImmediate(() =>
          resolve(params.commitToolOutput(encoded.receipt, encoded.wire)),
        );
      });
    },
    close() {},
  });
  const result = await f.runtime.dreams.run(role, { mode: "imaginative" });
  assert.equal(await receipt, true);
  assert.equal(result.status, "COMMITTED");
});

test("a later awake idle interval keeps its own daily chance after the deep dream draw", async (t) => {
  for (const mode of ["miss", "hit", "exhausted"])
    await t.test(mode, async (t) => {
      const cfg = configured(),
        agent = cfg.agents[0];
      agent.dream.imaginative.dailyMax = 2;
      agent.dream.budget.maxRunsPerDay = mode === "exhausted" ? 1 : 6;
      agent.behavior.rhythm = {
        ...agent.behavior.rhythm,
        enabled: true,
        timezone: "UTC",
        sleep: { ...agent.behavior.rhythm.sleep, start: "00:00", end: "01:00" },
      };
      const f = fixture(t, {
        cfg,
        run: (params) =>
          params.conversation.includes("dream-imaginative")
            ? params.callTool("dream_story_submit", story)
            : params.callTool("dream_cognition_submit", empty),
      });
      let now = Date.UTC(2026, 0, 1),
        draws = 0;
      f.runtime.clock = () => new Date(now);
      f.runtime.random = () => {
        draws++;
        return mode === "hit" ? 0.1 : 0.9;
      };
      f.runtime.dreamScheduler = new DreamScheduler(f.runtime);
      const tick = async (minutes) => {
        now += minutes * minute;
        await f.runtime.dreamScheduler.tick();
        await idle(f);
      };
      const fiction = () =>
        f.store.db
          .prepare(
            "SELECT trigger FROM dream_runs WHERE mode='imaginative' ORDER BY rowid",
          )
          .all()
          .map(({ trigger }) => trigger);
      append(f, "sleep-input");
      await tick(10);
      await tick(1);
      await tick(29);
      assert.deepEqual(fiction(), mode === "hit" ? ["threshold"] : []);
      assert.equal(draws, mode === "exhausted" ? 0 : 1);
      // Simply reaching the end of sleep cannot substitute for a new wake interval.
      await tick(22);
      assert.deepEqual(fiction(), mode === "hit" ? ["threshold"] : []);
      f.runtime.dreamScheduler.activity(role);
      await tick(14);
      assert.deepEqual(fiction(), mode === "hit" ? ["threshold"] : []);
      await tick(1);
      await tick(5);
      assert.deepEqual(
        fiction(),
        mode === "hit"
          ? ["threshold", "idle"]
          : mode === "miss"
            ? ["idle"]
            : [],
      );
      assert.equal(draws, mode === "exhausted" ? 0 : 1);
    });
});
