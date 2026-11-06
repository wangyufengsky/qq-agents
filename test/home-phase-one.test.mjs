import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { fixture, context, config, FakeTransport } from "./helpers.mjs";
import { ConfigStore } from "../src/core/config.mjs";
import { Runtime } from "../src/core/runtime.mjs";
import { MemoryStore } from "../src/memory/store.mjs";
import { backupDatabase } from "../src/memory/backup.mjs";
import { participateInProject } from "../src/core/project-participation.mjs";
import { catalog, catalogVersion } from "../public/home-preview/catalog.mjs";

function setup(t, { sceneView = false } = {}) {
  const cfg = config(7);
  cfg.board.enabled = true;
  cfg.backends = [
    {
      id: "fixture",
      type: "openai",
      label: "Fixture",
      baseUrl: "http://127.0.0.1:9",
      model: "synthetic",
      vision: false,
    },
  ];
  for (const a of cfg.agents) {
    a.subject.enabled = true;
    a.home = {
      enabled: true,
      publishing: true,
      intents: { enabled: true },
      ...(sceneView ? { sceneView: { enabled: true } } : {}),
      projectSnapshots: { enabled: true },
    };
  }
  const f = fixture(t, { cfg });
  // Keep daily board usage and intent expiry stable across the restored runtime.
  f.runtime.clock = () => Date.UTC(2026, 10, 5, 4);
  f.ctx = context(f.runtime, "agent-0", "@subject");
  f.call = (name, args = {}, ctx = f.ctx) =>
    f.runtime.executeTool(ctx, name, args);
  return f;
}
async function publish(f, slot, body, requestId) {
  const read = await f.call("room_read");
  return f.call("room_publish", {
    identityGeneration: read.identityGeneration,
    expectedItemRevision: read.items.find((i) => i.slot === slot).itemRevision,
    slot,
    title: "合成文字",
    body,
    source: "original-text",
    requestId,
  });
}

test("combined home tools keep hallway text scoped and invalidate prior scene descriptions", async (t) => {
  const { mediaLease } = await import("../src/tools/media-lease.mjs");
  const f = setup(t, { sceneView: true }),
    marker = "只属于第一位房主的合成门牌";
  await publish(f, "tagline", marker, "combined-tagline");
  // This regression checks the explicit no-browser text path; real pixels are covered separately.
  const previousBrowser = process.env.QQ_SCREENSHOT_BROWSER;
  process.env.QQ_SCREENSHOT_BROWSER = path.join(f.root, "missing-browser");
  t.after(() => {
    if (previousBrowser === undefined) delete process.env.QQ_SCREENSHOT_BROWSER;
    else process.env.QQ_SCREENSHOT_BROWSER = previousBrowser;
  });
  let now = f.runtime.now();
  f.runtime.clock = () => now;
  const other = context(f.runtime, "agent-1", "@subject");
  const foreign = await f.call(
    "room_scene_view",
    { type: "hall", page: 1 },
    other,
  );
  assert.equal(foreign.imageAvailable, false);
  assert.equal(foreign.reason, "SCREENSHOT_BROWSER_MISSING");
  assert.equal(JSON.stringify(foreign).includes(marker), false);
  const own = await f.call("room_scene_view", { type: "hall", page: 1 });
  assert.ok(JSON.stringify(own).includes(marker));
  assert.equal(own[mediaLease](), true);
  now += 5000;
  const end = await f.call("room_scene_view", { type: "hall", page: 3 });
  assert.equal(end.page, 3);
  assert.equal(end.pages, 3);
  assert.equal(end.residents.length, 1);
  assert.equal(JSON.stringify(end).includes(marker), false);
  const read = await f.call("room_read");
  await f.call("room_retract", {
    identityGeneration: read.identityGeneration,
    expectedItemRevision: read.items.find((i) => i.slot === "tagline")
      .itemRevision,
    slot: "tagline",
    requestId: "combined-retract",
  });
  assert.equal(own[mediaLease](), false);
  now += 5000;
  assert.equal(
    JSON.stringify(await f.call("room_scene_view", { type: "hall" })).includes(
      marker,
    ),
    false,
  );
  assert.equal(f.runtime.jobs.size, 0);
  assert.ok(
    [...f.runtime.transports.values()].every((tr) => tr.sent.length === 0),
  );
});

