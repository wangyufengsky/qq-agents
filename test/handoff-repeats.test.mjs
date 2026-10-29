import test from "node:test";
import assert from "node:assert/strict";
import { fixture, config, context } from "./helpers.mjs";
import { sourceHandoff } from "../src/core/context-handoff.mjs";

const scope = "group:20000";
const event = (m, n, body) =>
  m.append({
    dedupe: "e" + n,
    conversation: scope,
    kind: "message.received",
    body,
    senderId: "30000",
    occurredAt: `2026-10-${String(20 + n).padStart(2, "0")}T00:00:00Z`,
  });
const count = (text, part) => text.split(part).length - 1;

function chat(t) {
  const prompts = [];
  const f = fixture(t, {
    run: async (p) => {
      prompts.push(p.prompt);
      p.saveSession({ id: "s" + prompts.length, backend: "fixture" });
      if (prompts.length === 1)
        await p.callTool("qq_send", {
          requestId: "once",
          text: "只说一遍的回复",
        });
    },
  });
  return { ...f, prompts, m: f.store.bind("agent-0") };
}

test("a confirmed send reaches the model once while read progress covers both records", async (t) => {
  const f = chat(t);
  event(f.m, 1, "来信一");
  await f.runtime.wake("agent-0", scope);
  const ctx = context(f.runtime);
  const page = await f.runtime.callTool(ctx, "conversation_read", {
    afterSeq: 0,
  });
  const [attempt, sent] = page.items.slice(-2);
  assert.equal(attempt.type, "message.send-attempt");
  assert.equal(attempt.body, undefined);
  assert.deepEqual(
    { id: attempt.outcome.id, type: attempt.outcome.type },
    { id: sent.id, type: "message.sent" },
  );
  assert.equal(sent.body, "只说一遍的回复");
  assert.equal(count(JSON.stringify(page), "只说一遍的回复"), 1);
  // The attempt still counts as shown, so nothing blocks marking it read.
  await f.runtime.callTool(ctx, "qq_mark_read", { throughSeq: sent.seq });
  // The console keeps reading the plain archive.
  const archive = f.m.conversation({ conversation: scope });
  assert.equal(count(JSON.stringify(archive), "只说一遍的回复"), 2);

  // A fresh session gets the reply once, as the outcome record.
  f.runtime.contexts.retire("agent-0", scope, "test");
  event(f.m, 2, "来信二");
  await f.runtime.wake("agent-0", scope);
  const prompt = f.prompts[1];
  assert.match(prompt, /程序交接状态/);
  assert.equal(count(prompt, "只说一遍的回复"), 1);
  const handoff = f.runtime.contexts.handoff("agent-0", scope);
  const ids = handoff.continuity.sources.map((s) => s.id);
  assert(ids.includes(sent.id));
  assert(!ids.includes(attempt.id));
});

test("handoff sources already in the new messages are not listed again", async (t) => {
  const f = chat(t);
  event(f.m, 1, "来信一");
  await f.runtime.wake("agent-0", scope);
  await f.runtime.callTool(context(f.runtime), "conversation_read", {
    afterSeq: 0,
  });
  // Nothing was marked read: the new session's messages repeat every source.
  f.runtime.contexts.retire("agent-0", scope, "test");
  event(f.m, 2, "来信二");
  await f.runtime.wake("agent-0", scope);
  const prompt = f.prompts[1];
  assert.equal(count(prompt, "只说一遍的回复"), 1);
  assert.equal(count(prompt, "来信一"), 1);
  const handoff = JSON.parse(
    prompt.split("程序交接状态：")[1].split("\n\n新增消息：")[0],
  );
  assert.deepEqual(handoff.continuity.sources, []);
  assert.match(handoff.continuity.notice, /不再重复/);
});

test("handoffs saved before this change map both halves of a send to its outcome", async (t) => {
  const f = chat(t);
  event(f.m, 1, "来信一");
  await f.runtime.wake("agent-0", scope);
  const rows = f.m.conversation({ conversation: scope }).items;
  const attempt = rows.find((r) => r.type === "message.send-attempt"),
    sent = rows.find((r) => r.type === "message.sent");
  f.m.setState(scope, {
    ...f.m.state(scope),
    continuity: { anchors: [], recent: [attempt.id, sent.id] },
  });
  const { sources } = sourceHandoff(f.m, scope);
  assert.deepEqual(
    sources.map((s) => s.id),
    [sent.id],
  );
  assert.equal(sources[0].excerpt, "只说一遍的回复");
});

test("free time lists an intent once, with its history, instead of again under shares", async (t) => {
  const prompts = [];
  const cfg = config(1);
  Object.assign(cfg.agents[0].subject, {
    enabled: true,
    groups: ["20000"],
    intervalMs: 60000,
  });
  const f = fixture(t, {
    cfg,
    run: async (p) => {
      prompts.push(p.prompt);
    },
  });
  const ctx = context(f.runtime);
  const intent = f.runtime.subject.create(ctx, {
    topic: "分享一篇独立游戏的文章",
    target: scope,
    reason: "上次聊到过",
    background: "",
    evidence: [],
    expiresAt: f.runtime.now() + 100000,
    expectsResponse: true,
  });
  await f.runtime.wake("agent-0", "@subject");
  const [prompt] = prompts;
  assert.equal(count(prompt, "分享一篇独立游戏的文章"), 1);
  const handoff = JSON.parse(
      prompt.split("程序交接状态：")[1].split("\n\n空闲时间素材：")[0],
    ),
    materials = JSON.parse(prompt.split("空闲时间素材：")[1]);
  const listed = handoff.intents.find((i) => i.id === intent.id);
  assert(Array.isArray(listed.history));
  assert(!handoff.recentContacts.some((i) => i.id === intent.id));
  assert(!materials.shares.some((i) => i.id === intent.id));
});
