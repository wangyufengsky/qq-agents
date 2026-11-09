import test from "node:test";
import assert from "node:assert/strict";
import { config, context, fixture, raw, settle } from "./helpers.mjs";
import { rhythmStatus } from "../src/core/rhythm.mjs";

const agentId = "agent-0";
const group = "group:20000";
const other = "group:20001";
const owner = "private:30000";
const subject = "@subject";

function setup(t, run) {
  const cfg = config(2);
  Object.assign(cfg.agents[0].subject, { enabled: true, inboxEnabled: true });
  cfg.agents[0].ownerIds = ["30000"];
  const f = fixture(t, { cfg, run });
  let now = Date.now();
  f.runtime.clock = () => new Date(now);
  return { ...f, advance: (ms) => (now += ms), memory: f.store.bind(agentId) };
}

const submission = (requestId, proposal, usefulUntil) => ({
  requestId,
  proposal,
  usefulUntil,
});
const resolve = (id, action, args) => ({
  id,
  expectedRevision: 1,
  action,
  ...args,
});

test("a submitted proposal waits for active chats and appears once in the next subject turn", async (t) => {
  const otherReady = Promise.withResolvers(),
    release = Promise.withResolvers();
  const prompts = [];
  const f = setup(t, async (p) => {
    if (p.conversation === other) {
      otherReady.resolve();
      await release.promise;
    } else if (p.conversation === group) {
      const args = submission("rest-after-chat", {
        kind: "rest",
        durationMs: 3600000,
      });
      const receipt = await p.callTool("subject_inbox_submit", args);
      assert.deepEqual(await p.callTool("subject_inbox_submit", args), {
        ...receipt,
        duplicate: true,
      });
      await assert.rejects(
        p.callTool("subject_inbox_submit", {
          ...args,
          proposal: { kind: "rest", durationMs: 60000 },
        }),
        /IDEMPOTENCY_CONFLICT/,
      );
      await p.callTool(
        "subject_inbox_submit",
        submission("second-proposal", { kind: "rest" }),
      );
    } else {
      prompts.push(p.prompt);
    }
  });
  t.after(release.resolve);
  const busy = f.runtime.wake(agentId, other);
  await otherReady.promise;
  try {
    await f.runtime.wake(agentId, group);
    assert.equal(prompts.length, 0);
    f.runtime.tick();
    assert.equal(prompts.length, 0);
  } finally {
    release.resolve();
  }
  await busy;
  await settle(f.runtime);
  assert.equal(prompts.length, 1);
  assert.match(prompts[0], /rest-after-chat/);
  assert.match(prompts[0], /second-proposal/);
  f.runtime.tick();
  await settle(f.runtime);
  assert.equal(prompts.length, 1);
  const list = await f.runtime.callTool(
    context(f.runtime, agentId, subject),
    "subject_inbox_list",
    {},
  );
  assert.equal(list.items.length, 2);
});

test("soft freshness is advisory, and accepted contact is handed to the target without the source note", async (t) => {
  const note = "从源聊天得来的私下备注";
  let accepted, targetPrompt;
  const f = setup(t, async (p) => {
    if (p.conversation === subject) {
      const list = await p.callTool("subject_inbox_list", {});
      assert.equal(list.items[0].pastUsefulUntil, true);
      assert.ok(list.items[0].ageMs >= 2000);
      assert.equal(list.items[0].proposal.note, note);
      const args = resolve(list.items[0].id, "contact", {
        expiresAt: f.runtime.now() + 60000,
      });
      accepted = await p.callTool("subject_inbox_decide", args);
      const retry = await p.callTool("subject_inbox_decide", args);
      assert.equal(retry.contactIntentId, accepted.contactIntentId);
    } else {
      targetPrompt = p.prompt;
    }
  });
  await f.runtime.callTool(
    context(f.runtime),
    "subject_inbox_submit",
    submission(
      "contact",
      { kind: "contact", target: owner, note },
      f.runtime.now() + 1000,
    ),
  );
  f.advance(2000);
  f.runtime.tick();
  await settle(f.runtime);
  assert.equal(accepted.status, "accepted");
  assert.equal(f.memory.identity.list("intentions").length, 1);
  assert.equal(targetPrompt, undefined);
  f.runtime.tick();
  await settle(f.runtime);
  assert.match(targetPrompt, /主人格决定主动问候/);
  assert.doesNotMatch(targetPrompt, /从源聊天得来的私下备注/);
  assert.equal(f.runtime.transports.get("qq-0").sent.length, 0);
});

