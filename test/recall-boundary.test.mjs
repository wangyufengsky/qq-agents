import test from "node:test";
import assert from "node:assert/strict";
import { config, fixture, context } from "./helpers.mjs";
import { createServer } from "../src/server.mjs";

const repo = "fixture/private";
function setup(t, options = {}) {
  const cfg = config(1);
  cfg.agents[0].ownerIds = ["30000"];
  cfg.agents[0].subject.enabled = true;
  cfg.agents[0].allow.users.push("30001");
  cfg.agents[0].tools.push("memory_related");
  const f = fixture(t, { cfg, ...options });
  const m = f.store.bind("agent-0");
  const event = m.append({
    dedupe: "ordinary",
    conversation: "group:20000",
    kind: "message.received",
    body: "nickname ordinary chat",
    senderId: "30000",
  });
  const diary = m.diaryWrite(
    { title: "nickname private diary", body: "PRIVATE_DIARY_BODY" },
    "ai-diary",
    {},
    false,
    [repo],
  );
  return { ...f, m, event, diary };
}

for (const scope of ["group:20000", "private:30001"]) {
  test(`${scope} can recall ordinary messages and reply without reading a protected diary`, async (t) => {
    const f = setup(t),
      ctx = context(f.runtime, "agent-0", scope);
    const result = await f.runtime.callTool(ctx, "memory_search", {
      query: "nickname",
    });
    assert(result.items.some((r) => r.id === f.event.id));
    assert(!JSON.stringify(result).includes("PRIVATE_DIARY_BODY"));
    assert(!result.diaries.some((r) => r.id === f.diary.id));
    assert(!ctx.privateRead.has("github-private:" + repo));
    const sent = await f.runtime.send(ctx, {
      requestId: "ordinary-reply",
      text: "ordinary reply",
    });
    assert.equal(sent.status, "sent");
    assert.equal(f.runtime.transports.get("qq-0").sent.length, 1);
  });
}

test("a rejected direct protected read does not taint the chat", async (t) => {
  const f = setup(t),
    ctx = context(f.runtime);
  for (const args of [
    { id: f.diary.id },
    { id: f.diary.id, revision: 1, offset: 512 },
  ])
    await assert.rejects(
      f.runtime.callTool(ctx, "memory_read", args),
      /RECALL_SOURCE_NOT_ALLOWED/,
    );
  assert(!ctx.privateRead.has(f.diary.id));
  assert.doesNotThrow(() => f.runtime.assertDisclosure(ctx));
});

test("owner and subject withhold protected recall before importing provenance", async (t) => {
  const f = setup(t);
  for (const scope of ["private:30000", "@subject"]) {
    const ctx = context(f.runtime, "agent-0", scope);
    const result = await f.runtime.callTool(ctx, "memory_search", {
      query: "nickname",
    });
    assert(!result.diaries.some((r) => r.id === f.diary.id));
    assert(!ctx.privateRead.has("github-private:" + repo));
  }
});

test("protected notes cannot re-enter a group through work_notes or handoff", async (t) => {
  const f = setup(t);
  const dirty = context(f.runtime);
  dirty.privateRead.add("github-private:" + repo);
  const note = await f.runtime.callTool(dirty, "work_note", {
    body: "PRIVATE_NOTE_BODY",
    evidence: [f.event.id],
    uncertainty: "unverified",
  });
  f.m.setState("group:20000", {
    ...f.m.state("group:20000"),
    disclosureTaint: [],
  });
  const ctx = context(f.runtime);
  const result = await f.runtime.callTool(ctx, "work_notes", {});
  assert(!JSON.stringify(result).includes("PRIVATE_NOTE_BODY"));
  const handoff = f.runtime.contexts.handoff("agent-0", "group:20000");
  assert(!JSON.stringify(handoff).includes("PRIVATE_NOTE_BODY"));
  assert(!ctx.privateRead.has("github-private:" + repo));
  assert(f.m.identity.notes("group:20000").some((r) => r.id === note.id));
});

test("recovery retires the contaminated transcript, retains records and delivery state, and fences late taint writes", async (t) => {
  let received;
  const f = setup(t, {
    run: async (p) => {
      received = p;
      await p.callTool("memory_search", { query: "nickname" });
      await p.callTool("qq_send", {
        requestId: "after-recovery",
        text: "ordinary reply",
      });
    },
  });
  const scope = "group:20000";
  const old = context(f.runtime);
  old.privateRead.add("github-private:" + repo);
  old.persistTaint();
  await f.runtime.callTool(old, "work_note", {
    body: "PRIVATE_NOTE_BODY",
    evidence: [f.event.id],
    uncertainty: "unverified",
  });
  f.m.setState(scope, {
    ...f.m.state(scope),
    session: { id: "contaminated", backend: "dsh" },
    replyBatchSends: 2,
    sendTimes: [Date.now()],
    paused: false,
    continuity: { anchors: [f.diary.id], recent: [] },
  });
  await assert.rejects(
    f.runtime.recoverProtectedConversation("agent-0", scope),
    /RECOVERY_REQUIRES_PAUSED/,
  );
  f.m.setState(scope, { ...f.m.state(scope), paused: true });
  const recovered = await f.runtime.recoverProtectedConversation(
    "agent-0",
    scope,
  );
  assert.equal(recovered.paused, true);
  const state = f.m.state(scope);
  assert.equal(state.session, null);
  assert.deepEqual(state.disclosureTaint, []);
  assert.equal(state.replyBatchSends, 2);
  assert.equal(state.sendTimes.length, 1);
  old.persistTaint();
  assert.deepEqual(f.m.state(scope).disclosureTaint, []);
  assert.throws(
    () => f.runtime.assertActive(old),
    /INVALID_CAPABILITY|AGENT_PAUSED_OR_EXPIRED/,
  );
  assert(
    f.m.identity
      .list("session_history")
      .some((h) => h.session?.id === "contaminated"),
  );
  assert(
    f.m.readRecord({ id: f.diary.id }).protectedRepositories.includes(repo),
  );
  f.m.setState(scope, { ...state, paused: false });
  await f.runtime.wake("agent-0", scope);
  assert.equal(received.session ?? null, null);
  assert(!received.prompt.includes("PRIVATE_NOTE_BODY"));
  assert(!received.prompt.includes("PRIVATE_DIARY_BODY"));
  assert.equal(f.runtime.transports.get("qq-0").sent.length, 1);
});

