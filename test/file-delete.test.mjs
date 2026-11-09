import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { FileStore } from "../src/tools/files.mjs";
import { FILE_TOOL_NAMES } from "../src/tools/file-tools.mjs";
import { config, fixture } from "./helpers.mjs";

function setup(t, enabled = true) {
  const cfg = config(2);
  for (const agent of cfg.agents) {
    agent.files.enabled = true;
    agent.tools.push(...FILE_TOOL_NAMES);
    agent.ownerIds = ["30000"];
    agent.allow.users = ["30000", "30001"];
  }
  const f = fixture(t, { cfg });
  f.runtime.files = new FileStore(path.join(f.root, "files"));
  const agent = f.runtime.agent("agent-0");
  if (enabled) agent.files.delete = true;
  const ctx = f.runtime.makeContext(agent.id, "private:30000");
  const create = (text) =>
    f.runtime.callTool(ctx, "file_create", { name: "draft.md", text });
  const remove = (fileId) => f.runtime.callTool(ctx, "file_delete", { fileId });
  return { ...f, agent, ctx, create, remove };
}

test("delete needs explicit role permission and is discoverable only in owner chat and free time", async (t) => {
  const { runtime, agent, ctx, create, remove } = setup(t, false);
  const file = await create("ordinary draft");
  assert.equal(agent.files.delete, false);
  assert(!runtime.toolsFor(agent, ctx.conversation).includes("file_delete"));
  await assert.rejects(remove(file.fileId), /TOOL_DISABLED/);
  agent.files.delete = true;
  for (const conversation of [ctx.conversation, "@subject"])
    assert(runtime.toolsFor(agent, conversation).includes("file_delete"));
  for (const conversation of ["private:30001", "group:20000"]) {
    assert(!runtime.toolsFor(agent, conversation).includes("file_delete"));
    const otherCtx = runtime.makeContext(agent.id, conversation);
    await assert.rejects(
      runtime.callTool(otherCtx, "file_delete", { fileId: file.fileId }),
      /TOOL_DISABLED/,
    );
  }
  agent.tools = agent.tools.filter((name) => name !== "file_delete");
  await assert.rejects(remove(file.fileId), /TOOL_DISABLED/);
});

test("only the newest authored revision can be deleted, and quota is freed without reviving the same ID", async (t) => {
  const { runtime, agent, ctx, create, remove } = setup(t);
  agent.files.maxFiles = 2;
  const base = await create("first draft");
  const newest = await runtime.callTool(ctx, "file_revise", {
    baseFileId: base.fileId,
    text: "newest draft",
  });
  await assert.rejects(remove(base.fileId), /FILE_DELETE_HAS_REVISIONS/);
  await assert.rejects(create("additional file"), /FILE_QUOTA_EXCEEDED/);
  assert.deepEqual(await remove(newest.fileId), {
    removed: true,
    blockedForReimport: true,
  });
  assert.equal(runtime.files.list(agent.id).storedFiles, 1);
  assert.equal(runtime.files.versionOf(agent.id, base.fileId).latest, true);
  assert.throws(
    () => runtime.files.read(agent.id, newest.fileId, 1024),
    /FILE_REMOVED_PROTECTED/,
  );
  const dir = runtime.files.dir(agent.id);
  for (const ext of ["bin", "json"])
    assert(!fs.existsSync(path.join(dir, newest.fileId + "." + ext)));
  runtime.files = new FileStore(runtime.files.root);
  assert.equal((await remove(newest.fileId)).removed, true);
  await assert.rejects(create("newest draft"), /FILE_REMOVED_PROTECTED/);
  await create("additional file");
  assert.equal(runtime.files.list(agent.id).storedFiles, 2);
});

test("delete rejects other roles, mixed ownership, and protected or unknown provenance", async (t) => {
  const { runtime, agent, ctx, create, remove } = setup(t);
  const put = (text, source, restricted, id = agent.id) =>
    runtime.files.put(
      id,
      Buffer.from(text),
      "draft.md",
      agent.files,
      source,
      restricted,
    );
  const authored = { kind: "generated-text", conversation: ctx.conversation };
  const other = put("other role", authored, false, "agent-1");
  await assert.rejects(remove(other.fileId), /FILE_NOT_FOUND/);
  assert.equal(runtime.files.list("agent-1").total, 1);
  const imported = put("same bytes", { kind: "administrator-upload" });
  await create("same bytes");
  await assert.rejects(remove(imported.fileId), /FILE_DELETE_SOURCE_DENIED/);
  const download = put("public download", { kind: "web" });
  await assert.rejects(remove(download.fileId), /FILE_DELETE_SOURCE_DENIED/);
  const protectedFile = put("restricted notes", authored, true);
  await assert.rejects(
    remove(protectedFile.fileId),
    /RECALL_SOURCE_NOT_ALLOWED/,
  );
  const capped = put("incomplete source list", authored);
  const metaPath = path.join(
    runtime.files.dir(agent.id),
    capped.fileId + ".json",
  );
  fs.writeFileSync(
    metaPath,
    JSON.stringify({ ...capped, sources: Array(100).fill(authored) }),
  );
  await assert.rejects(remove(capped.fileId), /FILE_DELETE_SOURCE_DENIED/);
  assert.equal(runtime.files.list(agent.id).total, 4);
});

test("a deletion interrupted between unlinks stays blocked and can be finished by retry", async (t) => {
  const { runtime, agent, create, remove } = setup(t);
  const file = await create("temporary notes");
  const metadataPath = path.join(
    runtime.files.dir(agent.id),
    file.fileId + ".json",
  );
  const unlinkSync = fs.unlinkSync;
  const mock = t.mock.method(fs, "unlinkSync", (entry) => {
    if (entry === metadataPath)
      throw Object.assign(Error(), { code: "EACCES" });
    return unlinkSync(entry);
  });
  await assert.rejects(remove(file.fileId), /FILE_ACCESS_DENIED/);
  mock.mock.restore();
  const interrupted = runtime.files.list(agent.id);
  assert.equal(interrupted.total, 0);
  assert.equal(interrupted.storedFiles, 1);
  assert.equal(interrupted.corrupt[0].code, "FILE_REMOVAL_INCOMPLETE");
  await assert.rejects(create("temporary notes"), /FILE_REMOVED_PROTECTED/);
  assert.equal((await remove(file.fileId)).removed, true);
  assert.equal(runtime.files.list(agent.id).storedFiles, 0);
  assert.equal(runtime.files.list(agent.id).corruptCount, 0);
});
