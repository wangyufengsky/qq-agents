// @ts-check
import { z } from "zod";

export const DEFAULT_OBSERVATION_SUMMARY_RETENTION_DAYS = 7;
export const MAX_OBSERVATION_SUMMARY_RETENTION_DAYS = 30;
const MAX_SUMMARIES = 100;
const DAY = 86_400_000;
const SOURCE = "desktop-observation";
const summaryFields = {
  id: z.string().uuid(),
  summary: z
    .string()
    .max(1000)
    .refine(
      (text) =>
        text.trim() && !text.includes("\0") && !/[\uD800-\uDFFF]/u.test(text),
    ),
};
const summaryInput = z.strictObject(summaryFields);
const summaryRow = summaryInput.extend({
  source: z.literal(SOURCE),
  createdAt: z.number().int().nonnegative(),
  expiresAt: z.number().int().nonnegative(),
});
const summaryExport = z.strictObject({
  version: z.literal(1),
  agentId: z.string(),
  summaries: z.array(summaryRow).max(MAX_SUMMARIES),
});

/** @typedef {z.infer<typeof summaryRow>} SummaryRow */
/** @typedef {import("./store.mjs").MemoryStore} MemoryStore */

// This additive table stays outside AgentMemory and both agent export paths.
/** @param {import("node:sqlite").DatabaseSync} db */
export function initializeDesktopObservationSummaries(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS desktop_observation_summaries(
      agent_id TEXT NOT NULL,
      id TEXT NOT NULL,
      summary TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL CHECK(expires_at>created_at),
      PRIMARY KEY(agent_id,id)
    );
    CREATE INDEX IF NOT EXISTS desktop_observation_summary_expiry
      ON desktop_observation_summaries(expires_at);
  `);
}

/** @param {number} days */
function retentionMs(days) {
  if (
    !Number.isSafeInteger(days) ||
    days < 1 ||
    days > MAX_OBSERVATION_SUMMARY_RETENTION_DAYS
  )
    throw Error("DESKTOP_OBSERVATION_SUMMARY_INVALID");
  return days * DAY;
}

const projection = `id, '${SOURCE}' AS source, summary, created_at AS createdAt, expires_at AS expiresAt`;

export class DesktopObservationSummaries {
  /** @param {MemoryStore} store @param {() => number} [now] */
  constructor(store, now = Date.now) {
    this.store = store;
    this.db = store.db;
    this.now = now;
  }

  /** @param {number} now */
  #purge(now) {
    return Number(
      this.db
        .prepare(
          "DELETE FROM desktop_observation_summaries WHERE expires_at<=?",
        )
        .run(now).changes,
    );
  }

  purge() {
    return this.#purge(this.now());
  }

  /** @param {number} duration @param {number} now @param {string|null} agentId */
  #applyRetention(duration, now, agentId) {
    // Persist shortened deadlines so raising the policy cannot revive a row.
    this.db
      .prepare(
        `UPDATE desktop_observation_summaries SET expires_at=created_at+?
        WHERE expires_at>created_at+? AND (? IS NULL OR agent_id=?)`,
      )
      .run(duration, duration, agentId, agentId);
    this.#purge(now);
  }

  applyRetention(retentionDays = DEFAULT_OBSERVATION_SUMMARY_RETENTION_DAYS) {
    const duration = retentionMs(retentionDays);
    this.store.transaction(() =>
      this.#applyRetention(duration, this.now(), null),
    );
  }

  /** @param {string} agentId */
  list(agentId, retentionDays = DEFAULT_OBSERVATION_SUMMARY_RETENTION_DAYS) {
    this.store.bind(agentId);
    const duration = retentionMs(retentionDays);
    return this.store.transaction(() => {
      this.#applyRetention(duration, this.now(), agentId);
      return /** @type {SummaryRow[]} */ (
        this.db
          .prepare(
            `SELECT ${projection} FROM desktop_observation_summaries
            WHERE agent_id=? ORDER BY created_at DESC,id`,
          )
          .all(agentId)
          .map((row) => ({ ...row }))
      );
    });
  }

  /** @param {string[]} agents */
  visible(agents) {
    if (!agents.length) return [];
    // The host already applied the active retention policy.
    return /** @type {(SummaryRow & {agentId: string})[]} */ (
      this.db
        .prepare(
          `SELECT ${projection}, agent_id AS agentId
        FROM desktop_observation_summaries
        WHERE agent_id IN (${agents.map(() => "?").join(",")}) AND expires_at>?
        ORDER BY created_at DESC,id`,
        )
        .all(...agents, this.now())
    );
  }

  /** @param {string} agentId @param {string} id */
  delete(agentId, id) {
    this.store.bind(agentId);
    if (!summaryFields.id.safeParse(id).success)
      throw Error("DESKTOP_OBSERVATION_SUMMARY_INVALID");
    return !!this.db
      .prepare(
        "DELETE FROM desktop_observation_summaries WHERE agent_id=? AND id=?",
      )
      .run(agentId, id).changes;
  }

  /** @param {string} agentId @param {string} id */
  #get(agentId, id) {
    return /** @type {SummaryRow | undefined} */ (
      this.db
        .prepare(
          `SELECT ${projection} FROM desktop_observation_summaries WHERE agent_id=? AND id=?`,
        )
        .get(agentId, id)
    );
  }

  /** @param {string} agentId */
  #count(agentId) {
    const row = this.db
      .prepare(
        "SELECT count(*) AS count FROM desktop_observation_summaries WHERE agent_id=?",
      )
      .get(agentId);
    return Number(row?.count);
  }

  /** @param {string} agentId @param {SummaryRow} row */
  #insert(agentId, row) {
    this.db
      .prepare(
        `INSERT INTO desktop_observation_summaries(agent_id,id,summary,created_at,expires_at)
        VALUES(?,?,?,?,?)`,
      )
      .run(agentId, row.id, row.summary, row.createdAt, row.expiresAt);
  }

  /** @param {string} agentId @param {z.infer<typeof summaryInput>} value */
  save(
    agentId,
    value,
    retentionDays = DEFAULT_OBSERVATION_SUMMARY_RETENTION_DAYS,
  ) {
    this.store.bind(agentId);
    const parsed = summaryInput.safeParse(value);
    if (!parsed.success) throw Error("DESKTOP_OBSERVATION_SUMMARY_INVALID");
    const duration = retentionMs(retentionDays);
    const createdAt = this.now();
    /** @type {SummaryRow} */
    const row = {
      ...parsed.data,
      source: SOURCE,
      createdAt,
      expiresAt: createdAt + duration,
    };
    return this.store.transaction(() => {
      this.#applyRetention(duration, createdAt, agentId);
      const existing = this.#get(agentId, row.id);
      if (existing) {
        if (existing.summary !== row.summary)
          throw Error("IDEMPOTENCY_MISMATCH");
        return { ...existing };
      }
      if (this.#count(agentId) >= MAX_SUMMARIES)
        throw Error("DESKTOP_OBSERVATION_SUMMARY_LIMIT");
      this.#insert(agentId, row);
      return row;
    });
  }

  /** @param {string} agentId */
  export(agentId, retentionDays = DEFAULT_OBSERVATION_SUMMARY_RETENTION_DAYS) {
    return {
      version: 1,
      agentId,
      summaries: this.list(agentId, retentionDays),
    };
  }

  /** @param {string} agentId @param {unknown} payload */
  restore(
    agentId,
    payload,
    retentionDays = DEFAULT_OBSERVATION_SUMMARY_RETENTION_DAYS,
  ) {
    this.store.bind(agentId);
    const parsed = summaryExport.safeParse(payload);
    if (!parsed.success) throw Error("DESKTOP_OBSERVATION_SUMMARY_INVALID");
    const { data } = parsed;
    if (data.agentId !== agentId) throw Error("EXPORT_IDENTITY_MISMATCH");
    const now = this.now();
    const duration = retentionMs(retentionDays);
    if (
      new Set(data.summaries.map(({ id }) => id)).size !==
        data.summaries.length ||
      data.summaries.some(
        ({ createdAt, expiresAt }) =>
          createdAt > now ||
          expiresAt <= createdAt ||
          expiresAt - createdAt > MAX_OBSERVATION_SUMMARY_RETENTION_DAYS * DAY,
      )
    )
      throw Error("DESKTOP_OBSERVATION_SUMMARY_INVALID");
    return this.store.transaction(() => {
      this.#applyRetention(duration, now, agentId);
      const result = { restored: 0, expired: 0, existing: 0 };
      const count = this.#count(agentId);
      for (const row of data.summaries) {
        const expiresAt = Math.min(row.expiresAt, row.createdAt + duration);
        if (expiresAt <= now) {
          result.expired++;
          continue;
        }
        const existing = this.#get(agentId, row.id);
        if (existing) {
          if (
            existing.summary !== row.summary ||
            existing.createdAt !== row.createdAt
          )
            throw Error("IDEMPOTENCY_MISMATCH");
          result.existing++;
          continue;
        }
        if (count + result.restored >= MAX_SUMMARIES)
          throw Error("DESKTOP_OBSERVATION_SUMMARY_LIMIT");
        this.#insert(agentId, { ...row, expiresAt });
        result.restored++;
      }
      return result;
    });
  }
}
