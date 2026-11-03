import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { FileStore } from "../src/tools/files.mjs";
import { FILE_TOOL_NAMES } from "../src/tools/file-tools.mjs";
import { safeToolFailure } from "../src/tools/errors.mjs";
import { knownErrorCodes } from "../src/core/error-codes.mjs";
import { config, fixture } from "./helpers.mjs";

async function setup(t) {
  const cfg = config(2);
  for (const a of cfg.agents) {
    a.files.enabled = true;
    a.tools.push(...FILE_TOOL_NAMES);
  }
  const f = fixture(t, { cfg });
  f.runtime.files = new FileStore(path.join(f.root, "files"));
  return { ...f, ctx: f.runtime.makeContext("agent-0", "group:20000") };
}
const call = (r, c, name, args = {}) => r.callTool(c, name, args);
async function rejection(promise) {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  assert.fail("expected a rejection");
}

test("file_revise builds a version chain and keeps every earlier draft", async (t) => {
  const { runtime, ctx } = await setup(t);
  const v1 = await call(runtime, ctx, "file_create", {
    name: "练习.md",
    text: "第一稿",
  });
  const v2 = await call(runtime, ctx, "file_revise", {
    baseFileId: v1.fileId,
    text: "第二稿",
    note: "补了结尾",
  });
  assert.notEqual(v2.fileId, v1.fileId);
  assert.equal(v2.name, "练习.md");
  assert.equal(v2.version, 2);
  assert.equal(v2.revisionOf, v1.fileId);
  assert.equal(v2.latest, true);
  const marker = v2.sources.find((s) => s.kind === "revision");
  assert.deepEqual(marker, {
    conversation: "group:20000",
    note: "补了结尾",
    kind: "revision",
    revisionOf: v1.fileId,
    revision: 2,
  });
  const v3 = await call(runtime, ctx, "file_revise", {
    baseFileId: v2.fileId,
    text: "第三稿",
    name: "练习-定稿.md",
  });
  assert.equal(v3.version, 3);
  assert.equal(v3.name, "练习-定稿.md");
  // Only the newest lineage marker stays one; inherited ones become provenance.
  assert.equal(v3.sources.filter((s) => s.kind === "revision").length, 1);

  const old = await call(runtime, ctx, "file_read", { fileId: v1.fileId });
  assert.equal(old.text, "第一稿");
  assert.equal(old.version, 1);
  assert.equal(old.latest, false);
  assert.equal(old.latestFileId, v3.fileId);
  const current = await call(runtime, ctx, "file_read", { fileId: v3.fileId });
  assert.equal(current.latest, true);
  assert.equal(current.revisionOf, v2.fileId);

  const listed = await call(runtime, ctx, "file_list");
  assert.deepEqual(
    listed.items.map((m) => m.fileId),
    [v3.fileId],
  );
  const all = await call(runtime, ctx, "file_list", { allVersions: true });
  assert.equal(all.total, 3);
  const history = await call(runtime, ctx, "file_list", {
    versionsOf: v2.fileId,
  });
  assert.deepEqual(
    history.items.map((m) => [m.fileId, m.version, m.latest]),
    [
      [v1.fileId, 1, false],
      [v2.fileId, 2, false],
      [v3.fileId, 3, true],
    ],
  );
});

test("file_revise refuses a stale base, names the newest version and writes nothing", async (t) => {
  const { runtime, ctx } = await setup(t);
  const v1 = await call(runtime, ctx, "file_create", {
    name: "notes.txt",
    text: "base",
  });
  const v2 = await call(runtime, ctx, "file_revise", {
    baseFileId: v1.fileId,
    text: "edited on Monday",
  });
  const before = runtime.files.scan("agent-0").items.length;
  const error = await rejection(
    call(runtime, ctx, "file_revise", {
      baseFileId: v1.fileId,
      text: "edited from the old draft",
    }),
  );
  assert.equal(error.message, "FILE_REVISION_CONFLICT");
  assert.equal(runtime.files.scan("agent-0").items.length, before);
  const failure = safeToolFailure(error);
  assert.equal(failure.code, "FILE_REVISION_CONFLICT");
  assert.equal(failure.latestFileId, v2.fileId);
  assert.equal(failure.latestVersion, 2);
  assert.match(failure.hint, /file_read latestFileId/);
  assert(knownErrorCodes.has("FILE_REVISION_CONFLICT"));
  assert(knownErrorCodes.has("FILE_REVISION_CONTENT_EXISTS"));

  // Rereading the newest version and revising it works.
  const v3 = await call(runtime, ctx, "file_revise", {
    baseFileId: failure.latestFileId,
    text: "merged",
  });
  assert.equal(v3.version, 3);
});

