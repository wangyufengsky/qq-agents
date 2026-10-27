import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { fixture, config } from "./helpers.mjs";
import { createServer } from "../src/server.mjs";
import { configImpact } from "../src/core/config-impact.mjs";

const enabled = (edit = () => {}) => {
  const c = config(1);
  c.agents[0].subject.enabled = true;
  c.agents[0].subject.groups = ["20000"];
  c.agents[0].subject.intervalMs = 60000;
  c.agents[0].behavior.preSleepWaitMs = 0;
  edit(c.agents[0]);
  return c;
};
const turns = (f) =>
  f.store
    .bind("agent-0")
    .identity.list("model_turns")
    .filter((t) => t.conversation === "@subject")
    .sort((a, b) => a.startedAt - b.startedAt);

test("free-time turns are framed as own time, get materials and can log", async (t) => {
  const seen = [];
  const f = fixture(t, {
    cfg: enabled(),
    run: async (p) => {
      seen.push(p);
      p.saveSession({ id: "s" + seen.length, backend: "fixture" });
      if (p.conversation !== "@subject") return;
      await p.callTool("subject_log", {
        did: "browsed",
        summary: "看了 B 站热门，发现一个讲独立游戏的视频",
        found: [{ title: "独立游戏开发日志" }],
        next: "看看这个作者的其他视频",
      });
    },
  });
  await f.runtime.wake("agent-0", "@subject");
  const first = seen[0];
  assert.match(first.instructions, /空闲时间/);
  assert.doesNotMatch(first.instructions, /可不行动/);
  assert.match(first.prompt, /空闲时间素材：/);
  assert.doesNotMatch(first.prompt, /新增消息：/);
  assert(first.tools.some((x) => x.name === "subject_log"));

  await f.runtime.wake("agent-0", "@subject");
  const second = seen[1];
  // A new session each wake, continuity through the log in the materials.
  assert.equal(second.session ?? null, null);
  assert.match(second.prompt, /独立游戏开发日志/);
  assert.match(second.prompt, /看看这个作者的其他视频/);
  const history = f.store
    .bind("agent-0")
    .identity.list("session_history")
    .map((s) => s.reason);
  assert(history.includes("subject-fresh-session"));
  const [, latest] = turns(f);
  assert.equal(latest.initialSession, true);
  assert.deepEqual(
    latest.toolCalls.map(({ name, ok }) => ({ name, ok })),
    [{ name: "subject_log", ok: true }],
  );
});

test("continuous mode keeps the previous subject session", async (t) => {
  const seen = [];
  const f = fixture(t, {
    cfg: enabled((a) => (a.subject.sessionMode = "continuous")),
    run: async (p) => {
      seen.push(p);
      p.saveSession({ id: "kept", backend: "fixture" });
    },
  });
  await f.runtime.wake("agent-0", "@subject");
  await f.runtime.wake("agent-0", "@subject");
  assert.equal(seen[1].session?.id, "kept");
});

test("tool calls are traced by name and outcome without arguments", async (t) => {
  const f = fixture(t, {
    cfg: enabled(),
    run: async (p) => {
      await p.callTool("memory_search", { query: "私密关键词" });
      await assert.rejects(p.callTool("not_a_tool", {}));
    },
  });
  await f.runtime.wake("agent-0", "group:20000");
  const turn = f.store
    .bind("agent-0")
    .identity.list("model_turns")
    .find((x) => x.conversation === "group:20000");
  assert.deepEqual(
    turn.toolCalls.map(({ name, ok, code }) => ({ name, ok, code })),
    [
      { name: "memory_search", ok: true, code: undefined },
      { name: "not_a_tool", ok: false, code: "TOOL_DISABLED" },
    ],
  );
  assert.doesNotMatch(JSON.stringify(turn.toolCalls), /私密关键词/);
});

test("the per-turn tool cap stops extra calls but never the log", async (t) => {
  const outcomes = [];
  const f = fixture(t, {
    cfg: enabled((a) => (a.subject.maxToolCallsPerTurn = 2)),
    run: async (p) => {
      if (p.conversation !== "@subject") return;
      for (let i = 0; i < 3; i++)
        outcomes.push(
          await p.callTool("memory_search", { query: "x" }).then(
            () => "ok",
            (e) => e.message,
          ),
        );
      outcomes.push(
        await p
          .callTool("subject_log", {
            did: "rested",
            summary: "额度用完，先休息",
            restReason: "budget",
          })
          .then(() => "logged"),
      );
    },
  });
  await f.runtime.wake("agent-0", "@subject");
  assert.deepEqual(outcomes, ["ok", "ok", "SUBJECT_TOOL_BUDGET", "logged"]);
});

test("resting needs a reason and chats cannot write the subject log", async (t) => {
  const results = [];
  const f = fixture(t, {
    cfg: enabled(),
    run: async (p) => {
      results.push(
        await p
          .callTool("subject_log", { did: "rested", summary: "休息" })
          .then(
            () => "ok",
            (e) => e.message,
          ),
      );
    },
  });
  await f.runtime.wake("agent-0", "@subject");
  await f.runtime.wake("agent-0", "group:20000");
  assert.deepEqual(results, ["SUBJECT_LOG_REQUIRES_REASON", "TOOL_DISABLED"]);
  assert(
    !f.runtime
      .toolsFor(f.runtime.agent("agent-0"), "group:20000")
      .includes("subject_log"),
  );
});

test("console shows the free-time log and 24-hour activity", async (t) => {
  const f = fixture(t, {
    cfg: enabled(),
    run: async (p) => {
      if (p.conversation !== "@subject") return;
      await p.callTool("memory_search", { query: "x" });
      await p.callTool("subject_log", {
        did: "searched",
        summary: "查了一个问题",
      });
    },
  });
  await f.runtime.wake("agent-0", "@subject");
  const token = randomBytes(32).toString("hex"),
    app = createServer({ runtime: f.runtime, token });
  const port = await app.listen();
  t.after(() => app.close());
  const data = await (
    await fetch(`http://127.0.0.1:${port}/api/mind?agentId=agent-0`, {
      headers: { "x-admin-token": token },
    })
  ).json();
  assert.equal(data.subject.logs[0].summary, "查了一个问题");
  assert.deepEqual(data.subject.stats24h, {
    turns: 1,
    active: 1,
    logged: 1,
    toolCalls: 1,
    traced: 1,
  });
});

test("live subject settings do not count as agent policy changes", () => {
  const before = enabled();
  const after = structuredClone(before);
  after.agents[0].subject.maxToolCallsPerTurn = 12;
  after.agents[0].subject.sessionMode = "continuous";
  assert.equal(configImpact(before, after).agentIds.size, 0);
});
