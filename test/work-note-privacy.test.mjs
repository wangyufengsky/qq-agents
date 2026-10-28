import test from "node:test";
import assert from "node:assert/strict";
import { config, fixture, context } from "./helpers.mjs";

const repo = "fixture/framework";
function setup(t) {
  const cfg = config(2);
  cfg.agents[0].ownerIds = ["30000"];
  cfg.agents[0].subject.enabled = true;
  const f = fixture(t, { cfg });
  const m = f.store.bind("agent-0");
  const source = m.append({
    dedupe: "source",
    conversation: "private:30000",
    kind: "message.received",
    body: "待办来源",
    senderId: "30000",
  });
  return {
    ...f,
    m,
    source,
    ctx: context(f.runtime, "agent-0", "private:30000"),
  };
}
test("protected context can save a work note with durable protection", async (t) => {
  const f = setup(t);
  f.ctx.privateRead.add("github-private:" + repo);
  f.ctx.privateRead.add("operations:fixture");
  const note = await f.runtime.callTool(f.ctx, "work_note", {
    body: "待完成的私有事项",
    evidence: [f.source.id],
    uncertainty: "需要复核",
  });
  assert.equal(note.protectedOperations, true);
  assert.deepEqual(note.protectedRepositories, [repo]);
  assert.deepEqual(
    f.m.identity.notes(f.ctx.conversation)[0].protectedRepositories,
    [repo],
  );
});

function fresh(f, conversation = "private:30000") {
  f.m.setState(conversation, {
    ...f.m.state(conversation),
    disclosureTaint: [],
  });
  return context(f.runtime, "agent-0", conversation);
}
const input = (evidence, extra = {}) => ({
  body: "未完成事项",
  evidence,
  uncertainty: "尚待核实",
  ...extra,
});
async function protectedNote(
  f,
  { scope = "private:30000", ops = false, repos = [repo] } = {},
) {
  const ctx = fresh(f, scope);
  for (const name of repos) ctx.privateRead.add("github-private:" + name);
  if (ops) ctx.privateRead.add("operations:fixture");
  return f.runtime.callTool(ctx, "work_note", input([f.source.id]));
}
function assertExternalBlocked(f, ctx) {
  assert.throws(
    () =>
      f.runtime.authorizeExternal(ctx, {
        tool: "web_fetch",
        args: { url: "https://example.org" },
      }),
    /EXTERNAL_CALL_BLOCKED/,
  );
}

test("work notes inherit protected event and diary ancestry even without prior read markers", async (t) => {
  const f = setup(t);
  const original = f.m.append({
    dedupe: "private",
    conversation: "@subject",
    kind: "github.read",
    body: "private",
    payload: { protectedRepositories: [repo] },
  });
  const diary = f.m.diaryWrite(
    { title: "derived", body: "derived", evidence: [original.id] },
    "ai-diary",
    {},
    true,
  );
  const note = f.m.identity.saveNote(
    input([diary.id]),
    f.ctx.conversation,
    f.runtime.now(),
  );
  await assert.rejects(
    f.runtime.callTool(f.ctx, "work_note", input([diary.id])),
    /RECALL_SOURCE_NOT_ALLOWED/,
  );
  f.ctx.privateRead.add("operations:legacy");
  f.ctx.privateRead.add("github-private:" + repo);
  assert.deepEqual(note.protectedRepositories, [repo]);
  assert.equal(note.protectedOperations, true);
  assertExternalBlocked(f, f.ctx);
  await assert.rejects(
    f.runtime.send(f.ctx, { requestId: "leak", text: "copy" }),
    /REQUIRES_DISCLOSURE_GRANT/,
  );
  assert.equal(f.runtime.transports.get("qq-0").sent.length, 0);
});

