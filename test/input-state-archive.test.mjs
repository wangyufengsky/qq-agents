import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { config, temp } from "./helpers.mjs";
import {
  EXPORT_TABLES,
  INPUT_EXPORT_TABLES,
  exportDigest,
  withExportManifest,
} from "../src/memory/export-format.mjs";
import {
  findInput,
  migrateInputBaselines,
  refreshInput,
  semanticInputVersion,
  writeProcessed,
  writeReviewed,
} from "../src/memory/input-state.mjs";
import { MemoryStore } from "../src/memory/store.mjs";
import { restoreExport } from "../src/memory/migrate.mjs";

const agent = "agent-0";
const chat = "group:20000";
const otherChat = "group:20001";
const scope = (conversation = chat, account = "10000") =>
  JSON.stringify([agent, "qq-0", account, conversation, "onebot"]);
const append = (memory, text, conversation = chat) =>
  memory.append({
    dedupe: "test:" + text,
    conversation,
    connectionId: "qq-0",
    kind: "message.received",
    direction: "in",
    senderId: "30000",
    body: text,
    payload: {
      trustedInput: true,
      accountId: "10000",
      messageNamespace: "onebot",
    },
  });
const header = ({ version, agentId, exportedAt, inputVersion }) => ({
  version,
  agentId,
  exportedAt,
  inputVersion,
});

function legacyArchive(data, version) {
  const tables = Object.fromEntries(
    Object.entries(data.tables).filter(
      ([name]) => !INPUT_EXPORT_TABLES.includes(name),
    ),
  );
  const result = {
    version,
    agentId: data.agentId,
    exportedAt: data.exportedAt,
    tables,
  };
  if (version === 1) return result;
  const digest = exportDigest(result);
  for (const name of EXPORT_TABLES.filter((name) => name in tables)) {
    digest.update(name + "\n");
    for (const row of tables[name]) digest.update(JSON.stringify(row) + "\n");
  }
  return {
    ...result,
    manifest: {
      algorithm: "sha256",
      counts: Object.fromEntries(
        Object.entries(tables).map(([name, rows]) => [name, rows.length]),
      ),
      sha256: digest.digest("hex"),
    },
  };
}

test("v1/v2/v3 role restores retain events while v3 dispositions are never activated by a matching checksum", (t) => {
  const source = new MemoryStore(":memory:");
  t.after(() => source.close());
  const memory = source.bind(agent);
  const seen = append(memory, "SYNTHETIC_SEEN"),
    pending = append(memory, "SYNTHETIC_PENDING");
  refreshInput(memory, scope());
  const current = findInput(memory.db, scope(), seen.id);
  writeProcessed(memory.db, scope(), current, "previous-epoch");
  writeReviewed(memory.db, scope(), "previous-delivery", current);
  const data = memory.export();
  assert.equal(data.version, 3);
  assert.equal(data.tables.input_versions.length, 2);
  assert.equal(
    data.tables.input_versions.find(({ id }) => id === seen.id).processed,
    1,
  );

  for (const archive of [
    legacyArchive(data, 1),
    legacyArchive(data, 2),
    data,
  ]) {
    const target = new MemoryStore(":memory:");
    try {
      append(target.bind("other-agent"), "SYNTHETIC_SHIFT");
      const imported = target.bind(agent);
      restoreExport(imported, archive);
      assert.equal(
        imported.db.prepare("SELECT count(*) AS n FROM input_versions").get().n,
        0,
      );
      assert.equal(
        imported.db
          .prepare(
            "SELECT closed_through FROM input_legacy_scopes WHERE agent_id=?",
          )
          .get(agent).closed_through,
        null,
      );
      const row = imported.db
        .prepare("SELECT * FROM events WHERE id=?")
        .get(seen.id);
      assert.notEqual(row.seq, seen.seq);
      assert.equal(semanticInputVersion(row), current.version);
      if (archive.version === 3) {
        const mapped = imported.db
          .prepare("SELECT seq FROM events WHERE id=?")
          .get(pending.id);
        assert.equal(
          imported.db
            .prepare(
              "SELECT summary_only FROM message_progress WHERE agent_id=? AND seq=?",
            )
            .get(agent, mapped.seq).summary_only,
          1,
        );
      }
      refreshInput(imported, scope());
      const fresh = findInput(imported.db, scope(), seen.id);
      assert.equal(fresh.processed, 0);
      assert.equal(fresh.no_reply_turn, null);
      assert.equal(fresh.reviewed_deliveries, "[]");
    } finally {
      target.close();
    }
  }
});

test("re-signed redacted projections and account mismatch do not acquire a historical baseline", (t) => {
  const source = new MemoryStore(":memory:");
  const target = new MemoryStore(":memory:");
  t.after(() => {
    source.close();
    target.close();
  });
  const memory = source.bind(agent);
  const event = append(memory, "SYNTHETIC_ORIGINAL");
  refreshInput(memory, scope());
  const original = findInput(memory.db, scope(), event.id);
  writeProcessed(memory.db, scope(), original);
  writeReviewed(memory.db, scope(), "fixture-delivery", original);
  const data = memory.export();
  data.tables.events.find(({ id }) => id === event.id).body =
    "SYNTHETIC_REDACTED";
  const restored = target.bind(agent);
  restoreExport(restored, withExportManifest(header(data), data.tables));
  refreshInput(restored, scope(chat, "10001"));
  assert.equal(
    findInput(restored.db, scope(chat, "10001"), event.id),
    undefined,
  );
  assert.equal(
    restored.db
      .prepare("SELECT history_required FROM input_scopes WHERE scope=?")
      .get(scope(chat, "10001")).history_required,
    1,
  );
  const row = restored.db
    .prepare("SELECT * FROM events WHERE id=?")
    .get(event.id);
  assert.notEqual(semanticInputVersion(row), original.version);
  assert.equal(
    restored.db
      .prepare(
        "SELECT summary_only FROM message_progress WHERE agent_id=? AND seq=?",
      )
      .get(agent, row.seq).summary_only,
    1,
  );
});