test("scene neighbors, direct conversation pages and anchors cannot expose operations records", async (t) => {
  const f = setup(t),
    ctx = context(f.runtime);
  const protectedEvent = f.m.append({
    dedupe: "ops-neighbor",
    conversation: "group:20000",
    kind: "message.received",
    body: "OPERATIONS_SECRET",
    senderId: "30000",
    payload: { protectedOperations: true },
  });
  const search = await f.runtime.callTool(ctx, "memory_search", {
    query: "nickname",
    contextAfter: 5,
  });
  assert(search.items.some((r) => r.id === f.event.id));
  assert(!JSON.stringify(search).includes("OPERATIONS_SECRET"));
  const page = await f.runtime.callTool(ctx, "conversation_read", {});
  assert(!JSON.stringify(page).includes("OPERATIONS_SECRET"));
  for (const [name, args] of [
    ["conversation_read", { aroundId: protectedEvent.id }],
    ["memory_related", { id: protectedEvent.id }],
    ["memory_read", { id: protectedEvent.id }],
  ])
    await assert.rejects(
      f.runtime.callTool(ctx, name, args),
      /RECALL_SOURCE_NOT_ALLOWED/,
    );
  assert(!ctx.privateRead.has(protectedEvent.id));
  assert.doesNotThrow(() => f.runtime.assertDisclosure(ctx));
});

test("filtering a diary page preserves progress to an allowed result", async (t) => {
  const f = setup(t),
    ctx = context(f.runtime);
  const ordinary = f.m.diaryWrite({
    title: "ordinary",
    body: "PUBLIC_DIARY_BODY",
  });
  for (const [id, age] of [
    [f.diary.id, 1000],
    [ordinary.id, 2000],
  ]) {
    const time = new Date(Date.now() - age).toISOString();
    f.m.db
      .prepare("UPDATE diaries SET created_at=?,updated_at=? WHERE id=?")
      .run(time, time, id);
  }
  const first = await f.runtime.callTool(ctx, "memory_search", {
    type: "diary",
    limit: 1,
  });
  assert.deepEqual(first.diaries, []);
  assert(first.nextCursor);
  const next = await f.runtime.callTool(ctx, "memory_search", {
    type: "diary",
    limit: 1,
    cursor: first.nextCursor,
  });
  assert.equal(next.diaries[0].id, ordinary.id);
  assert.equal(next.nextCursor, null);
  assert.doesNotThrow(() => f.runtime.assertDisclosure(ctx));
});

test("admin recovery rejects unauthenticated and unpaused requests and never sends a message", async (t) => {
  const f = setup(t),
    scope = "group:20000";
  const token = "a".repeat(64);
  const server = createServer({ runtime: f.runtime, token, allowLive: true });
  const port = await server.listen(0);
  t.after(() => server.close());
  const url = `http://127.0.0.1:${port}/api/session/recover`;
  const post = (authenticated) =>
    fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(authenticated ? { "x-admin-token": token } : {}),
      },
      body: JSON.stringify({ agentId: "agent-0", conversation: scope }),
    });
  assert.equal((await post(false)).status, 401);
  f.m.setState(scope, {
    disclosureTaint: ["github-private:" + repo],
    session: { id: "old", backend: "dsh" },
  });
  assert.equal(
    (await (await post(true)).json()).error,
    "RECOVERY_REQUIRES_PAUSED_CONVERSATION",
  );
  f.m.setState(scope, { ...f.m.state(scope), paused: true });
  const response = await post(true);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).recovered, true);
  assert.equal(f.m.state(scope).paused, true);
  assert.equal(f.runtime.transports.get("qq-0").sent.length, 0);
});

test("a failed recovery archive preserves protection and never resumes the old session", async (t) => {
  const f = setup(t),
    scope = "group:20000";
  f.m.setState(scope, {
    paused: true,
    session: { id: "old", backend: "dsh" },
    disclosureTaint: ["github-private:" + repo],
  });
  f.m.db.exec(
    "CREATE TRIGGER fail_recall_archive BEFORE INSERT ON session_history WHEN json_extract(new.value,'$.reason')='protected-recall-recovery' BEGIN SELECT RAISE(ABORT,'archive unavailable'); END;",
  );
  await assert.rejects(
    f.runtime.recoverProtectedConversation("agent-0", scope),
    /archive unavailable/,
  );
  assert.deepEqual(f.m.state(scope).disclosureTaint, [
    "github-private:" + repo,
  ]);
  assert.equal(f.m.state(scope).paused, true);
  assert.equal(f.m.state(scope).session, null);
});
