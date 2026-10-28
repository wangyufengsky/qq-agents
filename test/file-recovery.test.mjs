import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { FileStore } from "../src/tools/files.mjs";
import { FILE_TOOL_NAMES } from "../src/tools/file-tools.mjs";
import { filesSchema } from "../src/core/policy.mjs";
import { createServer } from "../src/server.mjs";
import { temp, config, fixture, context } from "./helpers.mjs";

test("metadata growth is rejected before a healthy file becomes unreadable", (t) => {
  const store = new FileStore(temp(t)),
    policy = filesSchema.parse({}),
    bytes = Buffer.from("same bytes");
  const file = store.put("agent-a", bytes, "a.txt", policy, {
    kind: "web",
    note: "a".repeat(140000),
  });
  assert.throws(
    () =>
      store.put("agent-a", bytes, "b.txt", policy, {
        kind: "web",
        note: "b".repeat(140000),
      }),
    /FILE_METADATA_TOO_LARGE/,
  );
  assert.equal(store.read("agent-a", file.fileId, 1024).meta.name, "a.txt");
});

test("one corrupt metadata entry is isolated while healthy reads and new writes remain available", (t) => {
  const root = temp(t),
    store = new FileStore(root),
    policy = filesSchema.parse({});
  const bad = store.put(
    "agent-a",
    Buffer.from("damaged"),
    "bad.txt",
    policy,
    {},
    true,
  );
  const good = store.put("agent-a", Buffer.from("healthy"), "good.txt", policy);
  fs.writeFileSync(
    path.join(root, "agent-a", bad.fileId + ".json"),
    "{partial",
  );
  const listed = store.list("agent-a");
  assert.deepEqual(
    listed.items.map((x) => x.fileId),
    [good.fileId],
  );
  assert.equal(listed.corruptCount, 1);
  assert.equal(listed.corrupt[0].code, "FILE_METADATA_CORRUPT");
  assert.equal(listed.storedFiles, 2);
  assert(listed.usedBytes >= 14);
  assert.equal(
    store.read("agent-a", good.fileId, 1024).buffer.toString(),
    "healthy",
  );
  store.put("agent-a", Buffer.from("new"), "new.txt", policy);
  assert.equal(store.list("agent-b").corruptCount, 0);
  assert.throws(
    () => store.put("agent-a", Buffer.from("damaged"), "retry.txt", policy),
    /FILE_METADATA_CORRUPT/,
  );
});