test("intent execution cannot bypass tagline limits and publishes a valid proposal only once", async (t) => {
  const f = setup(t),
    read = await f.call("room_read");
  const submit = (body, requestId) =>
    f.call("room_intent_submit", {
      identityGeneration: read.identityGeneration,
      requestId,
      proposal: {
        kind: "room_publish",
        slot: "tagline",
        title: "门牌",
        body,
        source: "original-text",
      },
    });
  const resolve = (intent, action, expectedItemRevision = 0) =>
    f.call("room_intent_resolve", {
      identityGeneration: read.identityGeneration,
      intentId: intent.intentId,
      action,
      expectedItemRevision,
    });
  const oversized = await submit("字".repeat(81), "combined-long-intent");
  await resolve(oversized, "accept");
  await f.call("room_read");
  await assert.rejects(resolve(oversized, "execute"), /HOME_ITEM_INVALID/);
  assert.equal(
    f.runtime.home.rooms
      .display("agent-0")
      .items.find((i) => i.slot === "tagline").itemRevision,
    0,
  );
  await resolve(oversized, "reject");
  const valid = await submit("字".repeat(80), "combined-valid-intent");
  await resolve(valid, "accept");
  await f.call("room_read");
  const saved = await resolve(valid, "execute");
  assert.equal(saved.itemRevision, 1);
  const again = await resolve(valid, "execute");
  assert.equal(again.status, "executed");
  assert.equal(
    f.runtime.home.rooms
      .display("agent-0")
      .items.find((i) => i.slot === "tagline").itemRevision,
    1,
  );
});