const script = fileURLToPath(
  new URL("../scripts/input-state-preflight.mjs", import.meta.url),
);
const run = (action, root, manifest, confirm) =>
  spawnSync(
    process.execPath,
    [
      script,
      action,
      "--data",
      root,
      "--manifest",
      manifest,
      ...(confirm ? ["--confirm", confirm] : []),
    ],
    { encoding: "utf8", timeout: 15000 },
  );

test("baseline approvals bind every scope and historical version while preserving new arrivals and explicit gaps", (t) => {
  const root = temp(t);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify(config(1)), {
    mode: 0o600,
  });
  const db = new MemoryStore(path.join(root, "memory.sqlite"));
  t.after(() => db.close());
  const memory = db.bind(agent);
  const first = append(memory, "SYNTHETIC_FIRST");
  const gap = append(memory, "SYNTHETIC_GAP");
  const second = append(memory, "SYNTHETIC_SECOND", otherChat);
  db.db
    .prepare("INSERT INTO message_progress VALUES(?,?,?,1)")
    .run(agent, chat, gap.seq);
  migrateInputBaselines(db.db, agent, "import");
  const manifest = path.join(root, "manifest.json"),
    confirm = path.join(root, "approval.json");
  const preview = run("preview", root, manifest);
  assert.equal(preview.status, 0, preview.stderr);
  const raw = fs.readFileSync(manifest, "utf8"),
    plan = JSON.parse(raw);
  assert(!raw.includes("SYNTHETIC_"));
  assert.equal(plan.scopes.length, 2);
  assert.equal(
    plan.scopes.find((row) => row.conversation === chat).legacyGaps,
    1,
  );
  assert.equal(
    db.db.prepare("SELECT count(*) AS n FROM input_scopes").get().n,
    0,
  );
  const choose = (conversation, closedThrough) => ({
    scope: JSON.parse(scope(conversation)),
    closedThrough,
    reason: "已核对历史范围",
  });
  const writeApproval = (choices, allowPartial) =>
    fs.writeFileSync(
      confirm,
      JSON.stringify({ manifestDigest: plan.digest, choices, allowPartial }),
      { mode: 0o600 },
    );
  writeApproval([choose(chat, gap.seq)]);
  assert.match(
    run("apply", root, manifest, confirm).stderr,
    /INPUT_BASELINE_SELECTION_REQUIRED/,
  );
  const changedConfig = config(1);
  changedConfig.connections[0].messageIdNamespace = "alternate-onebot";
  const configFile = path.join(root, "config.json");
  fs.writeFileSync(configFile, JSON.stringify(changedConfig));
  writeApproval([choose(chat, gap.seq), choose(otherChat, second.seq)]);
  assert.match(
    run("apply", root, manifest, confirm).stderr,
    /INPUT_BASELINE_CHOICE_INVALID/,
  );
  fs.writeFileSync(configFile, JSON.stringify(config(1)));
  const later = append(memory, "SYNTHETIC_ARRIVED_AFTER_PREVIEW");
  // A newer migration copy can know a longer history than the approved manifest.
  db.db
    .prepare(
      "UPDATE input_legacy_scopes SET historical_through=? WHERE agent_id=? AND conversation=?",
    )
    .run(later.seq, agent, chat);
  writeApproval([choose(chat, later.seq), choose(otherChat, second.seq)]);
  assert.match(
    run("apply", root, manifest, confirm).stderr,
    /INPUT_BASELINE_CHOICE_INVALID/,
  );
  db.db
    .prepare("UPDATE events SET body=? WHERE id=?")
    .run("SYNTHETIC_CHANGED", first.id);
  writeApproval([choose(chat, gap.seq), choose(otherChat, second.seq)]);
  assert.match(
    run("apply", root, manifest, confirm).stderr,
    /INPUT_BASELINE_STALE/,
  );
  assert.equal(
    db.db
      .prepare(
        "SELECT count(*) AS n FROM input_legacy_scopes WHERE closed_through IS NOT NULL",
      )
      .get().n,
    0,
  );
  db.db
    .prepare("UPDATE events SET body=? WHERE id=?")
    .run("SYNTHETIC_FIRST", first.id);
  const applied = run("apply", root, manifest, confirm);
  assert.equal(applied.status, 0, applied.stderr);
  assert.equal(JSON.parse(applied.stdout).applied, 2);
  refreshInput(memory, scope());
  assert.equal(findInput(db.db, scope(), first.id).legacy_closed, 1);
  assert.equal(findInput(db.db, scope(), gap.id).legacy_closed, 0);
  assert.equal(findInput(db.db, scope(), later.id).legacy_closed, 0);
  assert.equal(findInput(db.db, scope(), later.id).processed, 0);
});
