import path from "node:path";
import { MemoryStore } from "../src/memory/store.mjs";
import { Runtime } from "../src/core/runtime.mjs";
import { boardTool } from "../src/tools/board.mjs";
import { sourceClass } from "../src/core/outbound-policy.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { config, fixture, context, disclosureApproval } from "./helpers.mjs";
import { mergeProtection } from "../src/memory/protection.mjs";
import { restoreExport } from "../src/memory/migrate.mjs";
import { recallBoundary } from "../src/core/recall-boundary.mjs";
import {
  contextProtection,
  trackMindRecords,
} from "../src/core/protected-mind.mjs";
import {
  peerQzoneMarker,
  peerQzoneSources,
} from "../src/core/peer-qzone-protection.mjs";

const target = "30000";
const marker = peerQzoneMarker(target);
const scope = `private:${target}`;
function setup(t) {
  const cfg = config(1);
  cfg.agents[0].allow.users.push("30001");
  cfg.agents[0].network.autonomous = true;
  cfg.agents[0].subject.enabled = true;
  const f = fixture(t, { cfg });
  return { ...f, m: f.store.bind("agent-0") };
}
function source(f, conversation = scope) {
  return f.m.append({
    dedupe: "qzone-source",
    conversation,
    kind: "external.read",
    direction: "internal",
    body: "PEER_QZONE_PRIVATE_TEXT",
    payload: {
      protectedPeerQzoneTargets: [target],
      epistemic: "external-source-claim",
    },
  });
}

test("peer protection metadata is validated and merged monotonically", () => {
  assert.deepEqual(
    mergeProtection(
      { protectedPeerQzoneTargets: [target] },
      { protectedPeerQzoneTargets: ["30001", target] },
    ),
    { protectedPeerQzoneTargets: [target, "30001"] },
  );
  for (const value of ["30000", [30000], [""], ["invalid"], ["030000"]])
    assert.throws(
      () => mergeProtection({ protectedPeerQzoneTargets: value }),
      /INVALID_PROTECTION_METADATA/,
    );
});

test("only the subject's private chat can send without an explicit disclosure grant", (t) => {
  const f = setup(t);
  for (const conversation of [scope, "private:30001", "group:20000"]) {
    const ctx = context(f.runtime, "agent-0", conversation);
    ctx.privateRead.add(marker);
    if (conversation === scope) f.runtime.assertDisclosure(ctx);
    else {
      assert.throws(
        () => f.runtime.assertDisclosure(ctx),
        /PRIVATE_RECOLLECTION_REQUIRES_DISCLOSURE_GRANT/,
      );
      f.runtime.grant(disclosureApproval(ctx));
      f.runtime.assertDisclosure(ctx);
      const restarted = context(f.runtime, "agent-0", conversation);
      assert(restarted.privateRead.has(marker));
      assert.throws(
        () => f.runtime.assertDisclosure(restarted),
        /PRIVATE_RECOLLECTION_REQUIRES_DISCLOSURE_GRANT/,
      );
    }
    assert.throws(
      () =>
        f.runtime.assertDisclosure(
          context(f.runtime, "agent-0", conversation),
          { external: true },
        ),
      /PRIVATE_RECOLLECTION_EXTERNAL_CALL_BLOCKED/,
    );
  }
});

test("stored peer sources are filtered before recall in groups, other chats, subject and protected tasks", (t) => {
  const f = setup(t),
    event = source(f, "group:20000");
  for (const conversation of ["group:20000", "private:30001", "@subject"]) {
    const ctx = context(f.runtime, "agent-0", conversation);
    const boundary = recallBoundary(f.runtime, ctx);
    assert.equal(boundary.allowed({ id: event.id }), false);
    assert.equal(boundary.allowed({ evidence: [event.id] }), false);
    assert.equal(
      boundary.allowed({
        evidenceSnapshot: {
          references: [{ metadata: { protectedPeerQzoneTargets: [target] } }],
        },
      }),
      false,
    );
    assert.equal(
      boundary.allowed({ scene: { messages: [{ id: event.id }] } }),
      true,
    );
    assert.equal(
      boundary.rows([
        { id: "scene", scene: { messages: [{ id: event.id }] } },
      ])[0].sceneWithheld,
      true,
    );
  }
  const own = context(f.runtime, "agent-0", scope);
  assert.equal(recallBoundary(f.runtime, own).allowed({ id: event.id }), true);
  assert.equal(
    recallBoundary(f.runtime, own, { publicOnly: true }).allowed({
      id: event.id,
    }),
    false,
  );
});