test("editing, changing evidence and reopening cannot strip protection", async (t) => {
  const f = setup(t),
    note = await protectedNote(f, { ops: true });
  for (const status of ["completed", "corrected", "open"]) {
    const ctx = fresh(f);
    ctx.privateRead.add("github-private:fixture/second");
    const updated = f.m.identity.saveNote(
      input([f.source.id], { id: note.id, body: "reworded", status }),
      ctx.conversation,
      f.runtime.now(),
      { protectedRepositories: ["fixture/second"] },
    );
    await assert.rejects(
      f.runtime.callTool(
        ctx,
        "work_note",
        input([f.source.id], { id: note.id }),
      ),
      /RECALL_SOURCE_NOT_ALLOWED/,
    );
    assert.equal(updated.protectedOperations, true);
    assert.deepEqual(updated.protectedRepositories, [repo, "fixture/second"]);
    assertExternalBlocked(f, ctx);
  }
  await assert.rejects(
    f.runtime.callTool(fresh(f), "work_note", {
      ...input([f.source.id]),
      protectedRepositories: [],
    }),
    /Unrecognized key/,
  );
});

for (const scope of ["@subject", "private:30000", "group:20000"]) {
  for (const route of ["read", "handoff"]) {
    test(`${scope} ${route} applies the protected note read boundary`, async (t) => {
      const f = setup(t),
        note = await protectedNote(f, { scope });
      const ctx = fresh(f, scope);
      const result =
        route === "read"
          ? await f.runtime.callTool(ctx, "work_notes", {})
          : f.runtime.contexts.prepare(ctx, {}, []);
      assert(!JSON.stringify(result).includes(note.id));
      assert(!ctx.privateRead.has("github-private:" + repo));
      assert.doesNotThrow(() => f.runtime.assertDisclosure(ctx));
      assert(f.m.identity.notes(scope).some((row) => row.id === note.id));
    });
  }
}

test("Operations protection survives source deletion and implicit handoff", async (t) => {
  const f = setup(t),
    note = await protectedNote(f, { ops: true, repos: [] });
  f.m.db
    .prepare("DELETE FROM events WHERE agent_id=? AND id=?")
    .run("agent-0", f.source.id);
  const ctx = fresh(f);
  const prepared = f.runtime.contexts.prepare(ctx, {}, []);
  assert(!prepared.prompt.includes(note.id));
  assert(!ctx.privateRead.has("operations:work-note:" + note.id));
  assert(f.m.identity.get("work_notes", note.id).protectedOperations);
  assert.equal(
    (await f.runtime.send(ctx, { requestId: "clean", text: "hello" })).status,
    "sent",
  );
});

test("note-derived diaries and subsequent notes keep all inherited markers", async (t) => {
  const f = setup(t);
  await protectedNote(f, { ops: true });
  const ctx = fresh(f);
  await f.runtime.callTool(ctx, "work_notes", {});
  // Already-read legacy contexts must still propagate protection on new writes.
  ctx.privateRead.add("operations:legacy");
  ctx.privateRead.add("github-private:" + repo);
  const diary = await f.runtime.callTool(ctx, "diary_write", {
    title: "derived",
    body: "from note",
  });
  const metadata = JSON.parse(
    f.m.db.prepare("SELECT metadata FROM diaries WHERE id=?").get(diary.id)
      .metadata,
  );
  assert.equal(metadata.protectedOperations, true);
  assert.deepEqual(metadata.protectedRepositories, [repo]);
  const next = await f.runtime.callTool(ctx, "work_note", input([f.source.id]));
  assert.equal(next.protectedOperations, true);
  assert.deepEqual(next.protectedRepositories, [repo]);
  await assert.rejects(
    f.runtime.callTool(ctx, "self_propose", {
      body: "derived",
      reason: "test",
      evidence: [f.source.id],
      scope: "interest",
      expectedVersion: 1,
    }),
    /RESTRICTED_CONTEXT_MIND_WRITE_BLOCKED/,
  );
  f.runtime.agent("agent-0").subject.groups = ["20000"];
  const intent = await f.runtime.callTool(ctx, "intent_create", {
    topic: "derived",
    target: "group:20000",
    reason: "test",
    expiresAt: Date.now() + 100000,
  });
  assert.equal(intent.protectedOperations, true);
  assert.deepEqual(intent.protectedRepositories, [repo]);
});

