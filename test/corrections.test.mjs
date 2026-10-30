import test from "node:test";
import assert from "node:assert/strict";
import { fixture, context } from "./helpers.mjs";
import { MemoryStore } from "../src/memory/store.mjs";
import { restoreExport } from "../src/memory/migrate.mjs";
import { chatHistory } from "../src/core/chat-context.mjs";
import { sourceHandoff } from "../src/core/context-handoff.mjs";
import { subjectMaterials } from "../src/core/subject-materials.mjs";

function setup(t) {
  const f = fixture(t),
    m = f.store.bind("agent-0"),
    ctx = context(f.runtime);
  const old = m.append({
    dedupe: "old",
    conversation: ctx.conversation,
    connectionId: "qq-0",
    kind: "message.sent",
    direction: "out",
    body: "你在疏远我",
  });
  const source = m.append({
    dedupe: "correction",
    conversation: ctx.conversation,
    connectionId: "qq-0",
    kind: "message.received",
    senderId: "30000",
    body: "昨天只是忙，不是讨厌你",
    payload: { trustedInput: true },
  });
  f.runtime.observeInput(ctx, [
    m.readRecord({ id: source.id }, ctx.conversation),
  ]);
  const card = m.identity.savePersonCard(
    { personId: "30000", body: "他在疏远我", evidence: [old.id] },
    { writtenIn: ctx.conversation, now: 1 },
  );
  const diary = m.diaryWrite({
    title: "当时的难过",
    body: "当时很难过，觉得他在疏远我",
    evidence: [old.id],
    people: ["30000"],
  });
  const item = m.identity.savePersonItem(
    {
      personId: "30000",
      kind: "boundary",
      body: "他不想聊天",
      evidence: [diary.id],
    },
    { writtenIn: ctx.conversation, now: 2 },
  );
  const args = {
    personId: "30000",
    sourceId: source.id,
    oldBelief: "未回复说明在疏远我",
    current: "昨天未回复是因为忙",
    scope: "仅针对昨天未回复这件事",
    kind: "mistaken",
    targets: [{ type: "event", id: old.id }],
  };
  return {
    ...f,
    m,
    ctx,
    old,
    source,
    card,
    diary,
    item,
    args,
    call: (name, args) => f.runtime.callTool(ctx, name, args),
  };
}

test("a correction traverses dependencies, preserves originals and accompanies every recall projection", async (t) => {
  const f = setup(t),
    c = await f.call("memory_correct", f.args);
  assert.equal(c.targets.length, 4);
  assert.equal(f.m.readRecord({ id: f.old.id }).body, "你在疏远我");
  for (const row of [
    f.m.readRecord({ id: f.old.id }),
    f.m.readRecord({ id: f.diary.id }),
    f.m.search({ query: "疏远", maxChars: 16000 }).items[0],
  ])
    assert.equal(row.corrections[0].current, f.args.current);
  const page = f.m.conversation(
    { conversation: f.ctx.conversation, maxChars: 16000, fullText: true },
    f.ctx.conversation,
  );
  assert.ok(chatHistory(page).items.find((x) => x.id === f.old.id).corrections);
  f.m.setState(f.ctx.conversation, {
    continuity: { anchors: [f.old.id], recent: [] },
  });
  assert.ok(sourceHandoff(f.m, f.ctx.conversation).sources[0].corrections);
  const fresh = context(f.runtime, "agent-0", "private:30000");
  const cards = await f.runtime.callTool(fresh, "person_notes", {
    personIds: ["30000"],
  });
  assert.ok(cards.items[0].corrections);
  const items = await f.runtime.callTool(fresh, "person_items", {
    personIds: ["30000"],
  });
  assert.ok(items.people[0].open[0].corrections);
  assert.equal(
    subjectMaterials(f.runtime, context(f.runtime, "agent-0", "@subject"))
      .pendingCorrections.length,
    1,
  );
  assert.equal((await f.call("memory_correct", f.args)).id, c.id);
  assert.equal(f.m.corrections.list().length, 1);
});

