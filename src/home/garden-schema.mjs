// @ts-check
import { initializeGiftTables } from "./garden-items.mjs";
/** @param {import("node:sqlite").DatabaseSync} db */
export function initializeGardenTables(db) {
  initializeGiftTables(db);
  db.exec(`
    CREATE TABLE IF NOT EXISTS garden_history_start (
      id INTEGER PRIMARY KEY CHECK (id=1),
      clock REAL NOT NULL,
      legacy INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS garden_plant_archive (
      plant_id TEXT PRIMARY KEY,
      plot INTEGER NOT NULL,
      crop_id TEXT NOT NULL,
      name TEXT NOT NULL,
      planted_clock REAL,
      actor_kind TEXT,
      actor_id TEXT,
      status TEXT NOT NULL,
      snapshot TEXT
    );
    CREATE TABLE IF NOT EXISTS garden_facts (
      id INTEGER PRIMARY KEY,
      type TEXT NOT NULL,
      clock REAL,
      plants TEXT NOT NULL,
      actor_kind TEXT,
      actor_id TEXT,
      source TEXT NOT NULL,
      detail TEXT NOT NULL,
      unique_key TEXT UNIQUE
    );
    CREATE INDEX IF NOT EXISTS garden_facts_type_clock ON garden_facts(type,clock,id);
    CREATE TABLE IF NOT EXISTS garden_journal_reads (
      reader TEXT PRIMARY KEY,
      through_id INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS garden_board_notes (
      scope TEXT PRIMARY KEY,
      text TEXT NOT NULL,
      author_kind TEXT NOT NULL,
      author_id TEXT NOT NULL,
      author_name TEXT NOT NULL,
      day INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS garden_rumors (
      id TEXT PRIMARY KEY,
      text TEXT NOT NULL,
      source TEXT NOT NULL,
      unlocked_day INTEGER NOT NULL,
      unlocked_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS garden_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      clock REAL NOT NULL CHECK (clock >= 0),
      revision INTEGER NOT NULL,
      settings_revision INTEGER NOT NULL,
      settings TEXT NOT NULL,
      balance INTEGER NOT NULL CHECK (balance >= 0),
      plots TEXT NOT NULL,
      seeds TEXT NOT NULL,
      fertilizer INTEGER NOT NULL CHECK (fertilizer >= 0)
    );
    CREATE TABLE IF NOT EXISTS garden_ledger (
      seq INTEGER PRIMARY KEY,
      at INTEGER NOT NULL,
      actor_kind TEXT NOT NULL,
      actor_id TEXT NOT NULL,
      action TEXT NOT NULL,
      delta INTEGER NOT NULL,
      balance INTEGER NOT NULL CHECK (balance >= 0)
    );
    CREATE TABLE IF NOT EXISTS garden_harvests (
      id TEXT PRIMARY KEY,
      crop_id TEXT NOT NULL,
      planted_by TEXT NOT NULL,
      quality TEXT NOT NULL,
      quantity INTEGER NOT NULL CHECK (quantity >= 0),
      harvested_at INTEGER NOT NULL,
      last_use TEXT
    );
    CREATE TABLE IF NOT EXISTS garden_actions (
      seq INTEGER PRIMARY KEY,
      actor_kind TEXT NOT NULL,
      actor_id TEXT NOT NULL,
      turn_id TEXT,
      request_id TEXT NOT NULL,
      action TEXT NOT NULL,
      at INTEGER NOT NULL,
      digest TEXT NOT NULL,
      result TEXT NOT NULL,
      UNIQUE(actor_kind, actor_id, request_id)
    );
    CREATE INDEX IF NOT EXISTS garden_actions_turn ON garden_actions(actor_id,turn_id);
    CREATE TABLE IF NOT EXISTS garden_weather_seed (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      seed TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS garden_days (
      day INTEGER PRIMARY KEY,
      rules_revision INTEGER NOT NULL,
      weather TEXT NOT NULL,
      kind_streak INTEGER NOT NULL,
      id_streak INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS garden_neighbor_pairs (
      pair TEXT PRIMARY KEY,
      attempts INTEGER NOT NULL CHECK (attempts BETWEEN 1 AND 3),
      night INTEGER NOT NULL,
      discovered INTEGER NOT NULL CHECK (discovered IN (0,1))
    );
    CREATE TABLE IF NOT EXISTS garden_events (
      day INTEGER PRIMARY KEY,
      value TEXT
    );
    CREATE TABLE IF NOT EXISTS garden_mystery_bags (
      id TEXT PRIMARY KEY,
      candidates TEXT NOT NULL,
      rules TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS garden_reward_stock (
      id INTEGER PRIMARY KEY CHECK (id=1),
      fertilizer_credits INTEGER NOT NULL CHECK (fertilizer_credits>=0)
    );
    INSERT OR IGNORE INTO garden_reward_stock VALUES (1,0);
    CREATE TABLE IF NOT EXISTS garden_delegations (
      id TEXT PRIMARY KEY,
      generation TEXT NOT NULL,
      source TEXT NOT NULL,
      event_id TEXT NOT NULL,
      plot INTEGER,
      created_at INTEGER NOT NULL,
      expires_clock REAL NOT NULL,
      updated_at INTEGER NOT NULL,
      revision INTEGER NOT NULL DEFAULT 1,
      viewed INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'queued',
      targets TEXT,
      UNIQUE(generation,source,event_id)
    );
    CREATE INDEX IF NOT EXISTS garden_delegations_inbox ON garden_delegations(generation,status,created_at);
    CREATE INDEX IF NOT EXISTS garden_delegations_source ON garden_delegations(generation,source,updated_at);
    CREATE TABLE IF NOT EXISTS garden_delegation_requests (
      generation TEXT NOT NULL,
      source TEXT NOT NULL,
      request_id TEXT NOT NULL,
      delegation_id TEXT NOT NULL REFERENCES garden_delegations(id),
      PRIMARY KEY(generation,source,request_id)
    );
    CREATE TABLE IF NOT EXISTS garden_delegation_steps (
      generation TEXT NOT NULL,
      request_id TEXT NOT NULL,
      delegation_id TEXT NOT NULL REFERENCES garden_delegations(id),
      kind TEXT NOT NULL,
      result TEXT NOT NULL,
      PRIMARY KEY(generation,request_id)
    );
    CREATE TABLE IF NOT EXISTS garden_gifts (
      id TEXT PRIMARY KEY,
      at INTEGER NOT NULL,
      harvest_id TEXT NOT NULL REFERENCES garden_harvests(id),
      giver_kind TEXT NOT NULL,
      giver_id TEXT NOT NULL,
      recipient_kind TEXT NOT NULL,
      recipient_id TEXT NOT NULL,
      quantity INTEGER NOT NULL CHECK (quantity > 0)
    );
    CREATE INDEX IF NOT EXISTS garden_gifts_recipient ON garden_gifts(recipient_kind,recipient_id,at);
  `);
}