test("notes remain scoped to agent and conversation, including updates", async (t) => {
  const f = setup(t),
    note = await protectedNote(f);
  for (const ctx of [
    context(f.runtime, "agent-1", "private:30000"),
    fresh(f, "group:20001"),
  ]) {
    assert.equal(
      (await f.runtime.callTool(ctx, "work_notes", {})).items.length,
      0,
    );
    await assert.rejects(
      f.runtime.callTool(
        ctx,
        "work_note",
        input([f.source.id], { id: note.id }),
      ),
      /RECALL_SOURCE_NOT_ALLOWED|RECORD_NOT_FOUND|EVIDENCE_NOT_OWNED_OR_MISSING/,
    );
  }
});

test("ordinary notes remain writable and do not gain restricted markers", async (t) => {
  const f = setup(t),
    ctx = fresh(f, "group:20000");
  const note = await f.runtime.callTool(ctx, "work_note", input([f.source.id]));
  assert.equal(note.protectedOperations, undefined);
  assert.equal(note.protectedRepositories, undefined);
  assert.doesNotThrow(() => f.runtime.assertDisclosure(ctx));
  assert.equal(
    (await f.runtime.send(ctx, { requestId: "ordinary", text: "ordinary" }))
      .status,
    "sent",
  );
});

test("protected context can save an intent without scheduling a forbidden disclosure", async (t) => {
  const f = setup(t);
  f.runtime.agent("agent-0").subject.groups = ["20000"];
  f.ctx.privateRead.add("github-private:" + repo);
  const intent = await f.runtime.callTool(f.ctx, "intent_create", {
    topic: "私有事项",
    target: "group:20000",
    reason: "稍后交流",
    evidence: [f.source.id],
    expiresAt: f.runtime.now() + 100000,
  });
  assert.deepEqual(intent.protectedRepositories, [repo]);
  f.runtime.subject.tick();
  assert.equal(f.m.identity.get("intentions", intent.id).status, "waiting");
});

for (const route of ["list", "handoff", "queued-reason", "duplicate"]) {
  test(`intent ${route} preserves the protected read boundary`, async (t) => {
    const f = setup(t),
      a = f.runtime.agent("agent-0");
    a.subject.groups = ["20000"];
    f.ctx.privateRead.add("github-private:" + repo);
    f.ctx.privateRead.add("operations:fixture");
    const args = {
      topic: "fixture-private-intent-topic",
      target: "group:20000",
      reason: "fixture-private-intent-reason",
      evidence: [f.source.id],
      expiresAt: f.runtime.now() + 100000,
    };
    const i = await f.runtime.callTool(f.ctx, "intent_create", args);
    const ctx = fresh(f, "group:20000");
    let result;
    if (route === "list")
      result = await f.runtime.callTool(ctx, "intent_list", {});
    else if (route === "duplicate") {
      await assert.rejects(
        f.runtime.callTool(ctx, "intent_create", args),
        /RECALL_SOURCE_NOT_ALLOWED/,
      );
      assert(!ctx.privateRead.has("github-private:" + repo));
      return;
    } else {
      if (route === "queued-reason") {
        // Use an existing session: reason records must be tracked even when no
        // initial handoff is injected. Persisted data is authoritative.
        f.runtime.contexts.prepare(ctx, {}, []);
        f.m.identity.put("model_turns", {
          ...f.m.identity.get("model_turns", ctx.turnId),
          status: "completed-no-send",
        });
        const state = f.m.state(ctx.conversation);
        f.m.setState(ctx.conversation, {
          ...state,
          session: { backend: "fixture", id: "existing" },
          disclosureTaint: [],
        });
        ctx.privateRead.clear();
        f.runtime.subject.begin(ctx, [{ intentId: i.id }]);
      }
      result = f.runtime.contexts.prepare(ctx, {}, [
        { intentId: i.id, instruction: "queued" },
      ]);
    }
    assert(result);
    if (["list", "handoff", "queued-reason"].includes(route)) {
      if (route === "list") assert(!JSON.stringify(result).includes(i.id));
      // A wake reason may retain an opaque ID; the protected record must not
      // enter the handoff as content or authorize disclosure.
      assert(!JSON.stringify(result).includes(args.topic));
      assert(!JSON.stringify(result).includes(args.reason));
      assert(!ctx.privateRead.has("github-private:" + repo));
      assert.doesNotThrow(() => f.runtime.assertDisclosure(ctx));
      assert(
        f.m.identity
          .get("intentions", i.id)
          .protectedRepositories.includes(repo),
      );
      return;
    }
    assert(ctx.privateRead.has("github-private:" + repo));
    assert(ctx.privateRead.has("operations:intent:" + i.id));
    assertExternalBlocked(f, ctx);
    await assert.rejects(
      f.runtime.send(ctx, { requestId: "leak", text: "copy" }),
      /REQUIRES_DISCLOSURE_GRANT/,
    );
  });
}