test("two revisions of the same version cannot both land", async (t) => {
  const { runtime, ctx } = await setup(t);
  const v1 = await call(runtime, ctx, "file_create", {
    name: "notes.txt",
    text: "base",
  });
  const results = await Promise.allSettled([
    call(runtime, ctx, "file_revise", { baseFileId: v1.fileId, text: "A" }),
    call(runtime, ctx, "file_revise", { baseFileId: v1.fileId, text: "B" }),
  ]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.match(
    results.find((r) => r.status === "rejected").reason.message,
    /^(FILE_TRANSFER_BUSY|FILE_REVISION_CONFLICT)$/,
  );
  // Even without the per-agent lock, the store refuses a second child.
  const policy = runtime.agent("agent-0").files;
  assert.throws(
    () =>
      runtime.files.revise(
        "agent-0",
        v1.fileId,
        Buffer.from("C"),
        "notes.txt",
        policy,
        {},
      ),
    /FILE_REVISION_CONFLICT/,
  );
  const history = runtime.files.list("agent-0", { versionsOf: v1.fileId });
  assert.equal(history.total, 2);
});

test("unchanged text returns the current version instead of a new one", async (t) => {
  const { runtime, ctx } = await setup(t);
  const v1 = await call(runtime, ctx, "file_create", {
    name: "notes.txt",
    text: "same",
  });
  const same = await call(runtime, ctx, "file_revise", {
    baseFileId: v1.fileId,
    text: "same",
  });
  assert.equal(same.unchanged, true);
  assert.equal(same.fileId, v1.fileId);
  const v2 = await call(runtime, ctx, "file_revise", {
    baseFileId: v1.fileId,
    text: "newer",
  });
  // A stale base whose text already equals the newest version is not a
  // conflict: nothing would be lost.
  const caughtUp = await call(runtime, ctx, "file_revise", {
    baseFileId: v1.fileId,
    text: "newer",
  });
  assert.equal(caughtUp.unchanged, true);
  assert.equal(caughtUp.fileId, v2.fileId);
  assert.equal(runtime.files.scan("agent-0").items.length, 2);

  // Going back to an earlier version's exact text cannot reuse its file.
  const error = await rejection(
    call(runtime, ctx, "file_revise", { baseFileId: v2.fileId, text: "same" }),
  );
  assert.equal(error.message, "FILE_REVISION_CONTENT_EXISTS");
  assert.equal(safeToolFailure(error).latestFileId, v1.fileId);
  assert.equal(runtime.files.scan("agent-0").items.length, 2);
});

test("revisions inherit provenance and protection and cannot wash them out", async (t) => {
  const { runtime, ctx } = await setup(t);
  const policy = runtime.agent("agent-0").files;
  const elsewhere = runtime.files.put(
    "agent-0",
    Buffer.from("written in a private chat"),
    "draft.txt",
    policy,
    { conversation: "private:30000", eventId: "event-elsewhere" },
  );
  const revised = await call(runtime, ctx, "file_revise", {
    baseFileId: elsewhere.fileId,
    text: "revised in a group",
  });
  // Revising reads the base, so the turn is tainted like a read.
  assert.equal(ctx.privateRead.has("event-elsewhere"), true);
  assert(revised.sources.some((s) => s.eventId === "event-elsewhere"));
  const fresh = runtime.makeContext("agent-0", "group:20000");
  await call(runtime, fresh, "file_read", { fileId: revised.fileId });
  assert.equal(fresh.privateRead.has("event-elsewhere"), true);

  // Store level: protected bases keep every marker on the new version.
  const secret = runtime.files.put(
    "agent-0",
    Buffer.from("ops notes"),
    "ops.txt",
    policy,
    {},
    true,
    ["Owner/Private"],
    ["123456"],
  );
  const next = runtime.files.revise(
    "agent-0",
    secret.fileId,
    Buffer.from("ops notes v2"),
    "ops.txt",
    policy,
    {},
  );
  assert.equal(next.protectedOperations, true);
  assert.deepEqual(next.protectedRepositories, ["Owner/Private"]);
  assert.deepEqual(next.protectedPeerQzoneTargets, ["123456"]);
  // And ordinary chats still cannot revise or read protected drafts.
  await assert.rejects(
    call(runtime, ctx, "file_revise", {
      baseFileId: secret.fileId,
      text: "laundered",
    }),
    /RECALL_SOURCE_NOT_ALLOWED/,
  );
});

test("metadata written before revisions existed reads and revises normally", async (t) => {
  const { runtime, ctx } = await setup(t);
  const dir = path.join(runtime.files.root, "agent-0"),
    bytes = Buffer.from("old draft"),
    fileId = createHash("sha256").update(bytes).digest("hex");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, fileId + ".bin"), bytes);
  fs.writeFileSync(
    path.join(dir, fileId + ".json"),
    JSON.stringify({
      fileId,
      sha256: fileId,
      name: "old.txt",
      bytes: bytes.length,
      createdAt: "2026-10-01T00:00:00.000Z",
      sources: [{ kind: "generated-text", conversation: "group:20000" }],
      protectedOperations: false,
      protectedRepositories: [],
      contentRead: false,
    }),
  );
  const read = await call(runtime, ctx, "file_read", { fileId });
  assert.equal(read.version, 1);
  assert.equal(read.latest, true);
  assert.equal(read.revisionOf, undefined);
  const listed = await call(runtime, ctx, "file_list");
  assert.equal(listed.items[0].version, 1);
  const revised = await call(runtime, ctx, "file_revise", {
    baseFileId: fileId,
    text: "new draft",
  });
  assert.equal(revised.version, 2);
  // The new metadata adds no top-level fields, so earlier releases that parse
  // it strictly still list the revision as an ordinary file.
  const stored = JSON.parse(
    fs.readFileSync(path.join(dir, revised.fileId + ".json"), "utf8"),
  );
  assert.deepEqual(Object.keys(stored).sort(), [
    "bytes",
    "contentRead",
    "createdAt",
    "fileId",
    "name",
    "protectedOperations",
    "protectedRepositories",
    "sha256",
    "sources",
  ]);
});