test("checklist cannot claim an unchanged record was updated; revisions survive subsequent conversations", async (t) => {
  const f = setup(t),
    c = await f.call("memory_correct", f.args);
  const review = {
    id: c.id,
    expectedRevision: 1,
    targetId: f.card.id,
    type: "person",
    action: "updated",
    reason: "按解释修改印象",
  };
  await assert.rejects(
    f.call("memory_correction_review", review),
    /CORRECTION_RECORD_UNCHANGED/,
  );
  await f.call("person_note", {
    personId: "30000",
    body: "昨天忙，没有回复；不以此推断关系",
    evidence: [f.source.id],
    expectedRevision: 1,
  });
  const done = await f.call("memory_correction_review", review);
  assert.equal(done.revision, 2);
  await assert.rejects(
    f.call("memory_correction_review", review),
    /REVISION_CONFLICT/,
  );
  assert.equal(
    f.m.corrections.annotation("person", f.card.id, 2).corrections,
    undefined,
  );
  assert.ok(f.m.corrections.annotation("person", f.card.id, 1).corrections);
});

test("corrections require fully observed trusted human input from the person or administrator", async (t) => {
  const f = setup(t);
  f.ctx.requestEvents.clear();
  await assert.rejects(
    f.call("memory_correct", f.args),
    /CORRECTION_SOURCE_REQUIRED/,
  );
  f.ctx.requestEvents.add(f.source.id);
  await assert.rejects(
    f.call("memory_correct", { ...f.args, personId: "39999" }),
    /CORRECTION_SOURCE_REQUIRED/,
  );
  await assert.rejects(
    f.call("memory_correct", { ...f.args, sourceId: f.old.id }),
    /CORRECTION_SOURCE_REQUIRED/,
  );
  const other = context(f.runtime, "agent-1");
  other.requestEvents = new Set([f.source.id]);
  await assert.rejects(
    f.runtime.callTool(other, "memory_correct", f.args),
    /CORRECTION_SOURCE_REQUIRED/,
  );
  assert.equal(f.m.corrections.list().length, 0);
});

test("protected targets and contexts cannot be laundered through correction text", async (t) => {
  const f = setup(t);
  const secret = f.m.diaryWrite(
    { title: "protected", body: "private", evidence: [] },
    "test",
    undefined,
    true,
  );
  await assert.rejects(
    f.call("memory_correct", {
      ...f.args,
      targets: [{ type: "diary", id: secret.id }],
    }),
    /RECALL_SOURCE_NOT_ALLOWED/,
  );
  assert.equal(f.m.corrections.list().length, 0);
  f.ctx.privateRead.add("operations:fixture");
  await assert.rejects(
    f.call("memory_correct", f.args),
    /RESTRICTED_CONTEXT_MIND_WRITE_BLOCKED/,
  );
});

test("corrections remain after export/restore and old diary revision reads", async (t) => {
  const f = setup(t);
  await f.call("memory_correct", f.args);
  const target = new MemoryStore(":memory:");
  t.after(() => target.close());
  restoreExport(target.bind("agent-0"), f.m.export());
  assert.equal(
    target.bind("agent-0").readRecord({ id: f.old.id }).corrections[0].current,
    f.args.current,
  );
  await f.call("diary_revise", {
    id: f.diary.id,
    expectedRevision: 1,
    title: "误会解释清楚了",
    body: "当时难过，后来知道对方只是忙",
    evidence: [f.source.id],
  });
  assert.ok(f.m.readRecord({ id: f.diary.id, revision: 1 }).corrections);
});

