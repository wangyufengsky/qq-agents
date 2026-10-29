import test from "node:test";
import assert from "node:assert/strict";
import { fixture, config } from "./helpers.mjs";

const HOUR = 3600000;
const base = Date.parse("2026-10-29T00:00:00Z");
function setup(t, run = async () => {}) {
  const c = config(1),
    a = c.agents[0];
  a.ownerIds = ["30000"];
  a.allow.users = ["30000", "30001"];
  Object.assign(a.subject, {
    enabled: true,
    users: ["30001"],
    groups: ["20000"],
    intervalMs: 60000,
  });
  const f = fixture(t, { cfg: c, run });
  return { ...f, m: f.store.bind("agent-0") };
}
let n = 0;
const heard = (m, conversation, body, payload) =>
  m.append({
    dedupe: "heard-" + ++n,
    conversation,
    kind: "message.received",
    body,
    senderId: "30001",
    ...(payload ? { payload } : {}),
  });
const note = (m, conversation, body, at, extra = {}) =>
  m.identity.saveNote(
    {
      body,
      evidence: [heard(m, conversation, "来源：" + body, extra.payload).id],
      uncertainty: "对方没说具体哪天",
      ...(extra.status ? { status: extra.status } : {}),
    },
    conversation,
    at,
    extra.protection,
  );
const materials = (prompt) =>
  JSON.parse(prompt.split("空闲时间素材：")[1].split("\n\n")[0]);

test("free time lists open notes from every chat, newest first; protected ones take no place", async (t) => {
  const prompts = [];
  const f = setup(t, async (p) => {
    if (p.conversation === "@subject") prompts.push(p.prompt);
  });
  const chats = ["private:30001", "group:20000"];
  const open = Array.from({ length: 9 }, (_, i) =>
    note(
      f.m,
      chats[i % 2],
      i === 8
        ? "周末聚会还没定地方，" + "要再问问大家方便去哪里。".repeat(20)
        : `没聊完的事 ${i}`,
      base + i * HOUR,
    ),
  );
  // Newer than every listed note, yet neither is shown nor counted against eight.
  note(f.m, "group:20000", "PROTECTED_REPO_NOTE", base + 20 * HOUR, {
    protection: { protectedRepositories: ["fixture/private"] },
  });
  note(f.m, "private:30001", "OPERATIONS_NOTE", base + 21 * HOUR, {
    payload: { protectedOperations: true },
  });
  note(f.m, "group:20000", "FINISHED_NOTE", base + 22 * HOUR, {
    status: "completed",
  });
  note(f.m, "@subject", "OWN_SUBJECT_NOTE", base + 23 * HOUR);

  await f.runtime.wake("agent-0", "@subject");
  const [prompt] = prompts;
  // A fresh free-time context reads its materials public-only.
  assert.match(materials(prompt).notice, /新的空闲上下文/);
  assert.match(prompt, /openNotes/);
  assert.doesNotMatch(prompt, /PROTECTED_REPO_NOTE|OPERATIONS_NOTE/);
  const listed = materials(prompt).openNotes;
  assert.deepEqual(
    listed.items.map((x) => x.id),
    open
      .slice(1)
      .reverse()
      .map((x) => x.id),
  );
  assert.equal(listed.more, 1);
  assert.equal(listed.protectedNotListed, 2);
  assert.match(listed.notice, /不要推测内容/);
  const [latest, next] = listed.items;
  assert.equal(latest.conversation, "private:30001");
  assert.equal(next.conversation, "group:20000");
  assert.equal(Array.from(latest.body).length, 121);
  assert(latest.body.endsWith("…"));
  assert.equal(next.body, "没聊完的事 7");
  assert.equal(next.uncertainty, "对方没说具体哪天");
  assert.deepEqual(next.evidence, open[7].evidence);
  assert.equal(next.updatedAt, new Date(base + 7 * HOUR).toISOString());
  for (const item of listed.items)
    assert(["group:20000", "private:30001"].includes(item.conversation));
  assert(!listed.items.some((x) => /FINISHED|OWN_SUBJECT/.test(x.body)));

  // What was shown counts as read this turn; what was withheld does not.
  const taint = f.m.state("@subject").disclosureTaint;
  for (const item of listed.items) {
    assert(taint.includes(item.id));
    for (const id of item.evidence) assert(taint.includes(id));
  }
  assert(!taint.includes(open[0].id));
});

test("free time with no open notes elsewhere gets no notes section", async (t) => {
  const prompts = [];
  const f = setup(t, async (p) => {
    if (p.conversation === "@subject") prompts.push(p.prompt);
  });
  note(f.m, "group:20000", "FINISHED_NOTE", base, { status: "completed" });
  await f.runtime.wake("agent-0", "@subject");
  assert.equal(materials(prompts[0]).openNotes, undefined);
});

test("free time can reach out about a chat's note by its evidence, but cannot change the note", async (t) => {
  const outcomes = {};
  const f = setup(t, async (p) => {
    if (p.conversation !== "@subject") return;
    const [item] = materials(p.prompt).openNotes.items;
    const intent = {
      topic: "问问周末聚会定在哪儿",
      target: item.conversation,
      reason: "笔记里地方还没定",
      background: "接着笔记 " + item.id,
      expiresAt: Date.now() + 6 * HOUR,
      expectsResponse: true,
    };
    outcomes.noteId = await p
      .callTool("intent_create", { ...intent, evidence: [item.id] })
      .then(
        () => "ok",
        (e) => e.message,
      );
    outcomes.intent = await p.callTool("intent_create", {
      ...intent,
      evidence: item.evidence,
    });
    outcomes.edit = await p
      .callTool("work_note", {
        id: item.id,
        body: "空闲时间替别的聊天结掉",
        evidence: item.evidence,
        uncertainty: "无",
        status: "completed",
      })
      .then(
        () => "ok",
        (e) => e.message,
      );
  });
  const pending = note(f.m, "private:30001", "周末聚会还没定地方", base);
  await f.runtime.wake("agent-0", "@subject");
  // The materials say why: a note ID is not evidence an intent can freeze.
  assert.match(outcomes.noteId, /EVIDENCE_NOT_OWNED_OR_MISSING/);
  assert.equal(outcomes.intent.target, "private:30001");
  assert.deepEqual(outcomes.intent.evidence, pending.evidence);
  assert.match(outcomes.intent.background, new RegExp(pending.id));
  assert.match(outcomes.edit, /RECORD_NOT_FOUND/);
  const [still] = f.m.identity.notes("private:30001");
  assert.equal(still.status, "open");
  assert.equal(still.body, "周末聚会还没定地方");
  assert.equal(f.m.identity.notes("@subject").length, 0);
});
