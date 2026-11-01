// @ts-check
import { DatabaseSync } from "node:sqlite";
import { GameError, fail } from "./value.mjs";

export class GameStore {
  /** @param {string} database @param {()=>number} [clock] */
  constructor(database, clock = Date.now) {
    this.db = new DatabaseSync(database);
    try {
      const tables = this.db
        .prepare("SELECT name FROM sqlite_master WHERE type='table'")
        .all();
      const application = this.db
        .prepare("PRAGMA application_id")
        .get()?.application_id;
      const version = this.db
        .prepare("PRAGMA user_version")
        .get()?.user_version;
      if (
        ((tables.length || application !== 0) && application !== 1363625777) ||
        (application === 1363625777 && version !== 1)
      )
        fail("GAME_DATABASE_INCOMPATIBLE");
      this.db
        .exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;
        BEGIN IMMEDIATE;
        CREATE TABLE IF NOT EXISTS game_rooms(id TEXT PRIMARY KEY, data TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS game_creations(principal TEXT NOT NULL, request_id TEXT NOT NULL, digest TEXT NOT NULL, room_id TEXT NOT NULL, PRIMARY KEY(principal,request_id));
        CREATE TABLE IF NOT EXISTS game_receipts(room_id TEXT NOT NULL REFERENCES game_rooms(id) ON DELETE CASCADE, principal TEXT NOT NULL, action_id TEXT NOT NULL, digest TEXT NOT NULL, receipt TEXT NOT NULL, audit TEXT NOT NULL, PRIMARY KEY(room_id,principal,action_id));
        CREATE TABLE IF NOT EXISTS game_events(room_id TEXT NOT NULL REFERENCES game_rooms(id) ON DELETE CASCADE, seq INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY(room_id,seq));
        CREATE TABLE IF NOT EXISTS game_decisions(id TEXT PRIMARY KEY, room_id TEXT NOT NULL REFERENCES game_rooms(id) ON DELETE CASCADE, status TEXT NOT NULL, data TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS game_bindings(id TEXT PRIMARY KEY, room_id TEXT NOT NULL REFERENCES game_rooms(id) ON DELETE CASCADE, data TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS game_sessions(hash TEXT PRIMARY KEY, room_id TEXT NOT NULL REFERENCES game_rooms(id) ON DELETE CASCADE, data TEXT NOT NULL);
        PRAGMA application_id=1363625777; PRAGMA user_version=1; COMMIT;`);
      this.transaction(() => {
        // A side table preserves the original INSERT shape for rollback to older releases.
        this.db.exec(`CREATE TABLE IF NOT EXISTS game_creation_expiries(
          principal TEXT NOT NULL, request_id TEXT NOT NULL, expires_at INTEGER NOT NULL,
          PRIMARY KEY(principal,request_id),
          FOREIGN KEY(principal,request_id) REFERENCES game_creations(principal,request_id) ON DELETE CASCADE);
          CREATE INDEX IF NOT EXISTS game_creation_expiries_time ON game_creation_expiries(expires_at);`);
        this.db
          .prepare(
            "INSERT OR IGNORE INTO game_creation_expiries SELECT principal,request_id,? FROM game_creations",
          )
          .run(clock() + 7 * 86400000);
      });
    } catch (error) {
      this.db.close();
      throw error;
    }
  }
  /** @template T @param {()=>T} fn @returns {T} */
  transaction(fn) {
    if (this.db.isTransaction) return fn();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      if (error instanceof GameError) throw error;
      return fail("GAME_STORAGE_FAILURE", 500);
    }
  }
  /** @param {string} id @returns {any} */
  room(id) {
    const row = this.db
      .prepare("SELECT data FROM game_rooms WHERE id=?")
      .get(id);
    if (!row) fail("ROOM_UNAVAILABLE", 404);
    return JSON.parse(String(row.data));
  }
  /** @param {any} room */
  save(room) {
    this.db
      .prepare("UPDATE game_rooms SET data=? WHERE id=?")
      .run(JSON.stringify(room), room.id);
  }
  close() {
    this.db.close();
  }
}