test("handoff is bound to the submitting chat and reads the current note only when taken", async (t) => {
  const f = setup(t);
  const original = context(f.runtime);
  const source = f.memory.append({
    conversation: group,
    connectionId: "qq-0",
    dedupe: "work-note-source",
    kind: "message.received",
    direction: "in",
    body: "先核对示例",
  });
  const note = await f.runtime.callTool(original, "work_note", {
    body: "接着整理两份示例",
    uncertainty: "先核对第二份",
    evidence: [source.id],
  });
  const args = submission("handoff", {
    kind: "handoff",
    reference: { type: "work-note", id: note.id },
  });
  await assert.rejects(
    f.runtime.callTool(
      context(f.runtime, agentId, other),
      "subject_inbox_submit",
      args,
    ),
    /RECORD_NOT_FOUND/,
  );
  const submitted = await f.runtime.callTool(
    original,
    "subject_inbox_submit",
    args,
  );
  await f.runtime.callTool(original, "work_note", {
    id: note.id,
    body: "先整理第一份示例",
    uncertainty: "第二份待核对",
    evidence: [source.id],
  });
  const review = resolve(submitted.id, "take");
  await assert.rejects(
    f.runtime.callTool(original, "subject_inbox_decide", review),
    /TOOL_DISABLED/,
  );
  const ctx = context(f.runtime, agentId, subject);
  const taken = await f.runtime.callTool(ctx, "subject_inbox_decide", review);
  assert.equal(taken.reference.body, "先整理第一份示例");
  assert.ok(ctx.privateRead.has(note.id));
  assert.deepEqual(
    await f.runtime.callTool(ctx, "subject_inbox_decide", review),
    taken,
  );
  assert.equal(
    (await f.runtime.callTool(ctx, "subject_inbox_list", {})).items.length,
    0,
  );
});

test("autonomous rest starts after the current turn, archives ordinary inputs and resumes after its deadline", async (t) => {
  const prompts = [];
  const f = setup(t, async (p) => {
    if (p.conversation === subject) {
      const planned = await p.callTool("subject_rest", {
        durationMs: 60000,
        earlyWake: "none",
      });
      assert.equal(planned.until, null);
      assert.equal(
        rhythmStatus(f.runtime, f.runtime.agent(agentId)).state,
        "rest-pending",
      );
      await f.runtime.ingest("qq-0", raw(1));
      f.advance(5000);
      f.runtime.tick();
      assert.equal(prompts.length, 0);
    } else {
      prompts.push(p.prompt);
    }
  });
  await f.runtime.wake(agentId, subject);
  f.runtime.tick();
  const a = f.runtime.agent(agentId);
  assert.equal(rhythmStatus(f.runtime, a).until, f.runtime.now() + 60000);
  await f.runtime.ingest(
    "qq-0",
    raw(2, {
      message: [{ type: "text", data: { text: "这是休息时的第二条消息" } }],
    }),
  );
  assert.equal(f.memory.state(group).readThroughSeq || 0, 0);
  assert.equal(f.memory.state(group).wakeDueAt, f.runtime.now() + 60000);
  assert.equal(prompts.length, 0);
  f.advance(60000);
  f.runtime.tick();
  await settle(f.runtime);
  assert.equal(prompts.length, 1);
  assert.match(prompts[0], /这是休息时的第二条消息/);
  assert.match(prompts[0], /刚起床/);
  assert.equal(f.memory.state(group).readThroughSeq || 0, 0);
  assert.equal(f.runtime.transports.get("qq-0").sent.length, 0);
});

test("early waking requires a newly received allowed message, and respects pause and disabled scopes", async (t) => {
  const f = setup(t);
  const a = f.runtime.agent(agentId);
  await f.runtime.callTool(
    context(f.runtime, agentId, subject),
    "subject_rest",
    { durationMs: 60000, earlyWake: "owner" },
  );
  f.runtime.tick();
  const msg = (id) => raw(id, { message_type: "private", group_id: undefined });
  f.memory.setState(owner, { paused: true });
  await f.runtime.ingest("qq-0", msg(1));
  assert.equal(rhythmStatus(f.runtime, a).state, "sleeping");
  await f.runtime.ingest(
    "qq-0",
    raw(2, { message: [{ type: "at", data: { qq: "10000" } }] }),
  );
  assert.equal(rhythmStatus(f.runtime, a).state, "sleeping");
  f.memory.setState(owner, { ...f.memory.state(owner), paused: false });
  await f.runtime.ingest("qq-0", msg(3));
  await settle(f.runtime);
  assert.equal(rhythmStatus(f.runtime, a).state, "disabled");
  const args = submission("blocked", { kind: "rest" });
  await assert.rejects(
    f.runtime.callTool(
      context(f.runtime, "agent-1"),
      "subject_inbox_submit",
      args,
    ),
    /TOOL_DISABLED/,
  );
  const protectedContext = context(f.runtime);
  protectedContext.privateRead.add("operations:fixture");
  await assert.rejects(
    f.runtime.callTool(protectedContext, "subject_inbox_submit", args),
    /SUBJECT_INBOX_SOURCE_DENIED/,
  );
});

test("a deferred proposal survives coordinator replacement and wakes only when due", async (t) => {
  const prompts = [];
  const f = setup(t, async (p) => {
    if (p.conversation === subject) prompts.push(p.prompt);
  });
  const submitted = await f.runtime.callTool(
    context(f.runtime),
    "subject_inbox_submit",
    submission("durable", { kind: "rest" }),
  );
  const ctx = context(f.runtime, agentId, subject);
  const deferred = await f.runtime.callTool(
    ctx,
    "subject_inbox_decide",
    resolve(submitted.id, "defer", { reviewAt: f.runtime.now() + 60000 }),
  );
  assert.equal(deferred.revision, 2);
  f.runtime.subjectInbox = new f.runtime.subjectInbox.constructor(f.runtime);
  f.advance(59000);
  f.runtime.tick();
  assert.equal(prompts.length, 0);
  f.advance(1000);
  f.runtime.tick();
  await settle(f.runtime);
  assert.equal(prompts.length, 1);
  assert.match(prompts[0], /durable/);
});
