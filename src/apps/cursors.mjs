const META = "internal:app-cursor:",
  ITEM = "internal:app-cursor-item:";
export const CURSOR_LIMITS = Object.freeze({
  cursorBytes: 8 * 1024 * 1024,
  agentBytes: 32 * 1024 * 1024,
  count: 20,
  pages: 100,
  seen: 10000,
});

// Runtime rows keep exports/restores compatible with schema 6. Summaries never load pending bodies.
export class AppCursors {
  constructor(store, limits) {
    this.store = store;
    this.db = store.db;
    this.limits = { ...CURSOR_LIMITS, ...limits };
  }
  list(agentId) {
    return this.db
      .prepare(
        "SELECT conversation,value FROM runtime WHERE agent_id=? AND conversation>=? AND conversation<?",
      )
      .all(agentId, META, META + "\uffff")
      .map((row) => ({
        id: row.conversation.slice(META.length),
        ...JSON.parse(row.value),
      }));
  }
  remove(agentId, id) {
    this.db
      .prepare(
        "DELETE FROM runtime WHERE agent_id=? AND (conversation=? OR (conversation>=? AND conversation<?))",
      )
      .run(agentId, META + id, ITEM + id + ":", ITEM + id + ":\uffff");
  }
  cleanup(now, agentId) {
    if (!agentId) {
      // Upgrade legacy ledgers once, including roles that have not browsed since restart.
      const legacy = this.db
        .prepare(
          "SELECT agent_id FROM runtime WHERE conversation='internal:app-browsing' AND json_type(value,'$.cursors')='object'",
        )
        .all();
      for (const row of legacy) this.prepare(row.agent_id, now);
    }
    const agents = agentId
      ? [{ agent_id: agentId }]
      : this.db
          .prepare(
            "SELECT DISTINCT agent_id FROM runtime WHERE conversation>=? AND conversation<?",
          )
          .all(META, META + "\uffff");
    this.store.transaction(() => {
      for (const { agent_id: id } of agents)
        for (const cursor of this.list(id))
          if (cursor.expiresAt <= now) this.remove(id, cursor.id);
    });
  }
  prepare(agentId, now) {
    const memory = this.store.bind(agentId),
      state = memory.state("internal:app-browsing");
    if (state.cursors) {
      this.store.transaction(() => {
        for (const [id, value] of Object.entries(state.cursors)) {
          if (value.expiresAt > now) this.write(agentId, id, value);
        }
        const { cursors, ...ledger } = state;
        memory.setState("internal:app-browsing", ledger);
      });
    }
    this.cleanup(now, agentId);
  }
  metadata(agentId, id) {
    const row = this.db
      .prepare("SELECT value FROM runtime WHERE agent_id=? AND conversation=?")
      .get(agentId, META + id);
    return row ? JSON.parse(row.value) : null;
  }
  get(agentId, id) {
    const meta = this.metadata(agentId, id);
    if (!meta) return null;
    const rows = this.db
      .prepare(
        "SELECT value FROM runtime WHERE agent_id=? AND conversation>=? AND conversation<? ORDER BY conversation",
      )
      .all(agentId, ITEM + id + ":", ITEM + id + ":\uffff");
    if (rows.length !== meta.pendingCount) throw Error("APP_CURSOR_INVALID");
    return { ...meta, pending: rows.map((row) => JSON.parse(row.value)) };
  }
  encode(value) {
    const {
      pending = [],
      bytes: oldBytes,
      pendingCount: oldCount,
      ...rest
    } = value;
    const items = pending.map((row) => JSON.stringify(row));
    const meta = { ...rest, pendingCount: items.length };
    const itemBytes = items.reduce((n, row) => n + Buffer.byteLength(row), 0);
    let bytes = itemBytes,
      json;
    // Include the byte-count field itself in the stored UTF-8 value budget.
    do {
      json = JSON.stringify({ ...meta, bytes });
      const total = Buffer.byteLength(json) + itemBytes;
      if (total === bytes) break;
      bytes = total;
      // eslint-disable-next-line no-constant-condition -- exits via break once the size converges
    } while (true);
    return { meta: json, items, bytes };
  }
  write(agentId, id, value, encoded = this.encode(value)) {
    const insert = this.db.prepare(
      "INSERT OR REPLACE INTO runtime VALUES(?,?,?)",
    );
    insert.run(agentId, META + id, encoded.meta);
    for (const [index, item] of encoded.items.entries())
      insert.run(
        agentId,
        ITEM + id + ":" + String(index).padStart(6, "0"),
        item,
      );
  }
  // Called inside the same transaction as saving the observations. Failure preserves the old cursor.
  replace(agentId, oldId, id, value, now) {
    const previous = oldId && this.metadata(agentId, oldId);
    if (oldId && (!previous || previous.expiresAt <= now))
      throw Error("APP_CURSOR_INVALID");
    if (value) {
      const encoded = this.encode(value),
        live = this.list(agentId),
        limit = this.limits;
      const usage = live.reduce((n, row) => n + row.bytes, 0);
      // Legacy oversize cursors can drain, but cannot grow or open additional buffers.
      if (
        encoded.bytes > Math.max(limit.cursorBytes, previous?.bytes || 0) ||
        usage - (previous?.bytes || 0) + encoded.bytes >
          Math.max(limit.agentBytes, previous ? usage : 0) ||
        live.length - (previous ? 1 : 0) >= limit.count ||
        value.pages > limit.pages ||
        value.seen.length > limit.seen
      )
        throw Error("APP_CURSOR_BUDGET");
      if (oldId) this.remove(agentId, oldId);
      this.write(agentId, id, value, encoded);
    } else if (oldId) this.remove(agentId, oldId);
  }
}
