// @ts-check
import { createHash } from "node:crypto";
import { z } from "zod";
const request = z
  .strictObject({
    expectedRevision: z
      .number()
      .int()
      .min(0)
      .max(Number.MAX_SAFE_INTEGER - 1),
    requestId: z.string().regex(/^[A-Za-z0-9_-]{8,80}$/),
    rosterRevision: z.string().max(64).optional(),
    layout: z.unknown().optional(),
    undoRevision: z.number().int().min(0).optional(),
  })
  .refine((v) => (v.layout !== undefined) !== (v.undoRevision !== undefined));
/** @param {any} value @returns {any} */
const canonical = (value) =>
  Array.isArray(value)
    ? value.map(canonical)
    : value && typeof value === "object"
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((k) => [k, canonical(value[k])]),
        )
      : value;
/** Internal storage only; callers must authorize owner and scope before invoking it. */
export class HomeStore {
  /** @param {any} db */
  constructor(db) {
    this.db = db;
  }
  /** @param {string} key @param {any} fallback */
  read(key, fallback) {
    const row = this.db
      .prepare(
        "SELECT revision,layout FROM home_layouts WHERE scene_key=? ORDER BY revision DESC LIMIT 1",
      )
      .get(key);
    return row
      ? { layoutRevision: row.revision, layout: JSON.parse(row.layout) }
      : { layoutRevision: 0, layout: structuredClone(fallback) };
  }
  /** @param {string} key @param {any} input @param {any} fallback @param {(layout:any)=>any} validate @param {number} now */
  commit(key, input, fallback, validate, now) {
    const data = request.parse(input),
      digest = createHash("sha256")
        .update(JSON.stringify(canonical(data)))
        .digest("hex");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const prior = this.db
        .prepare(
          "SELECT digest,result FROM home_operations WHERE scene_key=? AND request_id=?",
        )
        .get(key, data.requestId);
      if (prior) {
        if (prior.digest !== digest) throw Error("HOME_REQUEST_CONFLICT");
        this.db.exec("COMMIT");
        return { ...JSON.parse(prior.result), replayed: true };
      }
      const current = this.read(key, fallback);
      if (current.layoutRevision !== data.expectedRevision)
        throw Error("HOME_REVISION_CONFLICT");
      let layout = data.layout;
      if (data.undoRevision !== undefined) {
        if (data.undoRevision >= current.layoutRevision)
          throw Error("HOME_REVISION_NOT_FOUND");
        const old =
          data.undoRevision === 0
            ? { layout: JSON.stringify(fallback) }
            : this.db
                .prepare(
                  "SELECT layout FROM home_layouts WHERE scene_key=? AND revision=?",
                )
                .get(key, data.undoRevision);
        if (!old) throw Error("HOME_REVISION_NOT_FOUND");
        layout = JSON.parse(old.layout);
      }
      layout = validate(layout);
      const revision = current.layoutRevision + 1;
      this.db
        .prepare(
          "INSERT INTO home_layouts(scene_key,revision,layout,created_at) VALUES(?,?,?,?)",
        )
        .run(
          key,
          revision,
          JSON.stringify(layout),
          new Date(now).toISOString(),
        );
      const result = { layoutRevision: revision, layout };
      this.db
        .prepare(
          "INSERT INTO home_operations(scene_key,request_id,digest,result) VALUES(?,?,?,?)",
        )
        .run(key, data.requestId, digest, JSON.stringify(result));
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      if (this.db.isTransaction) this.db.exec("ROLLBACK");
      throw error;
    }
  }
}