test("private repository intent is never auto-handed to ordinary owner chat", async (t) => {
  const f = setup(t);
  f.ctx.privateRead.add("github-private:" + repo);
  const i = await f.runtime.callTool(f.ctx, "intent_create", {
    topic: "owner-only",
    target: "private:30000",
    reason: "test",
    expiresAt: f.runtime.now() + 100000,
  });
  const requests = [];
  f.runtime.conversations.request = (...args) => requests.push(args);
  f.runtime.subject.tick();
  assert.equal(requests.length, 0);
  assert.equal(f.m.identity.get("intentions", i.id).status, "waiting");
});

test("new protected context taints intent updates and cannot select a forbidden send", async (t) => {
  const f = setup(t),
    a = f.runtime.agent("agent-0");
  a.subject.groups = ["20000"];
  const i = await f.runtime.callTool(f.ctx, "intent_create", {
    topic: "initially ordinary",
    target: "group:20000",
    reason: "test",
    expiresAt: f.runtime.now() + 100000,
  });
  f.ctx.privateRead.add("github-private:" + repo);
  const updated = await f.runtime.callTool(f.ctx, "intent_update", {
    id: i.id,
    expectedRevision: i.revision,
    action: "defer",
    reason: "private reason",
    eligibleAt: f.runtime.now() + 1000,
  });
  assert.deepEqual(updated.protectedRepositories, [repo]);
  const handed = f.runtime.subject.transition(
    "agent-0",
    updated,
    "handedoff",
    "fixture",
  );
  const ctx = fresh(f, "group:20000");
  f.runtime.subject.begin(ctx, [{ intentId: i.id }]);
  await assert.rejects(
    f.runtime.callTool(ctx, "intent_decide", {
      id: i.id,
      expectedRevision: handed.revision,
      action: "send",
      reason: "attempt",
    }),
    /RECALL_SOURCE_NOT_ALLOWED/,
  );
  assert.equal(f.runtime.transports.get("qq-0").sent.length, 0);
  await assert.rejects(
    f.runtime.callTool(ctx, "intent_decide", {
      id: i.id,
      expectedRevision: handed.revision,
      action: "cancel",
      reason: "cancel safely",
    }),
    /RECALL_SOURCE_NOT_ALLOWED/,
  );
});