test("diary writes inherit the whole context and revisions cannot remove peer protection", async (t) => {
  const f = setup(t),
    event = source(f),
    ctx = context(f.runtime, "agent-0", scope);
  ctx.privateRead.add(event.id);
  const diary = await f.runtime.callTool(ctx, "diary_write", {
    title: "peer diary",
    body: "private derivative",
    evidence: [],
  });
  const revised = await f.runtime.callTool(ctx, "diary_revise", {
    id: diary.id,
    expectedRevision: 1,
    title: "revised",
    body: "still private",
    evidence: [],
  });
  assert.equal(revised.revision, 2);
  const row = f.m.db
    .prepare("SELECT metadata FROM diaries WHERE id=?")
    .get(diary.id);
  assert.deepEqual(JSON.parse(row.metadata).protectedPeerQzoneTargets, [
    target,
  ]);
  f.m.db.prepare("DELETE FROM events WHERE id=?").run(event.id);
  const group = context(f.runtime);
  group.privateRead.add(diary.id);
  assert.deepEqual(peerQzoneSources(f.runtime, group), [target]);
  assert.throws(
    () => f.runtime.assertDisclosure(group),
    /REQUIRES_DISCLOSURE_GRANT/,
  );
  assert.equal(
    recallBoundary(f.runtime, group).allowed({ id: diary.id }),
    false,
  );
  const own = context(f.runtime, "agent-0", scope);
  assert.equal(recallBoundary(f.runtime, own).allowed({ id: diary.id }), true);
});

test("notes and intentions preserve peer metadata after evidence and source deletion", (t) => {
  const f = setup(t),
    event = source(f),
    ctx = context(f.runtime, "agent-0", scope);
  ctx.privateRead.add(event.id);
  const note = f.m.identity.saveNote(
    { body: "private note", evidence: [event.id], uncertainty: "source claim" },
    scope,
    Date.now(),
    contextProtection(f.runtime, ctx),
  );
  assert.deepEqual(note.protectedPeerQzoneTargets, [target]);
  const edited = f.m.identity.saveNote(
    {
      id: note.id,
      body: "revised note",
      evidence: [event.id],
      uncertainty: "source claim",
    },
    scope,
    Date.now(),
    {},
  );
  assert.deepEqual(edited.protectedPeerQzoneTargets, [target]);
  const intent = {
    id: "peer-intent",
    target: "group:20000",
    evidence: [],
    ...mergeProtection(edited),
  };
  f.m.db
    .prepare("INSERT INTO intentions VALUES(?,?,?)")
    .run("agent-0", intent.id, JSON.stringify(intent));
  f.m.db.prepare("DELETE FROM events WHERE id=?").run(event.id);
  const group = context(f.runtime);
  trackMindRecords(f.runtime, group, [intent]);
  assert(group.privateRead.has(marker));
  assert.throws(
    () => f.runtime.assertDisclosure(group),
    /REQUIRES_DISCLOSURE_GRANT/,
  );
  assert.equal(
    f.runtime.subject.canAutoDisclose(f.runtime.agent("agent-0"), intent),
    false,
  );
});

test("shared Self, person and board writes cannot launder a peer-tainted context", async (t) => {
  const f = setup(t),
    ctx = context(f.runtime, "agent-0", scope);
  ctx.privateRead.add(marker);
  f.runtime.config.board.enabled = true;
  assert.throws(
    () =>
      boardTool(f.runtime, ctx, "board_post", {
        title: "private",
        body: "private material",
      }),
    /RESTRICTED_CONTEXT_MIND_WRITE_BLOCKED/,
  );
  for (const name of ["self_propose", "person_note", "mood_set", "project"]) {
    const args =
      name === "self_propose"
        ? {
            body: "new self",
            reason: "reason",
            evidence: [],
            counterEvidence: [],
            scope: "interest",
            expectedVersion: 1,
          }
        : name === "person_note"
          ? {
              personId: target,
              body: "private material",
              evidence: [],
              uncertainty: "claim",
            }
          : name === "mood_set"
            ? {
                feeling: "calm",
                reason: "private material",
                intensity: 1,
                energy: 1,
                evidence: [],
              }
            : {
                title: "private project",
                status: "active",
                summary: "private material",
                evidence: [],
              };
    // The guard runs independently of schema validation through the dispatcher.
    const { mindTool } = await import("../src/tools/mind.mjs");
    assert.throws(
      () => mindTool(f.runtime, ctx, name, args),
      /RESTRICTED_CONTEXT_MIND_WRITE_BLOCKED/,
    );
  }
});