test("a newer explanation supersedes the earlier correction on original targets", async (t) => {
  const f = setup(t),
    old = await f.call("memory_correct", f.args);
  const source = f.m.append({
    dedupe: "later",
    connectionId: "qq-0",
    conversation: f.ctx.conversation,
    kind: "message.received",
    senderId: "30000",
    body: "补充一下，那天手机也坏了",
    payload: { trustedInput: true },
  });
  f.runtime.observeInput(f.ctx, [
    f.m.readRecord({ id: source.id }, f.ctx.conversation),
  ]);
  const next = await f.call("memory_correct", {
    ...f.args,
    sourceId: source.id,
    supersedes: old.id,
    current: "昨天忙，手机也坏了",
    targets: [{ type: "person", id: f.card.id }],
  });
  assert.equal(f.m.corrections.get(old.id).supersededBy, next.id);
  assert.deepEqual(
    f.m.readRecord({ id: f.old.id }).corrections.map((x) => x.id),
    [next.id],
  );
  assert.equal(f.m.corrections.forPeople(["30000"]).length, 1);
});

test("shared evidence does not block correction and inherited candidates stay reviewable", async (t) => {
  const f = setup(t);
  const other = f.m.identity.savePersonCard(
    { personId: "30001", body: "另一个人的独立印象", evidence: [f.old.id] },
    { writtenIn: f.ctx.conversation, now: 3 },
  );
  const intent = f.m.identity.put("intentions", {
    id: "test-intent",
    evidence: [f.old.id],
    status: "waiting",
    target: "group:20000",
    background: "想问为什么不理我",
  });
  const c = await f.call("memory_correct", f.args);
  assert.ok(
    f.runtime.contexts.handoff("agent-0", "group:20000").intents[0].corrections,
  );
  assert.throws(
    () => f.runtime.subject.assertFresh(f.ctx, intent),
    /INTENT_CORRECTION_REVIEW_REQUIRED/,
  );
  assert.equal(c.targets.find((x) => x.id === other.id).direct, false);
  assert.ok(
    f.m.identity.list("intentions").find((x) => x.id === intent.id).corrections,
  );
  const later = f.m.append({
    dedupe: "extra",
    connectionId: "qq-0",
    conversation: f.ctx.conversation,
    kind: "message.received",
    senderId: "30000",
    body: "再补充一下",
    payload: { trustedInput: true },
  });
  f.runtime.observeInput(f.ctx, [
    f.m.readRecord({ id: later.id }, f.ctx.conversation),
  ]);
  const next = await f.call("memory_correct", {
    ...f.args,
    sourceId: later.id,
    supersedes: c.id,
  });
  assert.equal(next.targets.find((x) => x.id === other.id).direct, false);
  const reviewed = await f.call("memory_correction_review", {
    id: next.id,
    expectedRevision: 1,
    targetId: other.id,
    type: "person",
    action: "unaffected",
    reason: "与另一人的印象无关",
  });
  assert.equal(
    reviewed.targets.find((x) => x.id === other.id).state,
    "unaffected",
  );
});

test("direct targets require a durable change before an update review can unblock an intent", async (t) => {
  const f = setup(t);
  const intent = f.m.identity.put("intentions", {
    id: "direct-intent",
    evidence: [f.old.id],
    status: "waiting",
    target: f.ctx.conversation,
  });
  const c = await f.call("memory_correct", {
    ...f.args,
    targets: [
      { type: "diary", id: f.diary.id },
      { type: "intent", id: intent.id },
    ],
  });
  for (const [type, targetId] of [
    ["diary", f.diary.id],
    ["intent", intent.id],
  ])
    await assert.rejects(
      f.call("memory_correction_review", {
        id: c.id,
        expectedRevision: 1,
        type,
        targetId,
        action: "updated",
        reason: "未经改动",
      }),
      /CORRECTION_RECORD_UNCHANGED/,
    );
  assert.equal(f.m.corrections.blocksIntent(intent.id), true);
});

test("one administrator message can correct the same belief about different people", async (t) => {
  const f = setup(t);
  f.runtime.agent("agent-0").ownerIds = ["30000"];
  const first = await f.call("memory_correct", f.args);
  const second = await f.call("memory_correct", {
    ...f.args,
    personId: "30001",
  });
  assert.notEqual(first.id, second.id);
  assert.equal(f.m.corrections.forPeople(["30001"])[0].id, second.id);
  assert.equal(
    (await f.call("memory_correct", { ...f.args, personId: "30001" })).id,
    second.id,
  );
});
