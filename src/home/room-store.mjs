// @ts-check
import { createHash, randomUUID } from "node:crypto";
import { HomeStore } from "./store.mjs";
import { defaultLayout, validateLayout } from "./layout.mjs";
import { HOME_SLOTS } from "./policy.mjs";
/** @param {any} v @returns {any} */
const canonical = (v) =>
  Array.isArray(v)
    ? v.map(canonical)
    : v && typeof v === "object"
      ? Object.fromEntries(
          Object.keys(v)
            .sort()
            .map((k) => [k, canonical(v[k])]),
        )
      : v;
/** Stores only current display text. Receipts and tombstones never retain withdrawn bodies. */
export class RoomStore {
  /** @param {any} db */
  constructor(db) {
    this.db = db;
    this.layouts = new HomeStore(db);
  }
  /** @param {string} generation */
  revision(generation) {
    return (
      this.db
        .prepare("SELECT content_revision n FROM home_rooms WHERE generation=?")
        .get(generation)?.n || 0
    );
  }
  /** @param {string} generation */
  layout(generation) {
    return this.layouts.read("room:" + generation, defaultLayout("room"));
  }
  /** @param {string} generation @param {string} slot */
  item(generation, slot) {
    return this.db
      .prepare("SELECT * FROM home_items WHERE generation=? AND slot=?")
      .get(generation, slot);
  }
  /** @param {string} generation @param {boolean} visible */
  content(generation, visible) {
    return {
      contentRevision: this.revision(generation),
      items: HOME_SLOTS.map((slot) => {
        const row = this.item(generation, slot),
          shown = visible && row?.state === "published";
        return {
          slot,
          itemId: row?.item_id || null,
          itemRevision: row?.revision || 0,
          state: row?.state || "empty",
          ...(shown ? { title: row.title, body: row.body } : {}),
          visible: shown,
          updatedAt: row?.updated_at || null,
        };
      }),
    };
  }
  /** @param {string} generation @param {string} requestId */
  receipt(generation, requestId) {
    const row = this.db
      .prepare(
        "SELECT result FROM home_operations WHERE scene_key=? AND request_id=?",
      )
      .get("room:" + generation, requestId);
    return row ? JSON.parse(row.result) : null;
  }
  /** One namespace spans every owner operation, independent of model session lifetime.
   * @param {string} generation @param {string} kind @param {any} args @param {number|null} quota @param {number} now @param {()=>any} apply @param {any} [intent] */
  execute(generation, kind, args, quota, now, apply, intent) {
    const key = "room:" + generation,
      digest = createHash("sha256")
        .update(JSON.stringify(canonical({ kind, args })))
        .digest("hex");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const prior = this.db
        .prepare(
          "SELECT digest,result FROM home_operations WHERE scene_key=? AND request_id=?",
        )
        .get(key, args.requestId);
      if (prior) {
        if (prior.digest !== digest) throw Error("HOME_REQUEST_CONFLICT");
        this.db.exec("COMMIT");
        return {
          ...JSON.parse(prior.result),
          replayed: true,
          historical: true,
        };
      }
      intent?.before();
      const day = new Date(now).toISOString().slice(0, 10);
      if (quota !== null) {
        const n =
          this.db
            .prepare(
              "SELECT writes FROM home_write_usage WHERE generation=? AND day=?",
            )
            .get(generation, day)?.writes || 0;
        if (n >= quota) throw Error("HOME_WRITE_LIMIT");
      }
      const result = {
        ...apply(),
        operationId: randomUUID(),
        requestId: args.requestId,
        kind,
        committedAt: new Date(now).toISOString(),
        committed: true,
      };
      this.db
        .prepare(
          "INSERT INTO home_operations(scene_key,request_id,digest,result) VALUES(?,?,?,?)",
        )
        .run(key, args.requestId, digest, JSON.stringify(result));
      if (quota !== null)
        this.db
          .prepare(
            "INSERT INTO home_write_usage(generation,day,writes) VALUES(?,?,1) ON CONFLICT(generation,day) DO UPDATE SET writes=writes+1",
          )
          .run(generation, day);
      intent?.after(result);
      this.db.exec("COMMIT");
      return { ...result, replayed: false, historical: false };
    } catch (error) {
      if (this.db.isTransaction) this.db.exec("ROLLBACK");
      throw error;
    }
  }
  /** @param {string} generation @param {any} layout @param {number} expected @param {number} now */
  saveLayout(generation, layout, expected, now) {
    const current = this.layout(generation);
    if (current.layoutRevision !== expected)
      throw Error("HOME_REVISION_CONFLICT");
    validateLayout(layout, "room");
    const revision = expected + 1;
    this.db
      .prepare(
        "INSERT INTO home_layouts(scene_key,revision,layout,created_at) VALUES(?,?,?,?)",
      )
      .run(
        "room:" + generation,
        revision,
        JSON.stringify(layout),
        new Date(now).toISOString(),
      );
    return {
      layoutRevision: revision,
      contentRevision: this.revision(generation),
    };
  }
  /** @param {string} generation @param {number} revision */
  historicalLayout(generation, revision) {
    if (revision === 0) return defaultLayout("room");
    const row = this.db
      .prepare(
        "SELECT layout FROM home_layouts WHERE scene_key=? AND revision=?",
      )
      .get("room:" + generation, revision);
    if (!row) throw Error("HOME_REVISION_NOT_FOUND");
    return JSON.parse(row.layout);
  }
  /** @param {string} generation @param {string} slot @param {number} expected @param {string} state @param {string} title @param {string} body @param {number} now */
  writeItem(generation, slot, expected, state, title, body, now) {
    const row = this.item(generation, slot);
    if ((row?.revision || 0) !== expected) throw Error("HOME_ITEM_CONFLICT");
    const itemId = row?.item_id || randomUUID(),
      itemRevision = expected + 1,
      contentRevision = this.revision(generation) + 1;
    this.db
      .prepare(
        "INSERT INTO home_items(generation,slot,item_id,revision,state,title,body,updated_at) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(generation,slot) DO UPDATE SET revision=excluded.revision,state=excluded.state,title=excluded.title,body=excluded.body,updated_at=excluded.updated_at",
      )
      .run(
        generation,
        slot,
        itemId,
        itemRevision,
        state,
        title,
        body,
        new Date(now).toISOString(),
      );
    this.db
      .prepare(
        "INSERT INTO home_rooms(generation,content_revision) VALUES(?,?) ON CONFLICT(generation) DO UPDATE SET content_revision=excluded.content_revision",
      )
      .run(generation, contentRevision);
    return { slot, itemId, itemRevision, contentRevision, state };
  }
}