test("a full synthetic bundle restores content, intent receipts, policy and exact packaged assets", async (t) => {
  const f = setup(t);
  await publish(f, "tagline", "恢复后的合成门牌", "bundle-tagline");
  const project = await f.call("project", {
    title: "合成个人成果",
    why: "恢复验收",
  });
  const joined = participateInProject(f.runtime, "agent-0", {
    id: project.id,
    expectedRevision: project.revision,
    action: "join",
    submissionId: randomUUID(),
  }).project;
  await f.call("projects", { id: project.id });
  const draft = await f.call("project", {
    id: project.id,
    expectedRevision: joined.revision,
    draft: { title: "固定稿", text: "用于备份恢复的合成固定文字。" },
  });
  const read = await f.call("room_read");
  await f.call("room_publish_snapshot", {
    identityGeneration: read.identityGeneration,
    expectedItemRevision: 0,
    slot: "work-1",
    requestId: "bundle-snapshot",
    source: { type: "project-draft", id: draft.id, revision: draft.revision },
  });
  const intent = await f.call("room_intent_submit", {
    identityGeneration: read.identityGeneration,
    requestId: "bundle-intent",
    proposal: {
      kind: "room_scene_patch",
      operations: [{ action: "palette", palette: "blue" }],
    },
  });
  const resolve = {
    identityGeneration: read.identityGeneration,
    intentId: intent.intentId,
  };
  await f.call("room_intent_resolve", { ...resolve, action: "accept" });
  await f.call("room_scene_read");
  const originalExecution = await f.call("room_intent_resolve", {
    ...resolve,
    action: "execute",
    expectedLayoutRevision: 0,
  });
  const originalReceipt = (
    await f.call("room_operation_status", {
      identityGeneration: read.identityGeneration,
      requestId: originalExecution.requestId,
    })
  ).receipt;
  for (const key of [
    "operationId",
    "requestId",
    "kind",
    "committedAt",
    "committed",
    "layoutRevision",
    "contentRevision",
  ])
    assert.equal(originalReceipt[key], originalExecution[key]);
  assert.ok(originalReceipt.operationId);
  assert.equal(originalReceipt.requestId, "intent_" + intent.intentId);
  assert.equal(originalReceipt.kind, "room_scene_patch");
  assert.ok(originalReceipt.committedAt);
  await f.call(
    "board_post",
    { title: "恢复便签", body: "合成的公共便签" },
    context(f.runtime, "agent-0", "@subject"),
  );
  const expectedBoard = await f.call(
    "board_read",
    { mode: "posts" },
    context(f.runtime, "agent-0", "@subject"),
  );
  assert.equal(expectedBoard.posts.length, 1);
  assert.equal(expectedBoard.posts[0].body, "合成的公共便签");
  const expected = f.runtime.home.rooms.display("agent-0");
  const beforeWrites = f.store.db
    .prepare("SELECT COUNT(*) n FROM home_operations")
    .get().n;
  const bundle = path.join(f.root, "bundle"),
    restored = path.join(f.root, "restored");
  fs.mkdirSync(bundle);
  fs.mkdirSync(restored);
  fs.copyFileSync(f.configStore.file, path.join(bundle, "config.json"));
  assert.equal(
    (await backupDatabase(f.store.file, path.join(bundle, "memory.sqlite")))
      .integrity,
    "ok",
  );
  const assets = new URL("../public/home-preview/assets/", import.meta.url);
  fs.cpSync(assets, path.join(bundle, "assets"), { recursive: true });
  fs.writeFileSync(
    path.join(bundle, "asset-catalog.json"),
    JSON.stringify({ version: catalogVersion, assets: catalog }),
  );
  const packaged = [
    "NOTICE.md",
    "docs/SOURCES.json",
    "vendor/fonts/LXGW-OFL.txt",
    "public/home-space/paper-nest-hand-v1.530.woff2",
  ];
  for (const file of packaged) {
    const destination = path.join(bundle, "release", file);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(new URL(`../${file}`, import.meta.url), destination);
  }
  fs.cpSync(bundle, restored, { recursive: true });
  const restoredCatalog = JSON.parse(
    fs.readFileSync(path.join(restored, "asset-catalog.json"), "utf8"),
  );
  assert.equal(restoredCatalog.version, catalogVersion);
  assert.deepEqual(restoredCatalog.assets, catalog);
  for (const asset of Object.values(restoredCatalog.assets)) {
    const bytes = fs.readFileSync(path.join(restored, asset.file));
    assert.equal(
      createHash("sha256").update(bytes).digest("hex"),
      asset.sha256,
    );
  }
  for (const file of packaged) {
    assert.equal(
      createHash("sha256")
        .update(fs.readFileSync(path.join(restored, "release", file)))
        .digest("hex"),
      createHash("sha256")
        .update(fs.readFileSync(new URL(`../${file}`, import.meta.url)))
        .digest("hex"),
    );
  }
  const memory = new MemoryStore(path.join(restored, "memory.sqlite"));
  const configStore = new ConfigStore(path.join(restored, "config.json"));
  const runtime = new Runtime({
    memory,
    configStore,
    backendFactory: () => ({
      run: async () => {},
      cancel: async () => {},
      close: async () => {},
    }),
    transportFactory: () => new FakeTransport(),
  });
  runtime.clock = () => f.runtime.now();
  t.after(async () => {
    await runtime.close();
    memory.close();
  });
  for (const c of runtime.config.connections)
    runtime.transports.set(c.id, new FakeTransport());
  assert.deepEqual(
    runtime.config.agents[0].home,
    f.runtime.config.agents[0].home,
  );
  assert.deepEqual(runtime.home.rooms.display("agent-0"), expected);
  assert.equal(runtime.home.read("room", "agent-0").layout.palette, "blue");
  const restoredCtx = context(runtime, "agent-0", "@subject");
  assert.deepEqual(
    await runtime.executeTool(restoredCtx, "board_read", { mode: "posts" }),
    expectedBoard,
  );
  const result = await runtime.executeTool(restoredCtx, "room_intent_resolve", {
    ...resolve,
    action: "execute",
    expectedLayoutRevision: 0,
  });
  assert.equal(result.status, "executed");
  assert.deepEqual(result.receipt, originalReceipt);
  assert.equal(result.executedAt, originalReceipt.committedAt);
  const operation = await runtime.executeTool(
    restoredCtx,
    "room_operation_status",
    {
      identityGeneration: read.identityGeneration,
      requestId: originalReceipt.requestId,
    },
  );
  assert.equal(operation.status, "committed");
  assert.deepEqual(operation.receipt, originalReceipt);
  assert.equal(
    memory.db.prepare("SELECT COUNT(*) n FROM home_operations").get().n,
    beforeWrites,
  );
  assert.equal(runtime.home.read("room", "agent-0").layoutRevision, 1);
  assert.deepEqual(runtime.home.rooms.display("agent-0"), expected);
});
