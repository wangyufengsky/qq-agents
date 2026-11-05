import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fixture, context, config } from "./helpers.mjs";
import { createServer } from "../src/server.mjs";
import { HOME_TOOLS, HOME_READ_TOOLS } from "../src/home/policy.mjs";
import { RoomStore } from "../src/home/room-store.mjs";
import { MemoryStore } from "../src/memory/store.mjs";
import { backupDatabase } from "../src/memory/backup.mjs";
function setup(t, limit = 20) {
  const cfg = config();
  for (const a of cfg.agents) {
    a.subject.enabled = true;
    a.home = { enabled: true, publishing: true, maxWritesPerDay: limit };
  }
  const f = fixture(t, { cfg });
  const ctx = context(f.runtime, "agent-0", "@subject");
  return {
    ...f,
    ctx,
    call: (name, args = {}, c = ctx) => f.runtime.executeTool(c, name, args),
  };
}
async function publication(
  f,
  requestId = "publish-0001",
  slot = "intro",
  c = f.ctx,
) {
  const v = await f.call("room_read", {}, c);
  return {
    identityGeneration: v.identityGeneration,
    requestId,
    slot,
    expectedItemRevision: v.items.find((i) => i.slot === slot).itemRevision,
    title: "纸页上的问候",
    body: "原创合成文字",
    source: "original-text",
  };
}
async function patch(f, requestId = "layout-0001", c = f.ctx) {
  const v = await f.call("room_scene_read", {}, c);
  return {
    identityGeneration: v.identityGeneration,
    requestId,
    expectedLayoutRevision: v.layoutRevision,
    operations: [{ action: "palette", palette: "rose" }],
  };
}
function count(f, table) {
  return f.store.db.prepare(`SELECT count(*) n FROM ${table}`).get().n;
}
test("home defaults deny discovery and forged dispatch, with immediate revocation", async (t) => {
  const f = fixture(t),
    c = context(f.runtime);
  assert.deepEqual(f.runtime.agent("agent-0").home, {
    enabled: false,
    publishing: false,
    maxWritesPerDay: 20,
    intents: {
      enabled: false,
      hints: true,
      ttlDays: 7,
      maxPending: 20,
      maxSubmissionsPerDay: 20,
    },
  });
  for (const scope of ["group:20000", "private:30000", "@subject"]) {
    assert.equal(
      f.runtime
        .toolsFor(f.runtime.agent("agent-0"), scope)
        .some((n) => HOME_TOOLS.includes(n)),
      false,
    );
  }
  c.allowedTools = [...HOME_TOOLS];
  await assert.rejects(
    f.runtime.executeTool(c, "room_read", {}),
    /TOOL_DISABLED/,
  );
  const on = setup(t),
    p = await publication(on);
  on.runtime.agent("agent-0").home.publishing = false;
  await assert.rejects(on.call("room_publish", p), /TOOL_DISABLED/);
  assert.ok(
    on.runtime
      .toolsFor(on.runtime.agent("agent-0"), "@subject")
      .includes("room_retract"),
  );
  on.runtime.agent("agent-0").home.enabled = false;
  await assert.rejects(on.call("room_read"), /TOOL_DISABLED/);
  assert.equal(count(on, "home_items"), 0);
});
test("each enabled conversation reads only its own room; protected work is read-only", async (t) => {
  const f = setup(t),
    p = await publication(f);
  await f.call("room_publish", p);
  for (const scope of ["group:20000", "private:30000"]) {
    const c = context(f.runtime, "agent-0", scope);
    assert.equal((await f.call("room_read", {}, c)).items[0].body, p.body);
    c.allowedTools = [...HOME_TOOLS];
    await assert.rejects(f.call("room_publish", p, c), /TOOL_DISABLED/);
    await assert.rejects(f.call("room_read", { agentId: "agent-1" }, c));
  }
  const other = context(f.runtime, "agent-1", "@subject");
  assert.equal((await f.call("room_read", {}, other)).items[0].state, "empty");
  await assert.rejects(
    f.call("room_publish", p, other),
    /HOME_IDENTITY_CHANGED/,
  );
  f.runtime.agent("agent-0").operations.enabled = true;
  const task = f.runtime.protectedWork.create({
    agentId: "agent-0",
    instruction: "Synthetic review",
    operations: true,
  });
  const scope = "@work:" + task.id,
    work = context(f.runtime, "agent-0", scope);
  const tools = f.runtime.toolsFor(f.runtime.agent("agent-0"), scope);
  assert.deepEqual(
    tools.filter((n) => HOME_TOOLS.includes(n)),
    [...HOME_READ_TOOLS],
  );
  assert.equal((await f.call("room_read", {}, work)).items[0].body, p.body);
  await assert.rejects(f.call("room_publish", p, work), /TOOL_DISABLED/);
});
test("layout batch preview, conflict, replay and undo preserve distinct revisions", async (t) => {
  const f = setup(t),
    p = await patch(f);
  const preview = await f.call("room_scene_patch", { ...p, dryRun: true });
  assert.equal(preview.preview, true);
  assert.equal(preview.committed, false);
  assert.equal(count(f, "home_operations"), 0);
  assert.equal(count(f, "home_write_usage"), 0);
  await assert.rejects(
    f.call("room_scene_patch", {
      ...p,
      operations: [
        ...p.operations,
        { action: "object", instanceId: "unknown", value: { hidden: true } },
      ],
    }),
    /HOME_SCENE_INVALID/,
  );
  assert.equal(count(f, "home_layouts"), 0);
  const stale = context(f.runtime, "agent-0", "@subject");
  const old = await patch(f, "stale-0001", stale);
  const saved = await f.call("room_scene_patch", p);
  assert.equal(saved.layoutRevision, 1);
  assert.equal(saved.contentRevision, 0);
  assert.equal((await f.call("room_scene_patch", p)).replayed, true);
  await assert.rejects(
    f.call("room_scene_patch", old, stale),
    /HOME_REVISION_CONFLICT/,
  );
  const next = await patch(f, "undo-00001");
  const undo = await f.call("room_scene_undo", {
    identityGeneration: next.identityGeneration,
    requestId: next.requestId,
    expectedLayoutRevision: 1,
    undoRevision: 0,
  });
  assert.equal(undo.layoutRevision, 2);
  assert.equal(f.runtime.home.read("room", "agent-0").layout.palette, "cream");
  assert.equal(f.runtime.home.read("room", "agent-1").layoutRevision, 0);
  await assert.rejects(
    f.call("room_publish", {
      ...(await publication(f)),
      requestId: p.requestId,
    }),
    /HOME_REQUEST_CONFLICT/,
  );
});
test("slot revisions permit independent edits and reject stale writes without automatic overwrite", async (t) => {
  const f = setup(t),
    a = await publication(f);
  const c = context(f.runtime, "agent-0", "@subject"),
    b = await publication(f, "publish-0002", "work-1", c);
  const stale = { ...a, requestId: "publish-stale" };
  const first = await f.call("room_publish", a);
  assert.equal(first.itemRevision, 1);
  assert.equal((await f.call("room_publish", b, c)).contentRevision, 2);
  await assert.rejects(f.call("room_publish", stale, c), /HOME_READ_REQUIRED/);
  await f.call("room_read", {}, c);
  await assert.rejects(
    f.call("room_publish", { ...stale, expectedItemRevision: 1 }, c).then(() =>
      f.call("room_publish", {
        ...stale,
        requestId: "publish-late",
        expectedItemRevision: 1,
      }),
    ),
    /HOME_ITEM_CONFLICT/,
  );
  const fresh = context(f.runtime, "agent-0", "@subject");
  await assert.rejects(
    f.call("room_publish", { ...a, requestId: "without-read" }, fresh),
    /HOME_READ_REQUIRED/,
  );
  assert.equal((await f.call("room_publish", a, fresh)).replayed, true);
});
test("retract and administrator hold erase display text; historical receipts never restore it", async (t) => {
  const f = setup(t),
    a = await publication(f),
    saved = await f.call("room_publish", a);
  const mod = {
    identityGeneration: a.identityGeneration,
    requestId: "admin-hide-1",
    slot: a.slot,
    expectedItemRevision: 1,
    action: "hide",
  };
  f.runtime.home.rooms.moderate("agent-0", mod);
  assert.equal(f.runtime.home.rooms.moderate("agent-0", mod).replayed, true);
  const replay = await f.call("room_publish", a);
  assert.equal(replay.replayed, true);
  assert.equal(replay.current.items[0].state, "hidden");
  assert.equal(replay.current.items[0].body, undefined);
  await assert.rejects(
    f.call("room_publish", await publication(f, "blocked-new")),
    /HOME_ITEM_HIDDEN/,
  );
  f.runtime.home.rooms.moderate("agent-0", {
    ...mod,
    requestId: "release-0001",
    expectedItemRevision: 2,
    action: "release",
  });
  assert.equal((await f.call("room_read")).items[0].state, "retracted");
  const republished = await f.call(
    "room_publish",
    await publication(f, "republish-01"),
  );
  assert.equal(republished.itemId, saved.itemId);
  assert.equal(republished.itemRevision, 4);
  const current = await publication(f, "retract-0001");
  const { title: _title, body: _body, source: _source, ...retract } = current;
  f.ctx.privateRead.add("operations:synthetic");
  await f.call("room_retract", retract);
  assert.equal(
    (
      await f.call("room_operation_status", {
        identityGeneration: a.identityGeneration,
        requestId: a.requestId,
      })
    ).current.items[0].state,
    "retracted",
  );
  assert.equal(
    (
      await f.call("room_operation_status", {
        identityGeneration: a.identityGeneration,
        requestId: "unknown-0001",
      })
    ).status,
    "unknown",
  );
  assert.equal(
    f.store.db.prepare("SELECT body FROM home_items").get().body,
    "",
  );
  assert.ok(
    !JSON.stringify(
      f.store.db.prepare("SELECT * FROM home_operations").all(),
    ).includes(a.body),
  );
  assert.equal(count(f, "home_items"), 1);
});
test("protected sources, inactive capabilities and credentials cannot publish or arrange", async (t) => {
  const f = setup(t);
  for (const marker of [
    "context:private:30000",
    "context:group:20000",
    "operations:synthetic",
    "github-private:example/private",
    "peer-qzone:30000",
    "unknown-legacy-record",
  ]) {
    const c = context(f.runtime, "agent-0", "@subject"),
      p = await publication(f, "denied-00001", "intro", c),
      layout = await patch(f, "denied-00002", c);
    c.privateRead.add(marker);
    await assert.rejects(f.call("room_publish", p, c), /HOME_SOURCE_DENIED/);
    await assert.rejects(
      f.call("room_scene_patch", layout, c),
      /HOME_SOURCE_DENIED/,
    );
  }
  for (const invalidate of [
    (c) => c.controller.abort(),
    (c) => (c.expires = 0),
    (c) => f.runtime.capabilities.delete(c.token),
  ]) {
    const c = context(f.runtime, "agent-0", "@subject"),
      p = await publication(f, "inactive-001", "intro", c);
    invalidate(c);
    await assert.rejects(
      f.call("room_publish", p, c),
      /AGENT_PAUSED_OR_EXPIRED/,
    );
  }
  const p = await publication(f);
  await assert.rejects(
    f.call("room_publish", { ...p, body: f.ctx.token }),
    /CAPABILITY_EXFILTRATION_BLOCKED/,
  );
  f.runtime.config.globalPaused = true;
  await assert.rejects(f.call("room_publish", p), /AGENT_PAUSED_OR_EXPIRED/);
  f.runtime.config.globalPaused = false;
  f.runtime.configChanging = true;
  await assert.rejects(
    f.call("room_publish", p),
    /HOME_WRITE_DENIED|AGENT_PAUSED_OR_EXPIRED/,
  );
  f.runtime.configChanging = false;
  assert.equal(count(f, "home_items"), 0);
});
test("quota charges only new successes, retract is exempt, failed transactions leave no effects", async (t) => {
  const f = setup(t, 1),
    p = await publication(f);
  f.store.db.exec(
    "CREATE TRIGGER test_home_receipt_failure BEFORE INSERT ON home_operations BEGIN SELECT RAISE(ABORT,'synthetic'); END",
  );
  await assert.rejects(f.call("room_publish", p), /synthetic/);
  for (const table of [
    "home_items",
    "home_rooms",
    "home_operations",
    "home_write_usage",
  ])
    assert.equal(count(f, table), 0);
  f.store.db.exec("DROP TRIGGER test_home_receipt_failure");
  await f.call("room_publish", p);
  assert.equal((await f.call("room_publish", p)).replayed, true);
  await assert.rejects(
    f.call("room_publish", await publication(f, "over-limit-1", "work-1")),
    /HOME_WRITE_LIMIT/,
  );
  await f.call("room_retract", {
    identityGeneration: p.identityGeneration,
    requestId: "retract-full",
    slot: "intro",
    expectedItemRevision: 1,
  });
  assert.equal(
    f.store.db.prepare("SELECT writes FROM home_write_usage").get().writes,
    1,
  );
});
test("deleted and re-added identity cannot reuse old content, versions or receipts", async (t) => {
  const f = setup(t),
    p = await publication(f);
  await f.call("room_publish", p);
  const original = structuredClone(f.runtime.config),
    next = structuredClone(original);
  next.agents = next.agents.filter((a) => a.id !== "agent-0");
  await f.runtime.commitConfig(next, f.configStore.revision);
  assert.throws(
    () => f.runtime.home.rooms.display("agent-0"),
    /HOME_ROOM_NOT_FOUND/,
  );
  await f.runtime.commitConfig(original, f.configStore.revision);
  const c = context(f.runtime, "agent-0", "@subject"),
    view = await f.call("room_read", {}, c);
  assert.notEqual(view.identityGeneration, p.identityGeneration);
  assert.equal(view.items[0].state, "empty");
  await assert.rejects(f.call("room_publish", p, c), /HOME_IDENTITY_CHANGED/);
  await assert.rejects(
    f.call(
      "room_operation_status",
      { identityGeneration: p.identityGeneration, requestId: p.requestId },
      c,
    ),
    /HOME_IDENTITY_CHANGED/,
  );
});
test("full backup preserves content and receipts, single-role export excludes home tables", async (t) => {
  const f = setup(t),
    p = await publication(f);
  await f.call("room_publish", p);
  await f.call("room_scene_patch", await patch(f));
  const file = path.join(f.root, "home-copy.sqlite");
  assert.equal((await backupDatabase(f.store.file, file)).integrity, "ok");
  const copy = new MemoryStore(file);
  try {
    const rs = new RoomStore(copy.db);
    assert.equal(rs.content(p.identityGeneration, true).items[0].body, p.body);
    assert.equal(rs.receipt(p.identityGeneration, p.requestId).itemRevision, 1);
    assert.equal(rs.layout(p.identityGeneration).layoutRevision, 1);
  } finally {
    copy.close();
  }
  assert.ok(
    !Object.keys(f.store.bind("agent-0").export().tables).some((k) =>
      k.startsWith("home_"),
    ),
  );
});
test("administrator routes authenticate, protect origins, never author room content and clear disabled display", async (t) => {
  const f = setup(t),
    p = await publication(f);
  await f.call("room_publish", p);
  const token = "test-admin-token-placeholder",
    app = createServer({ runtime: f.runtime, token });
  const base = `http://127.0.0.1:${await app.listen()}`;
  t.after(() => app.close());
  const request = (route, body, headers = { "x-admin-token": token }) =>
    fetch(base + route, {
      method: body ? "POST" : "GET",
      headers,
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  const url = "/api/home/content?agentId=agent-0",
    mod = "/api/home/moderate?agentId=agent-0";
  assert.equal((await request(url, null, {})).status, 401);
  assert.equal(
    (
      await request(url, null, {
        "x-admin-token": token,
        origin: "https://example.invalid",
      })
    ).status,
    403,
  );
  assert.equal((await request(url)).status, 200);
  assert.equal((await request(mod, p)).status, 400);
  const before = count(f, "events");
  const res = await request(mod, {
    identityGeneration: p.identityGeneration,
    requestId: "admin-hide-http",
    slot: "intro",
    expectedItemRevision: 1,
    action: "hide",
  });
  assert.equal(res.status, 200);
  assert.equal((await (await request(url)).json()).items[0].body, undefined);
  f.runtime.agent("agent-0").home.enabled = false;
  assert.equal((await (await request(url)).json()).publishing, false);
  assert.equal(count(f, "events"), before);
  assert.equal(f.runtime.jobs.size, 0);
  assert.equal(
    [...f.runtime.transports.values()].flatMap((v) => v.sent).length,
    0,
  );
});

test("ordinary own diary is usable but nested diary evidence cannot launder chat sources", async (t) => {
  const f = setup(t),
    mem = f.store.bind("agent-0");
  const own = mem.diaryWrite({ title: "个人创作", body: "合成原创想法" });
  f.ctx.privateRead.add(own.id);
  await f.call("room_publish", await publication(f));
  const source = mem.append({
    dedupe: "home-chat-evidence",
    conversation: "private:30000",
    kind: "message.received",
    direction: "in",
    status: "observed",
    body: "Synthetic private source",
    payload: {},
  });
  const derived = mem.diaryWrite({
    title: "转述",
    body: "合成转述",
    evidence: [source.id],
  });
  const nested = mem.diaryWrite({
    title: "再次转述",
    body: "合成转述",
    evidence: [derived.id],
  });
  f.ctx.privateRead.add(nested.id);
  await assert.rejects(
    f.call("room_publish", await publication(f, "derived-denied")),
    /HOME_SOURCE_DENIED/,
  );
});
