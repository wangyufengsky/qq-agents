import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { fixture, context, config } from "./helpers.mjs";
import { createServer } from "../src/server.mjs";
import { FileStore } from "../src/tools/files.mjs";
import { FILE_TOOL_NAMES } from "../src/tools/file-tools.mjs";
import { MemoryStore } from "../src/memory/store.mjs";
import { restoreExport } from "../src/memory/migrate.mjs";
import {
  EXPORT_TABLES,
  exportDigest,
  validateExport,
} from "../src/memory/export-format.mjs";

function setup(t, { run } = {}) {
  const cfg = config(1);
  const a = cfg.agents[0];
  Object.assign(a.subject, { enabled: true, groups: ["20000"] });
  a.files.enabled = true;
  a.tools.push(...FILE_TOOL_NAMES);
  const f = fixture(t, { cfg, ...(run ? { run } : {}) });
  f.runtime.files = new FileStore(path.join(f.root, "files"));
  return f;
}

test("a project carries steps, works, next step and blocker until it is finished or dropped", async (t) => {
  const f = setup(t),
    idle = context(f.runtime, "agent-0", "@subject"),
    call = (args) => f.runtime.callTool(idle, "project", args);
  await assert.rejects(call({ title: "没有理由" }), /INVALID_PROJECT/);
  const p = await call({
    title: "老滚世界观里的时间线",
    why: "几种说法互相矛盾，想自己理一遍",
  });
  assert.equal(p.status, "active");
  assert.deepEqual(p.steps, []);
  const draft = await f.runtime.callTool(idle, "file_create", {
    name: "时间线初稿.md",
    text: "# 第一纪元\n……",
  });
  const step = await call({
    id: p.id,
    expectedRevision: 1,
    progress: "比较了两种纪元划分，写了初稿",
    files: [draft.fileId],
    next: "核对第二纪元的年表",
    blocker: "找不到可靠的游戏内书目原文",
  });
  assert.equal(step.revision, 2);
  assert.equal(step.steps[0].did, "比较了两种纪元划分，写了初稿");
  assert.deepEqual(step.files, [draft.fileId]);
  assert.equal(step.blocker, "找不到可靠的游戏内书目原文");
  // An update can rename it but not blank its title or why.
  await assert.rejects(
    f.runtime.callTool(context(f.runtime, "agent-0", "@subject"), "project", {
      id: p.id,
      expectedRevision: 2,
      title: " ",
    }),
    /INVALID_PROJECT/,
  );
  // A work must be the agent's own file.
  await assert.rejects(
    call({
      id: p.id,
      expectedRevision: 2,
      progress: "x",
      files: ["0".repeat(64)],
    }),
    /FILE_NOT_FOUND/,
  );
  await assert.rejects(
    call({ id: p.id, expectedRevision: 2, status: "dropped" }),
    /INVALID_PROJECT/,
  );
  const dropped = await call({
    id: p.id,
    expectedRevision: 2,
    status: "dropped",
    outcome: "资料太少，先放下，换去写故事",
  });
  assert.equal(dropped.outcome, "资料太少，先放下，换去写故事");
  await assert.rejects(
    call({ id: p.id, expectedRevision: 3, progress: "再试试" }),
    /PROJECT_CLOSED/,
  );
  // Chats can read it to talk about their own work.
  const read = await f.runtime.callTool(context(f.runtime), "projects", {});
  assert.equal(read.items[0].title, "老滚世界观里的时间线");

  const tainted = context(f.runtime, "agent-0", "@subject");
  tainted.privateRead.add("operations:fixture");
  await assert.rejects(
    f.runtime.callTool(tainted, "project", { title: "x", why: "y" }),
    /RESTRICTED_CONTEXT_MIND_WRITE_BLOCKED/,
  );
});

