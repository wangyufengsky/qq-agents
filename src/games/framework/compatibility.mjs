// @ts-check
import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { GameRegistry } from "../core/registry.mjs";
import { fail } from "../core/value.mjs";
import { registerGomokuP2 } from "./module.mjs";
/** Read-only admission before deployment; unknown references never become guessed migrations.
 * @param {string} database */
export function checkGameCompatibility(database) {
  if (!existsSync(database)) return { compatible: true, rooms: 0 };
  const registry = new GameRegistry();
  registerGomokuP2(registry);
  const db = new DatabaseSync(database, { readOnly: true });
  try {
    if (
      db.prepare("PRAGMA application_id").get()?.application_id !== 1363625777
    )
      fail("GAME_DATABASE_INCOMPATIBLE");
    const rows = db.prepare("SELECT data FROM game_rooms").all();
    for (const row of rows)
      registry.resolve(JSON.parse(String(row.data)).moduleRef);
    return { compatible: true, rooms: rows.length };
  } finally {
    db.close();
  }
}
