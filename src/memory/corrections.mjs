import { randomUUID, createHash } from "node:crypto";

const digest = (value) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const tables = {
  person: "person_notes",
  item: "person_items",
  note: "work_notes",
  intent: "intentions",
};
export class Corrections {
  constructor(memory) {
    this.memory = memory;
  }
  list() {
    return this.memory.db
      .prepare(
        "SELECT value FROM memory_corrections WHERE agent_id=? ORDER BY rowid DESC",
      )
      .all(this.memory.agentId)
      .map((r) => JSON.parse(r.value));
  }
  get(id) {
    const row = this.memory.db
      .prepare("SELECT value FROM memory_corrections WHERE agent_id=? AND id=?")
      .get(this.memory.agentId, id);
    if (!row) throw Error("RECORD_NOT_FOUND");
    return JSON.parse(row.value);
  }
  put(value) {
    this.memory.db
      .prepare("INSERT OR REPLACE INTO memory_corrections VALUES(?,?,?)")
      .run(this.memory.agentId, value.id, JSON.stringify(value));
    return value;
  }
  record(type, id) {
    const m = this.memory;
    if (type === "event" || type === "diary") {
      const row = m.db
        .prepare(
          `SELECT * FROM ${type === "event" ? "events" : "diaries"} WHERE agent_id=? AND id=?`,
        )
        .get(m.agentId, id);
      if (!row) throw Error("RECORD_NOT_FOUND");
      const metadata = JSON.parse(row.payload || row.metadata);
      return {
        id,
        type,
        body: row.body,
        revision: row.revision || 0,
        evidence: metadata.evidence || [],
        metadata,
        conversation: row.conversation,
        personId: null,
      };
    }
    if (!tables[type]) throw Error("INVALID_CORRECTION_TARGET");
    const rows = m.db
      .prepare(`SELECT value FROM ${tables[type]} WHERE agent_id=?`)
      .all(m.agentId);
    const value = rows.map((r) => JSON.parse(r.value)).find((r) => r.id === id);
    if (!value) throw Error("RECORD_NOT_FOUND");
    return { ...value, type };
  }
  // A correction names a claim within a record, never invalidates all its text.
  annotation(type, id, revision) {
    const rows = this.memory.db
      .prepare(
        "SELECT c.value FROM memory_corrections c WHERE c.agent_id=? AND json_extract(c.value,'$.supersededBy') IS NULL AND EXISTS (SELECT 1 FROM json_each(c.value,'$.targets') t WHERE json_extract(t.value,'$.type')=? AND json_extract(t.value,'$.id')=?) ORDER BY rowid DESC LIMIT 5",
      )
      .all(this.memory.agentId, type, id);
    const corrections = rows
      .map((r) => JSON.parse(r.value))
      .flatMap((c) => {
        const t = c.targets.find((t) => t.type === type && t.id === id);
        if (
          t.state === "unaffected" ||
          (t.state === "updated" &&
            revision !== undefined &&
            revision > t.revision)
        )
          return [];
        return [
          {
            id: c.id,
            oldBelief: c.oldBelief,
            current: c.current,
            scope: c.scope,
            kind: c.kind,
            sourceId: c.sourceId,
            at: c.createdAt,
            state: t.direct ? "corrected-claim" : "review-required",
            notice:
              "仅针对所列判断；历史原文和当时感受保留。当前解释来自当事人/管理员，不自动证明其他事实。",
          },
        ];
      });
    return corrections.length ? { corrections } : {};
  }
  scene(scene) {
    if (!scene) return scene;
    return {
      ...scene,
      messages: scene.messages.map((x) => ({
        ...x,
        ...this.annotation("event", x.id),
      })),
      quoted: (scene.quoted || []).map((x) => ({
        ...x,
        ...this.annotation("event", x.id),
      })),
    };
  }
  forPeople(people) {
    return this.list()
      .filter((c) => !c.supersededBy && people.includes(c.personId))
      .slice(0, 8)
      .map((c) => ({
        id: c.id,
        personId: c.personId,
        oldBelief: c.oldBelief,
        current: c.current,
        scope: c.scope,
        sourceId: c.sourceId,
        pending: c.targets.filter((t) => t.state === "pending").length,
      }));
  }
  create(args, source, boundary, now) {
    const prior = this.list().find(
      (c) => c.sourceId === source.id && c.oldBelief === args.oldBelief,
    );
    if (prior) return prior;
    return this.memory.store.transaction(() => {
      const previous = args.supersedes ? this.get(args.supersedes) : null;
      if (previous) {
        const earlier = this.memory.db
          .prepare("SELECT seq FROM events WHERE agent_id=? AND id=?")
          .get(this.memory.agentId, previous.sourceId);
        if (
          previous.supersededBy ||
          previous.personId !== args.personId ||
          !earlier ||
          source.seq <= earlier.seq
        )
          throw Error("CORRECTION_SUPERSESSION_INVALID");
      }
      const inherited = (previous?.targets || [])
        .filter((t) => t.state !== "unaffected")
        .filter((t) => {
          try {
            this.record(t.type, t.id);
            return true;
          } catch {
            return false;
          }
        });
      const targetMap = new Map(
        [...inherited, ...args.targets].map((t) => [t.type + ":" + t.id, t]),
      );
      const direct = [...targetMap.values()].map((t) => ({
        ...this.record(t.type, t.id),
        direct: true,
      }));
      const candidates = [...direct];
      // Evidence dependencies are traversed until stable, plus the person's card/items.
      const records = [
        ...Object.entries(tables).flatMap(([type, table]) =>
          this.memory.db
            .prepare(`SELECT value FROM ${table} WHERE agent_id=?`)
            .all(this.memory.agentId)
            .map((r) => ({ ...JSON.parse(r.value), type })),
        ),
        ...this.memory.db
          .prepare("SELECT id FROM diaries WHERE agent_id=?")
          .all(this.memory.agentId)
          .map((r) => this.record("diary", r.id)),
      ].filter((r) => boundary.allowed(r));
      const keys = new Set(candidates.map((r) => r.type + ":" + r.id));
      let changed = true;
      while (changed) {
        changed = false;
        const ids = new Set(candidates.map((r) => r.id));
        for (const r of records) {
          if (keys.has(r.type + ":" + r.id)) continue;
          if (
            (r.personId === args.personId &&
              ["person", "item"].includes(r.type)) ||
            (r.evidence || []).some((id) => ids.has(id))
          ) {
            candidates.push(r);
            keys.add(r.type + ":" + r.id);
            changed = true;
          }
        }
      }
      if (candidates.length > 200) throw Error("CORRECTION_TARGET_LIMIT");
      for (const r of candidates) {
        boundary.assert(r);
        if (r.personId && r.personId !== args.personId)
          throw Error("CORRECTION_PERSON_MISMATCH");
      }
      const id = randomUUID();
      if (previous)
        this.put({
          ...previous,
          supersededBy: id,
          revision: previous.revision + 1,
        });
      return this.put({
        id,
        ...(previous ? { supersedes: previous.id } : {}),
        personId: args.personId,
        oldBelief: args.oldBelief,
        current: args.current,
        kind: args.kind,
        scope: args.scope,
        sourceId: source.id,
        sourceConversation: source.conversation,
        createdAt: now,
        revision: 1,
        targets: candidates.map((r) => ({
          type: r.type,
          id: r.id,
          direct: !!r.direct,
          revision: r.revision || 0,
          fingerprint: digest(r),
          state: r.type === "event" ? "annotated" : "pending",
        })),
      });
    });
  }
  review(args, boundary, now) {
    return this.memory.store.transaction(() => {
      const c = this.get(args.id);
      if (c.supersededBy) throw Error("CORRECTION_SUPERSEDED");
      if (c.revision !== args.expectedRevision)
        throw Error("REVISION_CONFLICT");
      const target = c.targets.find(
        (t) => t.id === args.targetId && t.type === args.type,
      );
      if (!target || target.state !== "pending")
        throw Error("CORRECTION_TARGET_NOT_PENDING");
      const record = this.record(target.type, target.id);
      boundary.assert(record);
      if (args.action === "updated" && digest(record) === target.fingerprint)
        throw Error("CORRECTION_RECORD_UNCHANGED");
      // Directly corrected claims cannot be dismissed as unrelated.
      if (args.action === "unaffected" && target.direct)
        throw Error("CORRECTION_DIRECT_TARGET");
      Object.assign(target, {
        state: args.action,
        reason: args.reason,
        reviewedAt: now,
      });
      c.revision++;
      return this.put(c);
    });
  }
}