test("completed contact history keeps protected reasons in implicit subject handoff", async (t) => {
  const f = setup(t),
    a = f.runtime.agent("agent-0");
  a.subject.groups = ["20000"];
  f.ctx.privateRead.add("github-private:" + repo);
  const i = await f.runtime.callTool(f.ctx, "intent_create", {
    topic: "protected",
    target: "group:20000",
    reason: "test",
    expiresAt: f.runtime.now() + 100000,
  });
  f.runtime.subject.transition("agent-0", i, "completed", "protected history");
  const ctx = fresh(f, "@subject"),
    prepared = f.runtime.contexts.prepare(ctx, {}, []);
  assert(!prepared.prompt.includes("protected history"));
  assert(!ctx.privateRead.has("github-private:" + repo));
});

test("subject can create a protected text file in its library without terminal access", async (t) => {
  const { FileStore } = await import("../src/tools/files.mjs");
  const { scopedCatalog } = await import("../src/tools/catalog.mjs");
  const f = setup(t),
    a = f.runtime.agent("agent-0");
  a.files.enabled = true;
  a.files.create = true;
  a.files.send = true;
  a.tools.push("file_create", "file_list", "qq_send_file");
  f.runtime.files = new FileStore(f.root + "/files");
  const ctx = fresh(f, "@subject");
  ctx.privateRead.add("github-private:" + repo);
  const tools = scopedCatalog(f.runtime, ctx, {
    names: ["file_create", "file_list"],
  }).tools;
  assert.deepEqual(
    tools.map((x) => x.name),
    ["file_create", "file_list"],
  );
  assert(!f.runtime.toolsFor(a, "@subject").includes("terminal_open"));
  assert(!f.runtime.toolsFor(a, "@subject").includes("qq_send_file"));
  const file = await f.runtime.callTool(ctx, "file_create", {
    name: "article.md",
    text: "# My article\nPrivate framework reflections.",
  });
  assert.deepEqual(file.protectedRepositories, [repo]);
  assert.equal(
    f.runtime.files
      .read("agent-0", file.fileId, a.files.maxBytes)
      .buffer.toString(),
    "# My article\nPrivate framework reflections.",
  );
  assert.deepEqual((await f.runtime.callTool(ctx, "file_list", {})).items, []);
  await assert.rejects(
    f.runtime.callTool(ctx, "file_create", { name: "../escape.md", text: "x" }),
    /INVALID_FILE_NAME/,
  );
  let sends = 0;
  f.runtime.transports.get("qq-0").sendFile = async () => {
    sends++;
    return { confirmed: true };
  };
  await assert.rejects(
    f.runtime.callTool(fresh(f, "group:20000"), "qq_send_file", {
      requestId: "file-leak",
      fileId: file.fileId,
    }),
    /RECALL_SOURCE_NOT_ALLOWED/,
  );
  assert.equal(sends, 0);
  await assert.rejects(
    f.runtime.callTool(fresh(f), "qq_send_file", {
      requestId: "owner-file",
      fileId: file.fileId,
    }),
    /RECALL_SOURCE_NOT_ALLOWED/,
  );
  assert.equal(sends, 0);
});

test("paginated work notes apply protection only when their content is included", async (t) => {
  const f = setup(t),
    note = await protectedNote(f);
  for (let n = 0; n < 8; n++)
    f.m.identity.saveNote(
      input([f.source.id], { body: "ordinary " + n }),
      "private:30000",
      f.runtime.now(),
    );
  const ctx = fresh(f);
  const first = await f.runtime.callTool(ctx, "work_notes", {});
  assert.equal(first.nextOffset, null);
  assert(!ctx.privateRead.has("github-private:" + repo));
  const last = await f.runtime.callTool(ctx, "work_notes", { offset: 8 });
  assert.deepEqual(last.items, []);
  assert(!ctx.privateRead.has("github-private:" + repo));
  assert(
    f.m.identity
      .get("work_notes", note.id)
      .protectedRepositories.includes(repo),
  );
});