test("autonomous external grants do not authorize disclosure of peer content", (t) => {
  const f = setup(t),
    ctx = context(f.runtime, "agent-0", scope);
  ctx.privateRead.add(marker);
  assert.throws(
    () =>
      f.runtime.authorizeExternal(ctx, {
        tool: "web_fetch",
        args: { url: "https://example.com/?q=private" },
      }),
    /PRIVATE_RECOLLECTION_EXTERNAL_CALL_BLOCKED/,
  );
  assert.equal(ctx.disclosureRequest.reason, "external-service");
});

test("export and restore keep durable markers and derivative metadata", (t) => {
  const f = setup(t),
    event = source(f);
  const ctx = context(f.runtime, "agent-0", "group:20000");
  ctx.privateRead.add(event.id);
  assert.throws(
    () => f.runtime.assertDisclosure(ctx),
    /REQUIRES_DISCLOSURE_GRANT/,
  );
  const diary = f.m.diaryWrite(
    { title: "backup", body: "private derivative" },
    "ai-diary",
    { conversation: scope },
    false,
    [],
    [target],
  );
  const exported = f.m.export();
  const restored = setup(t);
  for (const table of Object.keys(exported.tables)) {
    if (
      restored.m.db
        .prepare(`PRAGMA table_info(${table})`)
        .all()
        .some((column) => column.name === "agent_id")
    )
      restored.m.db
        .prepare(`DELETE FROM ${table} WHERE agent_id=?`)
        .run("agent-0");
  }
  restoreExport(restored.m, exported);
  assert(restored.m.state("group:20000").disclosureTaint.includes(marker));
  const group = context(restored.runtime);
  assert.equal(
    recallBoundary(restored.runtime, group).allowed({ id: diary.id }),
    false,
  );
  assert.throws(
    () => restored.runtime.assertDisclosure(group),
    /REQUIRES_DISCLOSURE_GRANT/,
  );
});

test("bare snapshot IDs and direct diary evidence retain the source boundary", (t) => {
  const f = setup(t),
    event = source(f),
    group = context(f.runtime);
  for (const key of ["evidenceSnapshot", "counterEvidenceSnapshot"])
    assert.equal(
      recallBoundary(f.runtime, group).allowed({
        [key]: { references: [{ id: event.id }] },
      }),
      false,
    );
  const diary = f.m.diaryWrite({
    title: "direct evidence",
    body: "private source",
    evidence: [event.id],
  });
  f.m.db.prepare("DELETE FROM events WHERE id=?").run(event.id);
  assert.equal(
    recallBoundary(f.runtime, group).allowed({ id: diary.id }),
    false,
  );
});

test("reading a source persists a marker before its original event is deleted", async (t) => {
  const f = setup(t),
    event = source(f),
    own = context(f.runtime, "agent-0", scope);
  await f.runtime.callTool(own, "memory_read", { id: event.id });
  assert(f.m.state(scope).disclosureTaint.includes(marker));
  f.m.db.prepare("DELETE FROM events WHERE id=?").run(event.id);
  const restarted = context(f.runtime, "agent-0", scope);
  assert(restarted.privateRead.has(marker));
  assert.throws(
    () => f.runtime.assertDisclosure(restarted, { external: true }),
    /EXTERNAL_CALL_BLOCKED/,
  );
});

test("QQ delivery blocks group disclosure before sending and records approved source protection", async (t) => {
  const f = setup(t),
    own = context(f.runtime, "agent-0", scope),
    group = context(f.runtime);
  own.privateRead.add(marker);
  const sent = await f.runtime.send(own, {
    requestId: "own-peer-qzone",
    text: "给本人回复",
  });
  assert.equal(sent.status, "sent");
  group.privateRead.add(marker);
  const transport = f.runtime.transports.get("qq-0"),
    before = transport.sent.length;
  await assert.rejects(
    f.runtime.send(group, { requestId: "group-peer-qzone", text: "受限资料" }),
    /REQUIRES_DISCLOSURE_GRANT/,
  );
  assert.equal(transport.sent.length, before);
  f.runtime.grant(disclosureApproval(group));
  assert.equal(
    (
      await f.runtime.send(group, {
        requestId: "group-peer-qzone",
        text: "已批准的资料",
      })
    ).status,
    "sent",
  );
  const record = f.m.db
    .prepare("SELECT payload FROM events WHERE dedupe=? AND agent_id=?")
    .get("send:group-peer-qzone:sent", "agent-0");
  assert.deepEqual(JSON.parse(record.payload).protectedPeerQzoneTargets, [
    target,
  ]);
});

