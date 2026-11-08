// @ts-check
import { createHash, randomUUID } from "node:crypto";
import { mergeProtection } from "./protection.mjs";

export const DRAFT_LIFETIME_MS = 7 * 86400000;

/** @param {import("node:sqlite").DatabaseSync} db */
export function createDraftTables(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS qq_drafts(
      id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, connection_id TEXT NOT NULL,
      account_id TEXT NOT NULL, conversation TEXT NOT NULL, tool_name TEXT NOT NULL,
      request_id TEXT NOT NULL, request_hash TEXT NOT NULL, revision INTEGER NOT NULL,
      created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
      imported INTEGER NOT NULL DEFAULT 0 CHECK(imported IN (0,1)), value TEXT NOT NULL,
      UNIQUE(agent_id,id), UNIQUE(agent_id,connection_id,account_id,conversation,tool_name,request_id)
    );
    CREATE INDEX IF NOT EXISTS qq_drafts_scope
      ON qq_drafts(agent_id,connection_id,account_id,conversation,created_at,id);
    CREATE TABLE IF NOT EXISTS qq_draft_items(
      agent_id TEXT NOT NULL, draft_id TEXT NOT NULL, position INTEGER NOT NULL,
      revision INTEGER NOT NULL, request_id TEXT NOT NULL, value TEXT NOT NULL,
      abandoned INTEGER NOT NULL DEFAULT 0 CHECK(abandoned IN (0,1)),
      delivery_request_id TEXT, confirmation TEXT, archive_record_id TEXT,
      PRIMARY KEY(draft_id,position),
      UNIQUE(agent_id,request_id), UNIQUE(agent_id,delivery_request_id),
      FOREIGN KEY(agent_id,draft_id) REFERENCES qq_drafts(agent_id,id),
      FOREIGN KEY(agent_id,delivery_request_id) REFERENCES deliveries(agent_id,request_id),
      CHECK(delivery_request_id IS NULL OR abandoned=0),
      CHECK(confirmation IS NULL OR delivery_request_id IS NOT NULL),
      CHECK(archive_record_id IS NULL OR confirmation IS NOT NULL)
    );
    CREATE INDEX IF NOT EXISTS qq_draft_items_confirmation
      ON qq_draft_items(draft_id,position) WHERE confirmation IS NOT NULL AND archive_record_id IS NULL;
  `);
}

/** @typedef {{agentId:string,connectionId:string,accountId:string,conversation:string}} DraftScope */
/** @typedef {{requestId:string,input:object}} DraftInput */
/** @typedef {{id:string,revision:number,position:number}} DraftItemRef */
/** @typedef {{toolName:string,requestId:string,items:DraftInput[],value:{gapMs?:number,[key:string]:unknown},legacyDeliveries?: Set<string>}} DraftInputGroup */
/** @typedef {{position:number,input:object}} DraftEdit */
/** @typedef {{messageNamespace:string, action:boolean, gatewayFileId?:string}} DraftConfirmation */

const scopeSQL =
  "agent_id=? AND connection_id=? AND account_id=? AND conversation=?";
const receiptJoin = `LEFT JOIN deliveries d ON d.agent_id=i.agent_id
  AND d.request_id=i.delivery_request_id AND d.conversation=g.conversation`;

/** @param {DraftScope} scope */
function scopeArgs(scope) {
  return [
    scope.agentId,
    scope.connectionId,
    scope.accountId,
    scope.conversation,
  ];
}

/** @param {any} row */
function projectGroup(row) {
  return {
    id: String(row.id),
    revision: Number(row.revision),
    toolName: String(row.tool_name),
    requestId: String(row.request_id),
    createdAt: Number(row.created_at),
    expiresAt: Number(row.expires_at),
    imported: row.imported === 1,
    value: JSON.parse(row.value),
  };
}

/** @param {any} row @param {number} now */
function projectItem(row, now) {
  return {
    position: Number(row.position),
    revision: Number(row.revision),
    requestId: String(row.request_id),
    deliveryRequestId:
      row.delivery_request_id == null ? null : String(row.delivery_request_id),
    status:
      row.delivery_request_id != null
        ? String(row.status || "unknown")
        : row.abandoned === 1
          ? "abandoned"
          : row.imported === 1
            ? "imported"
            : now >= Number(row.expires_at)
              ? "expired"
              : "unsubmitted",
    messageId: row.message_id == null ? null : String(row.message_id),
    recordId:
      row.archive_record_id == null ? null : String(row.archive_record_id),
    value: JSON.parse(row.value),
  };
}

// Callers validate tool parameters and own the disclosure policy before using
// this private store. The durable link, rather than a second copy of its
// status, makes the delivery ledger authoritative after a crash or verdict.
export class QQDraftStore {
  /** @param {import("./store.mjs").MemoryStore} store @param {{clock?:()=>number}} [options] */
  constructor(store, { clock = Date.now } = {}) {
    this.store = store;
    this.db = store.db;
    this.clock = clock;
  }

  /** @param {DraftScope} scope @param {string} id */
  #group(scope, id) {
    return this.db
      .prepare(`SELECT * FROM qq_drafts WHERE ${scopeSQL} AND id=?`)
      .get(...scopeArgs(scope), id);
  }

  /** @param {string} id */
  #items(id) {
    return this.db
      .prepare(
        `SELECT i.*,d.status,d.message_id,g.expires_at,g.imported
      FROM qq_draft_items i JOIN qq_drafts g ON g.id=i.draft_id
      ${receiptJoin} WHERE i.draft_id=? ORDER BY i.position`,
      )
      .all(id)
      .map((row) => projectItem(row, this.clock()));
  }

  /** @param {DraftScope} scope @param {string} id */
  read(scope, id) {
    const row = this.#group(scope, id);
    if (!row) throw Error("QQ_DRAFT_NOT_FOUND");
    return { ...projectGroup(row), items: this.#items(id) };
  }

  /** @param {DraftScope} scope @param {{offset?:number,limit?:number,includeSettled?:boolean}} [options] */
  list(scope, { offset = 0, limit = 10, includeSettled = false } = {}) {
    const args = scopeArgs(scope);
    const filter = includeSettled
      ? ""
      : `AND EXISTS(
      SELECT 1 FROM qq_draft_items i ${receiptJoin}
      WHERE i.draft_id=g.id AND
        ((i.delivery_request_id IS NOT NULL AND (d.status IS NULL OR d.status IN ('pending','unknown')))
          OR (i.delivery_request_id IS NULL AND i.abandoned=0 AND g.imported=0 AND g.expires_at>?)))`;
    const rows = this.db
      .prepare(
        `SELECT * FROM qq_drafts g WHERE ${scopeSQL}
      ${filter} ORDER BY created_at DESC,id LIMIT ? OFFSET ?`,
      )
      .all(
        ...args,
        ...(includeSettled ? [] : [this.clock()]),
        limit + 1,
        offset,
      );
    return {
      items: rows.slice(0, limit).map(projectGroup),
      nextOffset: rows.length > limit ? offset + limit : null,
    };
  }

  /** @param {DraftScope} scope */
  unresolved(scope) {
    return this.db
      .prepare(
        `SELECT g.id AS draftId,i.position,coalesce(d.status,'unknown') AS status,i.delivery_request_id AS requestId
      FROM qq_drafts g JOIN qq_draft_items i ON i.draft_id=g.id ${receiptJoin}
      WHERE g.agent_id=? AND g.connection_id=? AND g.account_id=? AND g.conversation=?
        AND i.delivery_request_id IS NOT NULL AND (d.status IS NULL OR d.status IN ('pending','unknown'))
      ORDER BY g.created_at,i.position LIMIT 1`,
      )
      .get(...scopeArgs(scope));
  }

  /** @param {DraftScope} scope @param {DraftInputGroup} draft */
  stage(scope, { toolName, requestId, items, value, legacyDeliveries }) {
    if (!items.length || items.length > 10) throw Error("QQ_DRAFT_INVALID");
    return this.store.transaction(() => {
      const digest = createHash("sha256")
        .update(
          JSON.stringify([
            items.map((item) => item.input),
            value.gapMs ?? null,
          ]),
        )
        .digest("hex");
      const prior = this.db
        .prepare(
          `SELECT id,request_hash FROM qq_drafts WHERE ${scopeSQL} AND tool_name=? AND request_id=?`,
        )
        .get(...scopeArgs(scope), toolName, requestId);
      if (prior) {
        if (prior.request_hash !== digest) throw Error("IDEMPOTENCY_CONFLICT");
        return { draft: this.read(scope, String(prior.id)), created: false };
      }
      if (this.unresolved(scope)) throw Error("QQ_DRAFT_DELIVERY_UNRESOLVED");
      const id = randomUUID(),
        now = this.clock();
      this.db
        .prepare(
          `INSERT INTO qq_drafts(id,agent_id,connection_id,account_id,conversation,tool_name,request_id,request_hash,revision,created_at,expires_at,value)
        VALUES(?,?,?,?,?,?,?,?,1,?,?,?)`,
        )
        .run(
          id,
          ...scopeArgs(scope),
          toolName,
          requestId,
          digest,
          now,
          now + DRAFT_LIFETIME_MS,
          JSON.stringify(value),
        );
      const existing = this.db.prepare(
        "SELECT 1 FROM qq_draft_items WHERE agent_id=? AND request_id=?",
      );
      const insert = this.db
        .prepare(`INSERT INTO qq_draft_items(agent_id,draft_id,position,revision,request_id,value,delivery_request_id)
        VALUES(?,?,?,1,?,?,?)`);
      for (const [position, item] of items.entries()) {
        if (existing.get(scope.agentId, item.requestId))
          throw Error("IDEMPOTENCY_CONFLICT");
        const legacy = legacyDeliveries?.has(item.requestId);
        if (
          legacy &&
          !this.db
            .prepare(
              `SELECT 1 FROM deliveries d JOIN events e
          ON e.agent_id=d.agent_id AND e.dedupe='send:'||d.request_id||':pending'
          WHERE d.agent_id=? AND d.request_id=? AND d.conversation=?
            AND e.conversation=d.conversation AND e.connection_id=? AND e.sender_id=?`,
            )
            .get(
              scope.agentId,
              item.requestId,
              scope.conversation,
              scope.connectionId,
              scope.accountId,
            )
        )
          throw Error("QQ_DRAFT_DELIVERY_MISMATCH");
        insert.run(
          scope.agentId,
          id,
          position,
          item.requestId,
          JSON.stringify(item.input),
          legacy ? item.requestId : null,
        );
      }
      return { draft: this.read(scope, id), created: true };
    });
  }

  /** @param {DraftScope} scope @param {string} id @param {number} revision */
  assertEditable(scope, id, revision) {
    const draft = this.read(scope, id);
    if (draft.revision !== revision) throw Error("QQ_DRAFT_REVISION_CONFLICT");
    if (draft.imported) throw Error("QQ_DRAFT_IMPORTED");
    if (this.clock() >= draft.expiresAt) throw Error("QQ_DRAFT_EXPIRED");
    return draft;
  }

  /** @param {DraftScope} scope @param {string} id @param {number} revision @param {DraftEdit[]} edits @param {object} protection */
  revise(scope, id, revision, edits, protection) {
    return this.store.transaction(() => {
      const draft = this.assertEditable(scope, id, revision);
      const positions = new Set();
      for (const { position } of edits) {
        if (
          positions.has(position) ||
          draft.items[position]?.status !== "unsubmitted"
        )
          throw Error("QQ_DRAFT_ITEM_LOCKED");
        positions.add(position);
      }
      const next = revision + 1;
      for (const { position, input } of edits)
        this.db
          .prepare(
            `UPDATE qq_draft_items SET value=?,revision=?,request_id=?
          WHERE draft_id=? AND position=?`,
          )
          .run(
            JSON.stringify(input),
            next,
            `draft:${id}:${next}:${position}`,
            id,
            position,
          );
      this.db.prepare("UPDATE qq_drafts SET value=?,revision=? WHERE id=?").run(
        JSON.stringify({
          ...draft.value,
          ...mergeProtection(draft.value, protection),
        }),
        next,
        id,
      );
      return this.read(scope, id);
    });
  }

  /** @param {DraftScope} scope @param {string} id @param {number} revision */
  discard(scope, id, revision) {
    return this.store.transaction(() => {
      const draft = this.assertEditable(scope, id, revision);
      if (!draft.items.some((item) => item.status === "unsubmitted"))
        throw Error("QQ_DRAFT_ITEM_LOCKED");
      this.db
        .prepare(
          `UPDATE qq_draft_items SET abandoned=1 WHERE draft_id=? AND delivery_request_id IS NULL`,
        )
        .run(id);
      this.db
        .prepare("UPDATE qq_drafts SET revision=revision+1 WHERE id=?")
        .run(id);
      return this.read(scope, id);
    });
  }

  /** @param {DraftScope} scope @param {DraftItemRef} ref @param {string} requestId */
  bindDelivery(scope, ref, requestId) {
    if (!this.db.isTransaction) throw Error("QQ_DRAFT_TRANSACTION_REQUIRED");
    const draft = this.assertEditable(scope, ref.id, ref.revision);
    if (draft.items[ref.position]?.status !== "unsubmitted")
      throw Error("QQ_DRAFT_ITEM_LOCKED");
    // The existing delivery reservation may substitute the active intent's ID.
    // Validate the actual receipt here before coupling it to this version.
    const receipt = this.db
      .prepare(
        "SELECT status,conversation FROM deliveries WHERE agent_id=? AND request_id=?",
      )
      .get(scope.agentId, requestId);
    if (
      receipt?.status !== "pending" ||
      receipt.conversation !== scope.conversation
    )
      throw Error("QQ_DRAFT_DELIVERY_MISMATCH");
    this.db
      .prepare(
        "UPDATE qq_draft_items SET delivery_request_id=? WHERE draft_id=? AND position=?",
      )
      .run(requestId, ref.id, ref.position);
  }

  /** @param {string} agentId @param {string} requestId @param {DraftConfirmation} confirmation */
  recordConfirmation(agentId, requestId, confirmation) {
    if (!this.db.isTransaction) throw Error("QQ_DRAFT_TRANSACTION_REQUIRED");
    return (
      this.db
        .prepare(
          `UPDATE qq_draft_items SET confirmation=?
      WHERE agent_id=? AND delivery_request_id=? AND confirmation IS NULL
        AND EXISTS(SELECT 1 FROM deliveries d WHERE d.agent_id=qq_draft_items.agent_id
          AND d.request_id=qq_draft_items.delivery_request_id AND d.status='sent')`,
        )
        .run(JSON.stringify(confirmation), agentId, requestId).changes > 0
    );
  }

  /** @param {string} [agentId] @param {string} [requestId] */
  unarchived(agentId, requestId) {
    const rows = this.db
      .prepare(
        `SELECT i.agent_id,i.delivery_request_id,i.confirmation,g.connection_id,
      g.account_id,g.conversation,d.message_id,d.updated_at
      FROM qq_draft_items i JOIN qq_drafts g ON g.id=i.draft_id
      ${receiptJoin} WHERE i.confirmation IS NOT NULL AND i.archive_record_id IS NULL
        AND d.status='sent' AND (? IS NULL OR i.agent_id=?) AND (? IS NULL OR i.delivery_request_id=?)`,
      )
      .all(
        agentId ?? null,
        agentId ?? null,
        requestId ?? null,
        requestId ?? null,
      );
    return rows.map((row) => ({
      agentId: String(row.agent_id),
      requestId: String(row.delivery_request_id),
      connectionId: String(row.connection_id),
      accountId: String(row.account_id),
      conversation: String(row.conversation),
      messageId: row.message_id == null ? null : String(row.message_id),
      confirmedAt: String(row.updated_at),
      confirmation: JSON.parse(String(row.confirmation)),
    }));
  }

  /** @param {string} agentId @param {string} requestId @param {string} recordId */
  recordArchive(agentId, requestId, recordId) {
    if (!this.db.isTransaction) throw Error("QQ_DRAFT_TRANSACTION_REQUIRED");
    this.db
      .prepare(
        `UPDATE qq_draft_items SET archive_record_id=?
      WHERE agent_id=? AND delivery_request_id=? AND confirmation IS NOT NULL AND archive_record_id IS NULL`,
      )
      .run(recordId, agentId, requestId);
  }
}
