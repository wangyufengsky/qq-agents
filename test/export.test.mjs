import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { temp } from "./helpers.mjs";
import { MemoryStore } from "../src/memory/store.mjs";
import { restoreExport } from "../src/memory/migrate.mjs";
import { streamExport } from "../src/memory/export.mjs";

for (const reason of ["abort", "disconnect"])
  test(`export ${reason} settles while a destination write callback is pending`, async (t) => {
    const controller = new AbortController();
    let releaseWrite, exporting, started;
    // Release the synthetic stalled write even when an assertion fails, before
    // the temp directory is removed (an open source handle matters on Windows).
    t.after(async () => {
      controller.abort(Error("TEST_CLEANUP"));
      releaseWrite?.();
      await exporting?.catch(() => {});
    });
    const file = path.join(temp(t), "source.json");
    fs.writeFileSync(file, "x".repeat(65536));
    const writing = new Promise((resolve) => (started = resolve));
    const destination = new Writable({
      write(_chunk, _encoding, callback) {
        releaseWrite = callback;
        started();
      },
    });
    exporting = streamExport(file, destination, controller.signal);
    exporting.catch(() => {});
    await writing;
    const message =
      reason === "abort" ? "EXPORT_CANCELLED" : "DOWNLOAD_DISCONNECTED";
    if (reason === "abort") controller.abort(Error(message));
    else destination.destroy(Error(message));
    let deadline;
    try {
      await assert.rejects(
        Promise.race([
          exporting,
          new Promise((_, reject) => {
            deadline = setTimeout(
              () => reject(Error("EXPORT_DID_NOT_CANCEL")),
              1000,
            );
          }),
        ]),
        new RegExp(message),
      );
    } finally {
      clearTimeout(deadline);
    }
    assert.equal(destination.destroyed, true);
  });

const cli = fileURLToPath(new URL("../scripts/export.mjs", import.meta.url));
const run = (root, file, restore = false) =>
  spawnSync(
    process.execPath,
    [
      cli,
      "--data",
      root,
      "--agent",
      "agent-a",
      "--file",
      file,
      ...(restore ? ["--restore"] : []),
    ],
    { encoding: "utf8", timeout: 10000 },
  );

test("CLI exports a verified snapshot and restores revisions, identities and message references", (t) => {
  const root = temp(t),
    store = new MemoryStore(path.join(root, "memory.sqlite")),
    memory = store.bind("agent-a");
  const event = memory.append({
    dedupe: "one",
    connectionId: "qq-a",
    conversation: "group:20000",
    messageId: "100",
    kind: "message.received",
    body: "before snapshot",
    payload: { segments: [] },
  });
  memory.append({
    dedupe: "two",
    connectionId: "qq-a",
    conversation: "group:20000",
    messageId: "101",
    kind: "message.received",
    body: "reply",
    payload: { segments: [{ type: "reply", data: { id: "100" } }] },
  });
  const diary = memory.diaryWrite({
    title: "first revision",
    body: "one",
    evidence: [event.id],
  });
  memory.diaryRevise({
    id: diary.id,
    expectedRevision: 1,
    title: "second revision",
    body: "two",
    evidence: [event.id],
  });
  memory.setState("group:20000", {
    readThroughSeq: event.seq,
    session: { id: "session-one" },
  });
  store
    .bind("agent-b")
    .diaryWrite({ title: "other identity", body: "not in export" });
  memory.identity.initialize(
    { id: "agent-a", name: "Synthetic", persona: "Fixture identity" },
    Date.now(),
  );
  memory.identity.put("intentions", {
    id: "intent-one",
    evidence: [event.id],
    createdAfterSeq: event.seq,
  });
  memory.identity.put("session_history", {
    id: "session-one",
    conversation: "group:20000",
    evidence: [event.id],
  });
  // Moods are read newest-first by rowid, so both export paths keep write order.
  for (const [i, mood] of ["开心", "平静", "紧张", "无聊"].entries())
    memory.identity.setMood(
      { mood, intensity: 2, reason: "合成心情" },
      { writtenIn: "group:20000", now: 1000 + i },
    );
  const expected = JSON.parse(JSON.stringify(memory.export().tables));
  store.close();
  const file = path.join(root, "private.json"),
    exported = run(root, file);
  assert.equal(exported.status, 0, exported.stderr);
  const data = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(data.version, 2);
  assert.equal(data.manifest.counts.events, 2);
  assert.deepEqual(data.tables, expected);
  // Windows has no POSIX permission bits to check.
  if (process.platform !== "win32")
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.notEqual(run(root, file).status, 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), data);
  const restored = path.join(root, "restored");
  assert.equal(run(restored, file, true).status, 0);
  const target = new MemoryStore(path.join(restored, "memory.sqlite"));
  try {
    assert.deepEqual(
      JSON.parse(JSON.stringify(target.bind("agent-a").export().tables)),
      expected,
    );
  } finally {
    target.close();
  }
  for (const change of [
    (x) => {
      x.tables.events[0].body = "tampered";
    },
    (x) => {
      x.tables.diary_revisions.pop();
    },
    (x) => {
      delete x.manifest;
    },
  ]) {
    const broken = structuredClone(data);
    change(broken);
    const empty = new MemoryStore(":memory:");
    try {
      assert.throws(
        () => restoreExport(empty.bind("agent-a"), broken),
        /EXPORT_INTEGRITY_FAILED/,
      );
      assert.equal(empty.bind("agent-a").export().tables.events.length, 0);
    } finally {
      empty.close();
    }
  }
});