test("diary creation and revision union evidence, previous and context targets", (t) => {
  const f = setup(t),
    a = source(f);
  const b = f.m.append({
    dedupe: "source-b",
    conversation: scope,
    kind: "external.read",
    body: "source B",
    payload: { protectedPeerQzoneTargets: ["30001"] },
  });
  const diary = f.m.diaryWrite(
    { title: "mixed", body: "combined", evidence: [a.id] },
    "ai-diary",
    { conversation: scope },
    false,
    [],
    ["30001"],
  );
  let row = f.m.db
    .prepare("SELECT metadata FROM diaries WHERE id=?")
    .get(diary.id);
  assert.deepEqual(JSON.parse(row.metadata).protectedPeerQzoneTargets, [
    "30000",
    "30001",
  ]);
  const original = f.m.diaryWrite({
    title: "original",
    body: "A",
    evidence: [a.id],
  });
  f.m.diaryRevise(
    {
      id: original.id,
      expectedRevision: 1,
      title: "mixed revised",
      body: "A+B+C",
      evidence: [b.id],
    },
    false,
    [],
    ["30002"],
  );
  row = f.m.db
    .prepare("SELECT metadata FROM diaries WHERE id=?")
    .get(original.id);
  assert.deepEqual(JSON.parse(row.metadata).protectedPeerQzoneTargets, [
    "30000",
    "30001",
    "30002",
  ]);
});

test("peer ownership never weakens operations or private repository protection on mixed sources", (t) => {
  const f = setup(t),
    own = context(f.runtime, "agent-0", scope);
  for (const [kind, protection] of [
    ["operations", { protectedOperations: true }],
    ["private-repository", { protectedRepositories: ["fixture/private"] }],
  ]) {
    const event = f.m.append({
      dedupe: "mixed-" + kind,
      conversation: scope,
      kind: "external.read",
      body: "mixed private content",
      payload: { protectedPeerQzoneTargets: [target], ...protection },
    });
    assert.equal(sourceClass(f.runtime, own, event.id), kind);
    assert.equal(
      recallBoundary(f.runtime, own).allowed({ evidence: [event.id] }),
      false,
    );
    own.privateRead.add(event.id);
  }
  const protection = contextProtection(f.runtime, own);
  assert.equal(protection.protectedOperations, true);
  assert.deepEqual(protection.protectedRepositories, ["fixture/private"]);
  assert.deepEqual(protection.protectedPeerQzoneTargets, [target]);
});

test("daily work isolation preserves peer-only taint and the subject's valid private session", (t) => {
  const f = setup(t),
    ctx = context(f.runtime, "agent-0", scope);
  ctx.privateRead.add(marker);
  ctx.persistTaint();
  f.m.setState(scope, {
    ...f.m.state(scope),
    protectedWorkIsolation: 1,
    session: { id: "peer-native-session", backendId: "fixture", type: "codex" },
  });
  f.runtime.protectedWork.prepareDaily("agent-0", scope);
  const state = f.m.state(scope);
  assert(state.disclosureTaint.includes(marker));
  assert.equal(state.session.id, "peer-native-session");
});

test("reopening SQLite and Runtime preserves private continuity and blocks group disclosure", async (t) => {
  const f = setup(t);
  const sessions = new Map();
  for (const conversation of [scope, "group:20000"]) {
    const ctx = context(f.runtime, "agent-0", conversation);
    ctx.privateRead.add(marker);
    ctx.persistTaint();
    const session = {
      id:
        conversation === scope ? "private-peer-session" : "group-peer-session",
      backendId: "fixture",
      type: "codex",
    };
    sessions.set(conversation, session);
    f.m.setState(conversation, {
      ...f.m.state(conversation),
      protectedWorkIsolation: 1,
      session,
    });
  }
  await f.runtime.close();
  const store = new MemoryStore(path.join(f.root, "memory.sqlite"));
  const runtime = new Runtime({ memory: store, configStore: f.configStore });
  t.after(async () => {
    await runtime.close();
    store.close();
  });
  for (const conversation of [scope, "group:20000"]) {
    const state = store.bind("agent-0").state(conversation);
    assert.deepEqual(state.session, sessions.get(conversation));
    assert(state.disclosureTaint.includes(marker));
    const resumed = context(runtime, "agent-0", conversation);
    if (conversation === scope) runtime.assertDisclosure(resumed);
    else
      assert.throws(
        () => runtime.assertDisclosure(resumed),
        /REQUIRES_DISCLOSURE_GRANT/,
      );
  }
});