test("file_revise follows file_create's permission and text rules", async (t) => {
  const { runtime, ctx } = await setup(t);
  const a = runtime.agent("agent-0");
  const v1 = await call(runtime, ctx, "file_create", {
    name: "notes.txt",
    text: "base",
  });
  // Older configurations with file_create get file_revise without an edit.
  a.tools = a.tools.filter((n) => n !== "file_revise");
  assert(runtime.toolsFor(a, "group:20000").includes("file_revise"));
  assert(runtime.toolsFor(a, "@subject").includes("file_revise"));
  a.tools = a.tools.filter((n) => n !== "file_create");
  assert.equal(
    runtime.toolsFor(a, "group:20000").includes("file_revise"),
    false,
  );
  a.tools.push("file_create", "file_revise");

  await assert.rejects(
    call(runtime, ctx, "file_revise", {
      baseFileId: v1.fileId,
      text: "sk-" + "x".repeat(24),
    }),
    /SENSITIVE_OUTPUT_BLOCKED/,
  );
  await assert.rejects(
    call(runtime, ctx, "file_revise", {
      baseFileId: v1.fileId,
      text: "fine",
      name: "fake.pdf",
    }),
    /TEXT_FILE_EXTENSION_REQUIRED/,
  );
  const image = runtime.files.put(
    "agent-0",
    Buffer.from("not really a png"),
    "photo.png",
    a.files,
  );
  await assert.rejects(
    call(runtime, ctx, "file_revise", {
      baseFileId: image.fileId,
      text: "text",
      name: "photo.txt",
    }),
    /FILE_NOT_TEXT/,
  );
  // Another agent's fileId grants nothing.
  await assert.rejects(
    call(
      runtime,
      runtime.makeContext("agent-1", "group:20000"),
      "file_revise",
      {
        baseFileId: v1.fileId,
        text: "theirs",
      },
    ),
    /FILE_NOT_FOUND/,
  );
  a.files.create = false;
  await assert.rejects(
    call(runtime, ctx, "file_revise", { baseFileId: v1.fileId, text: "x" }),
    /FILE_PERMISSION_DISABLED/,
  );
  assert.equal(runtime.files.scan("agent-0").items.length, 2);
});