test("admin repair is authenticated, role-scoped, and keeps repaired protected files out of ordinary QQ contexts", async (t) => {
  const cfg = config(2);
  cfg.agents[0].files.enabled = true;
  cfg.agents[0].tools.push(...FILE_TOOL_NAMES);
  const f = fixture(t, { cfg }),
    ctx = context(f.runtime);
  f.runtime.files = new FileStore(path.join(f.root, "files"));
  const meta = f.runtime.files.put(
    ctx.agentId,
    Buffer.from("protected bytes"),
    "original.txt",
    cfg.agents[0].files,
    {},
    true,
  );
  fs.writeFileSync(
    path.join(f.root, "files", ctx.agentId, meta.fileId + ".json"),
    "{broken",
  );
  const token = randomBytes(32).toString("hex"),
    server = createServer({ runtime: f.runtime, token });
  const port = await server.listen();
  t.after(() => server.close());
  const request = (route, body, auth = token) =>
    fetch(`http://127.0.0.1:${port}${route}`, {
      method: body ? "POST" : "GET",
      headers: { "x-admin-token": auth, "content-type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  const input = {
    agentId: ctx.agentId,
    fileId: meta.fileId,
    name: "recovered.txt",
    action: "repair",
  };
  assert.equal((await request("/api/files/recovery", input, "")).status, 401);
  assert.equal(
    (await request("/api/files/recovery", input, ctx.token)).status,
    401,
  );
  assert.equal(
    (await request("/api/files/recovery", { ...input, agentId: "agent-1" }))
      .status,
    400,
  );
  const repaired = await request("/api/files/recovery", input);
  assert.equal(repaired.status, 200);
  assert.equal((await repaired.json()).protectedOperations, true);
  let sent = 0;
  f.runtime.transports.get("qq-0").sendFile = async () => {
    sent++;
    return { confirmed: true, fileId: "synthetic" };
  };
  await assert.rejects(
    f.runtime.callTool(ctx, "qq_send_file", {
      fileId: meta.fileId,
      requestId: "one",
    }),
    /RECALL_SOURCE_NOT_ALLOWED/,
  );
  assert.equal(sent, 0);
  assert.equal(ctx.disclosureRequest, undefined);
  assert.equal(sent, 0);
  assert.equal(
    (await request("/api/files/recovery", { ...input, action: "remove" }))
      .status,
    409,
  );
  fs.writeFileSync(
    path.join(f.root, "files", ctx.agentId, meta.fileId + ".json"),
    "{}",
  );
  assert.equal(
    (await request("/api/files/recovery", { ...input, action: "remove" }))
      .status,
    200,
  );
  assert.equal(
    (await (await request("/api/files?agentId=" + ctx.agentId)).json())
      .blockedCount,
    1,
  );
});

test("repair retains unknown protection across reupload, and removing damage cannot clear it", (t) => {
  const root = temp(t),
    store = new FileStore(root),
    policy = filesSchema.parse({});
  const bytes = Buffer.from("protected recovery"),
    bad = store.put("agent-a", bytes, "old.txt", policy, {}, true);
  fs.writeFileSync(path.join(root, "agent-a", bad.fileId + ".json"), "{}");
  const repaired = store.repair("agent-a", bad.fileId, "recovered.txt", policy);
  assert.equal(repaired.protectionUnknown, true);
  assert.equal(repaired.protectedOperations, true);
  assert.equal(store.list("agent-a").corruptCount, 0);
  const uploaded = store.put("agent-a", bytes, "uploaded.txt", policy);
  assert.equal(uploaded.protectedOperations, true);
  assert.equal(uploaded.protectionUnknown, true);
  fs.writeFileSync(path.join(root, "agent-a", bad.fileId + ".json"), "{bad");
  assert.equal(store.removeDamaged("agent-a", bad.fileId).removed, true);
  assert.throws(
    () => store.put("agent-a", bytes, "public.txt", policy),
    /FILE_REMOVED_PROTECTED/,
  );
  assert.equal(
    fs.existsSync(path.join(root, "agent-a", bad.fileId + ".bin")),
    false,
  );
});

for (const change of [
  "bad-json",
  "wrong-shape",
  "wrong-id",
  "missing-metadata",
  "missing-content",
  "wrong-size",
])
  test(`file recovery distinguishes ${change} and does not release occupied quota`, (t) => {
    const root = temp(t),
      store = new FileStore(root),
      policy = filesSchema.parse({
        maxBytes: 1024,
        maxTotalBytes: 1024,
        maxFiles: 1,
      });
    const file = store.put("agent-a", Buffer.from("original"), "a.txt", policy);
    const metaPath = path.join(root, "agent-a", file.fileId + ".json"),
      binPath = path.join(root, "agent-a", file.fileId + ".bin");
    if (change === "bad-json") fs.writeFileSync(metaPath, "{partial");
    if (change === "wrong-shape")
      fs.writeFileSync(metaPath, JSON.stringify({ ...file, sources: "lost" }));
    if (change === "wrong-id")
      fs.writeFileSync(
        metaPath,
        JSON.stringify({ ...file, sha256: "0".repeat(64) }),
      );
    if (change === "missing-metadata") fs.unlinkSync(metaPath);
    if (change === "missing-content") fs.unlinkSync(binPath);
    if (change === "wrong-size") fs.writeFileSync(binPath, "changed-length");
    const result = store.list("agent-a");
    assert.equal(result.corruptCount, 1);
    assert.equal(result.items.length, 0);
    assert.equal(result.storedFiles, 1);
    assert.throws(
      () => store.put("agent-a", Buffer.from("other"), "other.txt", policy),
      /QUOTA_EXCEEDED/,
    );
    if (change === "wrong-size")
      assert.throws(
        () => store.repair("agent-a", file.fileId, "repair.txt", policy),
        /INTEGRITY_FAILED/,
      );
  });

test("orphan bytes and metadata overhead count toward capacity while unknown directories block new writes", (t) => {
  const root = temp(t),
    store = new FileStore(root),
    policy = filesSchema.parse({ maxBytes: 1024, maxTotalBytes: 1024 });
  const dir = store.dir("agent-a");
  fs.writeFileSync(path.join(dir, "interrupted.part"), Buffer.alloc(1000));
  assert.equal(store.list("agent-a").usedBytes, 1000);
  assert.throws(
    () => store.put("agent-a", Buffer.from("tiny"), "tiny.txt", policy),
    /QUOTA_EXCEEDED/,
  );
  fs.unlinkSync(path.join(dir, "interrupted.part"));
  fs.mkdirSync(path.join(dir, "unknown-directory"));
  assert.equal(store.list("agent-a").usageComplete, false);
  assert.throws(
    () => store.put("agent-a", Buffer.from("tiny"), "tiny.txt", policy),
    /QUOTA_UNAVAILABLE/,
  );
});

test("repair rejects symlink and hardlink payloads; damage removal leaves external targets untouched", (t) => {
  const root = temp(t),
    store = new FileStore(path.join(root, "files")),
    policy = filesSchema.parse({});
  const outside = path.join(root, "outside"),
    bytes = Buffer.from("outside bytes");
  fs.writeFileSync(outside, bytes);
  for (const type of ["symlink", "hardlink"]) {
    const agent = "agent-" + type,
      file = store.put(agent, bytes, "test.txt", policy);
    const bin = path.join(store.dir(agent), file.fileId + ".bin");
    fs.unlinkSync(bin);
    if (type === "symlink") fs.symlinkSync(outside, bin);
    else fs.linkSync(outside, bin);
    assert.equal(store.list(agent).corrupt[0].code, "FILE_PATH_DENIED");
    assert.throws(
      () => store.repair(agent, file.fileId, "repair.txt", policy),
      /FILE_PATH_DENIED/,
    );
    store.removeDamaged(agent, file.fileId);
    assert.equal(fs.readFileSync(outside).toString(), bytes.toString());
  }
});

test("metadata permission failures have a safe distinct code and do not hide healthy entries", (t) => {
  const root = temp(t),
    store = new FileStore(root),
    policy = filesSchema.parse({});
  const file = store.put(
    "agent-a",
    Buffer.from("blocked"),
    "blocked.txt",
    policy,
  );
  store.put("agent-a", Buffer.from("normal"), "normal.txt", policy);
  const open = fs.openSync;
  t.mock.method(fs, "openSync", (name, ...args) => {
    if (name === path.join(root, "agent-a", file.fileId + ".json"))
      throw Object.assign(Error("synthetic-private-detail"), {
        code: "EACCES",
      });
    return open(name, ...args);
  });
  const result = store.list("agent-a");
  assert.equal(result.items.length, 1);
  assert.equal(result.corrupt[0].code, "FILE_ACCESS_DENIED");
  assert.equal(
    JSON.stringify(result).includes("synthetic-private-detail"),
    false,
  );
  assert.throws(
    () => store.metadata("agent-a", file.fileId),
    /FILE_ACCESS_DENIED/,
  );
});

test("failure to persist the removal tombstone leaves the original damaged files intact", (t) => {
  const root = temp(t),
    store = new FileStore(root),
    policy = filesSchema.parse({});
  const file = store.put("agent-a", Buffer.from("preserve"), "bad.txt", policy);
  const base = path.join(root, "agent-a", file.fileId);
  fs.writeFileSync(base + ".json", "{partial");
  const rename = fs.renameSync;
  t.mock.method(fs, "renameSync", (source, target) => {
    if (target === base + ".blocked")
      throw Object.assign(Error("synthetic full disk"), { code: "ENOSPC" });
    return rename(source, target);
  });
  assert.throws(() => store.removeDamaged("agent-a", file.fileId));
  assert.equal(fs.readFileSync(base + ".bin").toString(), "preserve");
  assert.equal(fs.readFileSync(base + ".json", "utf8"), "{partial");
});

test("an interrupted removal remains visible and can finish without lifting the reimport block", (t) => {
  const root = temp(t),
    store = new FileStore(root),
    policy = filesSchema.parse({});
  const bytes = Buffer.from("preserve block"),
    file = store.put("agent-a", bytes, "bad.txt", policy);
  const base = path.join(root, "agent-a", file.fileId);
  fs.writeFileSync(base + ".json", "{partial");
  const unlink = fs.unlinkSync;
  const fault = t.mock.method(fs, "unlinkSync", (name) => {
    if (name === base + ".json")
      throw Object.assign(Error("synthetic IO fault"), { code: "EIO" });
    return unlink(name);
  });
  assert.throws(() => store.removeDamaged("agent-a", file.fileId));
  fault.mock.restore();
  assert.equal(
    store.list("agent-a").corrupt[0]?.code,
    "FILE_REMOVAL_INCOMPLETE",
  );
  assert.throws(
    () => store.put("agent-a", bytes, "again.txt", policy),
    /FILE_REMOVED_PROTECTED/,
  );
  store.removeDamaged("agent-a", file.fileId);
  assert.equal(store.list("agent-a").corruptCount, 0);
  assert.equal(store.list("agent-a").blockedCount, 1);
});

test("a damaged reimport marker cannot make removed protected content public again", (t) => {
  const root = temp(t),
    store = new FileStore(root),
    policy = filesSchema.parse({});
  const bytes = Buffer.from("protected tombstone"),
    file = store.put("agent-a", bytes, "a.txt", policy);
  const base = path.join(root, "agent-a", file.fileId);
  fs.writeFileSync(base + ".json", "{partial");
  store.removeDamaged("agent-a", file.fileId);
  fs.unlinkSync(base + ".blocked");
  fs.symlinkSync(path.join(root, "missing"), base + ".blocked");
  assert.throws(
    () => store.put("agent-a", bytes, "again.txt", policy),
    /FILE_REMOVED_PROTECTED/,
  );
});
