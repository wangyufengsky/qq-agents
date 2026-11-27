// @ts-check
import { createHash } from "node:crypto";
import { DAY } from "./garden-rules.mjs";

const rumors = {
  "rumor-mistbell": "听说猫薄荷挨着月光夜来香种，晚上偶尔会飘起蓝紫色的花粉……",
  "rumor-sunberry":
    "有老园丁说，向日葵和奶油草莓当邻居，晒够太阳会结出蜜糖色的种子。",
  "rumor-clover":
    "把三叶草照料到完美，或者让它淋一场流星雨，听说能找到四片叶子的那株。",
  "rumor-hydrangea": "蓝雨绣球特别挑天气，淋雨多开成晴空蓝，晒太阳多会偏粉嫩。",
  "rumor-chamomile": "成熟的晚风洋甘菊留在田里，能帮邻居少受一点蚜虫的影响。",
  "rumor-shelter-rain":
    "奶油草莓和玻璃糖多肉都不爱淋细雨，提前支上小遮雨棚品质会稳很多。",
};

/** @param {import("node:sqlite").DatabaseSync} db */
export function boardNotes(db) {
  /** @type {{garden: ReturnType<typeof noteView>|null, plots: Record<number,ReturnType<typeof noteView>>}} */
  const board = { garden: null, plots: {} };
  for (const row of db
    .prepare("SELECT * FROM garden_board_notes ORDER BY scope")
    .all()) {
    const note = noteView(row);
    if (row.scope === "garden") board.garden = note;
    else board.plots[Number(String(row.scope).slice(5))] = note;
  }
  return board;
}

/** @param {Record<string,import("node:sqlite").SQLOutputValue>} row */
function noteView(row) {
  return {
    text: String(row.text),
    authorKind: String(row.author_kind),
    authorId: String(row.author_id),
    authorName: String(row.author_name),
    day: Number(row.day),
    updatedAt: Number(row.updated_at),
  };
}

/** @param {import("node:sqlite").DatabaseSync} db @param {string} scope @param {string} text
 * @param {{kind:string,id:string,name?:string}} actor @param {number} day @param {number} now */
export function writeBoardNote(db, scope, text, actor, day, now) {
  if (!text) {
    db.prepare("DELETE FROM garden_board_notes WHERE scope=?").run(scope);
    return { scope, note: null };
  }
  const authorName =
    actor.name ?? (actor.kind === "admin" ? "管理员" : actor.id);
  db.prepare(
    `INSERT INTO garden_board_notes VALUES (?,?,?,?,?,?,?)
    ON CONFLICT(scope) DO UPDATE SET text=excluded.text, author_kind=excluded.author_kind,
    author_id=excluded.author_id, author_name=excluded.author_name,
    day=excluded.day, updated_at=excluded.updated_at`,
  ).run(scope, text, actor.kind, actor.id, authorName, day, now);
  return {
    scope,
    note: {
      text,
      authorKind: actor.kind,
      authorId: actor.id,
      authorName,
      day,
      updatedAt: now,
    },
  };
}

/** @param {import("node:sqlite").DatabaseSync} db */
export function gardenRumors(db) {
  return db
    .prepare(
      `SELECT id,text,source,unlocked_day AS day,unlocked_at AS unlockedAt
    FROM garden_rumors ORDER BY rowid`,
    )
    .all();
}

/** @param {import("node:sqlite").DatabaseSync} db @param {import("./garden-journal.mjs").GardenJournal} journal
 * @param {"initial"|"calendar"|"merchant"|"visitor"|"trader"} source @param {number} day @param {number} now */
export function unlockGardenRumor(db, journal, source, day, now) {
  const heard = gardenRumors(db);
  const remaining = Object.entries(rumors).filter(
    ([id]) => !heard.some((row) => row.id === id),
  );
  if (!remaining.length || (source === "initial" && heard.length)) return;
  const seed = db
    .prepare("SELECT seed FROM garden_weather_seed WHERE id=1")
    .get()?.seed;
  const draw = createHash("sha256")
    .update(JSON.stringify([seed, day, source, heard.length]))
    .digest()
    .readUInt32BE();
  // The introductory rumor describes an ordinary, market-available crop.
  const pool =
    source === "initial"
      ? remaining.filter(([id]) => id === "rumor-shelter-rain")
      : remaining;
  const [id, text] = pool[draw % pool.length];
  db.prepare("INSERT INTO garden_rumors VALUES (?,?,?,?,?)").run(
    id,
    text,
    source,
    day,
    now,
  );
  journal.record({
    type: "rumor",
    clock: (day - 1) * DAY,
    source: "action",
    detail: { stage: text, rumorId: id },
    key: id,
  });
  return true;
}

/** @param {import("node:sqlite").DatabaseSync} db @param {import("./garden-journal.mjs").GardenJournal} journal
 * @param {number} day @param {number} now */
export function settleGardenRumors(db, journal, day, now) {
  const heard = gardenRumors(db);
  if (!heard.length) {
    unlockGardenRumor(db, journal, "initial", day, now);
    return;
  }
  if (heard.length === Object.keys(rumors).length) return;
  const fromDay = Math.max(
    ...heard
      .filter((row) => row.source === "initial" || row.source === "calendar")
      .map((row) => Number(row.day)),
  );
  for (let milestone = fromDay + 5; milestone <= day; milestone += 5) {
    unlockGardenRumor(db, journal, "calendar", milestone, now);
    if (gardenRumors(db).length === Object.keys(rumors).length) break;
  }
}