test("export, restore and database reopen retain note and intent protection", async (t) => {
  const { MemoryStore } = await import("../src/memory/store.mjs");
  const { restoreExport } = await import("../src/memory/migrate.mjs");
  const f = setup(t),
    note = await protectedNote(f, { ops: true });
  const a = f.runtime.agent("agent-0");
  a.subject.groups = ["20000"];
  const protectedCtx = fresh(f);
  await f.runtime.callTool(protectedCtx, "work_notes", {});
  protectedCtx.privateRead.add("operations:legacy");
  protectedCtx.privateRead.add("github-private:" + repo);
  const intent = await f.runtime.callTool(protectedCtx, "intent_create", {
    topic: "protected",
    target: "group:20000",
    reason: "test",
    expiresAt: f.runtime.now() + 100000,
  });
  const file = f.root + "/restored.sqlite";
  const target = new MemoryStore(file);
  try {
    restoreExport(target.bind("agent-0"), f.m.export());
  } finally {
    target.close();
  }
  const reopened = new MemoryStore(file);
  try {
    const m = reopened.bind("agent-0");
    for (const row of [
      m.identity.notes("private:30000")[0],
      m.identity.get("intentions", intent.id),
    ]) {
      assert.equal(row.protectedOperations, true);
      assert.deepEqual(row.protectedRepositories, [repo]);
    }
    assert.equal(m.identity.notes("private:30000")[0].id, note.id);
  } finally {
    reopened.close();
  }
});

test("ordinary self evidence stays strict while only note and intent storage accept protected ancestry", async (t) => {
  const { freezeEvidence } = await import("../src/memory/evidence.mjs");
  const f = setup(t);
  const protectedSource = f.m.append({
    dedupe: "protected-source",
    conversation: "@subject",
    kind: "github.read",
    body: "private",
    payload: { protectedRepositories: [repo] },
  });
  assert.throws(
    () => freezeEvidence(f.m, [protectedSource.id], f.runtime.now()),
    /RESTRICTED_EVIDENCE/,
  );
  const note = f.m.identity.saveNote(
    input([protectedSource.id]),
    f.ctx.conversation,
    f.runtime.now(),
  );
  f.m.db.prepare("DELETE FROM events WHERE id=?").run(protectedSource.id);
  const ctx = fresh(f);
  await f.runtime.callTool(ctx, "work_notes", {});
  assert(!ctx.privateRead.has("github-private:" + repo));
  assert.deepEqual(
    f.m.identity.notes("private:30000")[0].protectedRepositories,
    [repo],
  );
  assert.doesNotThrow(() => f.runtime.assertDisclosure(ctx));
  assert.equal(note.evidence[0], protectedSource.id);
});

test("protection added after selecting an intent is rechecked before the gateway", async (t) => {
  const f = setup(t),
    a = f.runtime.agent("agent-0");
  a.subject.groups = ["20000"];
  const i = await f.runtime.callTool(f.ctx, "intent_create", {
    topic: "ordinary",
    target: "group:20000",
    reason: "test",
    expiresAt: f.runtime.now() + 100000,
  });
  const handed = f.runtime.subject.transition(
    "agent-0",
    i,
    "handedoff",
    "fixture",
  );
  const ctx = fresh(f, "group:20000");
  f.runtime.subject.begin(ctx, [{ intentId: i.id }]);
  await f.runtime.callTool(ctx, "intent_decide", {
    id: i.id,
    expectedRevision: handed.revision,
    action: "send",
    reason: "ordinary",
  });
  const selected = f.m.identity.get("intentions", i.id);
  f.m.identity.put("intentions", {
    ...selected,
    protectedRepositories: [repo],
  });
  await assert.rejects(
    f.runtime.send(ctx, { requestId: "late-leak", text: "copy" }),
    /REQUIRES_DISCLOSURE_GRANT/,
  );
  assert.equal(f.runtime.transports.get("qq-0").sent.length, 0);
  assert.equal(f.m.delivery("intent:" + i.id), undefined);
});