test("at most five projects are active at once; a paused one can resume when there is room", async (t) => {
  const f = setup(t),
    // Each call its own free time, clear of the per-turn tool budget.
    call = (args) =>
      f.runtime.callTool(
        context(f.runtime, "agent-0", "@subject"),
        "project",
        args,
      );
  const made = [];
  for (let i = 0; i < 5; i++)
    made.push(await call({ title: "项目" + i, why: "好奇" }));
  await assert.rejects(call({ title: "第六个", why: "好奇" }), /PROJECT_LIMIT/);
  const paused = await call({
    id: made[0].id,
    expectedRevision: 1,
    status: "paused",
  });
  await call({ title: "第六个", why: "好奇" });
  await assert.rejects(
    call({ id: paused.id, expectedRevision: 2, status: "active" }),
    /PROJECT_LIMIT/,
  );
});

test("free time shows where each project stands and points at the last draft", async (t) => {
  const prompts = [],
    instructions = [];
  const f = setup(t, {
    run: async (p) => {
      prompts.push(p.prompt);
      instructions.push(p.instructions);
    },
  });
  const m = f.store.bind("agent-0");
  const p = m.identity.saveProject(
    { title: "连载小故事《雨停以后》", why: "想写一个修伞匠的故事" },
    { writtenIn: "@subject", now: 1 },
  );
  m.identity.saveProject(
    {
      id: p.id,
      expectedRevision: 1,
      progress: "写完第一章",
      files: ["a".repeat(64)],
      next: "第二章让徒弟出场",
    },
    { writtenIn: "@subject", now: 2 },
  );
  const q = m.identity.saveProject(
    { title: "暂停的项目", why: "以后再说" },
    { writtenIn: "@subject", now: 3 },
  );
  m.identity.saveProject(
    { id: q.id, expectedRevision: 1, status: "paused" },
    { writtenIn: "@subject", now: 4 },
  );
  await f.runtime.wake("agent-0", "@subject");
  const materials = JSON.parse(
    prompts[0].split("空闲时间素材：")[1].split("\n\n")[0],
  );
  assert.match(materials.projects.notice, /file_read/);
  const [active] = materials.projects.active;
  assert.equal(active.title, "连载小故事《雨停以后》");
  assert.deepEqual(
    active.lastSteps.map((s) => s.did),
    ["写完第一章"],
  );
  assert.deepEqual(active.files, ["a".repeat(64)]);
  assert.equal(active.next, "第二章让徒弟出场");
  assert.deepEqual(
    materials.projects.paused.map((x) => x.title),
    ["暂停的项目"],
  );
  assert.match(instructions[0], /推进自己的小项目/);
});

test("projects travel with an export, and the console lists them read-only", async (t) => {
  const source = new MemoryStore(":memory:"),
    memory = source.bind("agent-a");
  t.after(() => source.close());
  memory.identity.saveProject(
    { title: "时间线", why: "好奇" },
    { writtenIn: "@subject", now: 1 },
  );
  const tables = memory.export().tables;
  const sign = (tables) => {
    const data = {
      version: 2,
      agentId: "agent-a",
      exportedAt: new Date(0).toISOString(),
      tables,
    };
    const digest = exportDigest(data),
      counts = {};
    for (const name of EXPORT_TABLES.filter((x) => x in tables)) {
      digest.update(name + "\n");
      for (const row of tables[name]) digest.update(JSON.stringify(row) + "\n");
      counts[name] = tables[name].length;
    }
    return {
      ...data,
      manifest: { algorithm: "sha256", counts, sha256: digest.digest("hex") },
    };
  };
  const target = new MemoryStore(":memory:");
  t.after(() => target.close());
  restoreExport(target.bind("agent-a"), sign(tables));
  assert.equal(target.bind("agent-a").identity.projects()[0].title, "时间线");
  const { projects: _dropped, ...earlier } = tables;
  validateExport(sign(earlier));

  const f = setup(t);
  f.store
    .bind("agent-0")
    .identity.saveProject(
      { title: "在控制台看得到", why: "验收" },
      { writtenIn: "@subject", now: f.runtime.now() },
    );
  const token = randomBytes(32).toString("hex"),
    app = createServer({ runtime: f.runtime, token });
  const port = await app.listen();
  t.after(() => app.close());
  const data = await (
    await fetch(`http://127.0.0.1:${port}/api/mind?agentId=agent-0`, {
      headers: { "x-admin-token": token },
    })
  ).json();
  assert.deepEqual(
    data.projects.map((p) => [p.title, p.status]),
    [["在控制台看得到", "active"]],
  );
});
