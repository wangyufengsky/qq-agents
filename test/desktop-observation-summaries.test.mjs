import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import path from "node:path";
import fs from "node:fs";
import { temp } from "./helpers.mjs";
import { DesktopObservationSummaries } from "../src/memory/desktop-observation-summaries.mjs";
import { backupDatabase } from "../src/memory/backup.mjs";
import { exportToFile } from "../src/memory/export.mjs";
import { MemoryStore } from "../src/memory/store.mjs";

const DAY = 86_400_000;
const start = 100 * DAY;
const summary = "Synthetic approved observation";
const proposal = () => ({ id: randomUUID(), summary });

test("approved observations survive additive migration and SQLite backup but stay out of agent memory and export", async (t) => {
  const root = temp(t);
  const file = path.join(root, "memory.sqlite");
  let store = new MemoryStore(file);
  store.db.exec("DROP TABLE desktop_observation_summaries");
  const diary = store
    .bind("agent-a")
    .diaryWrite({ title: "existing", body: "legacy diary" });
  store.close();
  store = new MemoryStore(file);
  t.after(() => store.close());
  const summaries = new DesktopObservationSummaries(store, () => start);
  const saved = summaries.save("agent-a", proposal());
  assert.equal(saved.expiresAt, start + 7 * DAY);
  assert.deepEqual(summaries.list("agent-b"), []);
  assert.equal(summaries.delete("agent-b", saved.id), false);
  assert.equal(
    store.bind("agent-a").readRecord({ id: diary.id }).body,
    "legacy diary",
  );
  assert.throws(
    () => store.bind("agent-a").readRecord({ id: saved.id }),
    /NOT_FOUND/,
  );
  assert.equal(store.bind("agent-a").export().tables.events.length, 0);
  assert.doesNotMatch(
    JSON.stringify(store.bind("agent-a").export()),
    /Synthetic approved observation/,
  );
  const exported = path.join(root, "agent-a.json");
  await exportToFile(store, "agent-a", exported);
  assert.doesNotMatch(
    fs.readFileSync(exported, "utf8"),
    /Synthetic approved observation/,
  );
  const backup = path.join(root, "backup.sqlite");
  await backupDatabase(file, backup);
  const restored = new MemoryStore(backup);
  t.after(() => restored.close());
  const fromBackup = new DesktopObservationSummaries(restored, () => start);
  assert.deepEqual(fromBackup.list("agent-a"), [saved]);
  assert.equal(fromBackup.delete("agent-a", saved.id), true);
  assert.deepEqual(fromBackup.list("agent-a"), []);
});

test("observation restore is role-bound, preserves expiry, and rejects non-summary fields", (t) => {
  const source = new MemoryStore(":memory:");
  const destination = new MemoryStore(":memory:");
  t.after(() => {
    source.close();
    destination.close();
  });
  const writer = new DesktopObservationSummaries(source, () => start);
  const saved = writer.save("agent-a", proposal(), 3);
  const backup = writer.export("agent-a", 3);
  let now = start + DAY;
  const reader = new DesktopObservationSummaries(destination, () => now);
  assert.throws(
    () => reader.restore("agent-b", backup),
    /EXPORT_IDENTITY_MISMATCH/,
  );
  for (const bad of [
    { ...backup, grant: { id: randomUUID() } },
    { ...backup, summaries: [{ ...saved, frame: "capture" }] },
    { ...backup, summaries: [{ ...saved, source: "desktop-chat" }] },
    { ...backup, summaries: [{ ...saved, createdAt: now + 1 }] },
    { ...backup, summaries: [{ ...saved, expiresAt: saved.createdAt }] },
    { ...backup, summaries: [saved, saved] },
  ])
    assert.throws(
      () => reader.restore("agent-a", bad),
      /DESKTOP_OBSERVATION_SUMMARY_INVALID/,
    );
  assert.deepEqual(reader.list("agent-a"), []);
  assert.deepEqual(reader.restore("agent-a", backup, 30), {
    restored: 1,
    expired: 0,
    existing: 0,
  });
  assert.deepEqual(reader.restore("agent-a", backup, 30), {
    restored: 0,
    expired: 0,
    existing: 1,
  });
  assert.deepEqual(reader.list("agent-a", 30), [saved]);
  const [shortened] = reader.list("agent-a", 2);
  assert.equal(shortened.expiresAt, start + 2 * DAY);
  assert.deepEqual(reader.list("agent-a", 30), [shortened]);
  now = saved.expiresAt;
  assert.equal(reader.purge(), 1);
  assert.deepEqual(reader.restore("agent-a", backup, 30), {
    restored: 0,
    expired: 1,
    existing: 0,
  });
  assert.deepEqual(reader.list("agent-a", 30), []);
});

test("observation writes bound text and role capacity with atomic restore and fixed retry expiry", (t) => {
  const store = new MemoryStore(":memory:");
  t.after(() => store.close());
  let now = start;
  const summaries = new DesktopObservationSummaries(store, () => now);
  const input = proposal();
  const saved = summaries.save("agent-a", input);
  now++;
  assert.deepEqual(summaries.save("agent-a", input), saved);
  assert.throws(
    () => summaries.save("agent-a", { ...input, summary: "changed" }),
    /IDEMPOTENCY_MISMATCH/,
  );
  for (const text of [" ", "a".repeat(1001), "\ud800", "text\0suffix"])
    assert.throws(
      () => summaries.save("agent-a", { ...proposal(), summary: text }),
      /DESKTOP_OBSERVATION_SUMMARY_INVALID/,
    );
  for (let i = 1; i < 99; i++) summaries.save("agent-a", proposal());
  const other = summaries.save("agent-b", proposal(), 20);
  assert.throws(
    () =>
      summaries.restore("agent-a", {
        version: 1,
        agentId: "agent-a",
        summaries: [other, { ...other, id: randomUUID() }],
      }),
    /DESKTOP_OBSERVATION_SUMMARY_LIMIT/,
  );
  assert.equal(summaries.list("agent-a").length, 99);
  summaries.save("agent-a", proposal());
  assert.throws(
    () => summaries.save("agent-a", proposal()),
    /DESKTOP_OBSERVATION_SUMMARY_LIMIT/,
  );
  summaries.applyRetention(3);
  assert.equal(summaries.list("agent-b", 20)[0].expiresAt, now + 3 * DAY);
});
