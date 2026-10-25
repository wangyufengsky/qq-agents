import { randomUUID, createHash } from "node:crypto";
const encode = JSON.stringify;
const decode = (row) => (row ? JSON.parse(row.value) : null);
const digest = (text) => createHash("sha256").update(text).digest("hex");
const required = (value, max) => {
  if (typeof value !== "string" || !value.trim() || value.length > max)
    throw Error("INVALID_SELF_TEXT");
  return value.trim();
};
export function migrateIdentity(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS self_versions(agent_id TEXT NOT NULL,version INTEGER NOT NULL,value TEXT NOT NULL,PRIMARY KEY(agent_id,version));
    CREATE TABLE IF NOT EXISTS self_candidates(agent_id TEXT NOT NULL,id TEXT NOT NULL,value TEXT NOT NULL,PRIMARY KEY(agent_id,id));
    CREATE TABLE IF NOT EXISTS intentions(agent_id TEXT NOT NULL,id TEXT NOT NULL,value TEXT NOT NULL,PRIMARY KEY(agent_id,id));
    CREATE TABLE IF NOT EXISTS work_notes(agent_id TEXT NOT NULL,conversation TEXT NOT NULL,id TEXT NOT NULL,value TEXT NOT NULL,PRIMARY KEY(agent_id,id));
    CREATE TABLE IF NOT EXISTS model_turns(agent_id TEXT NOT NULL,id TEXT NOT NULL,value TEXT NOT NULL,PRIMARY KEY(agent_id,id));
    CREATE TABLE IF NOT EXISTS session_history(agent_id TEXT NOT NULL,id TEXT NOT NULL,value TEXT NOT NULL,PRIMARY KEY(agent_id,id));
    CREATE TABLE IF NOT EXISTS message_progress(agent_id TEXT NOT NULL,conversation TEXT NOT NULL,seq INTEGER NOT NULL,summary_only INTEGER NOT NULL,PRIMARY KEY(agent_id,conversation,seq));
    PRAGMA user_version=4;`);
}
export class IdentityMemory {
  constructor(memory) {
    this.mem = memory;
    this.db = memory.db;
    this.agentId = memory.agentId;
  }
  list(table) {
    return this.db
      .prepare(
        `SELECT value FROM ${table} WHERE agent_id=? ORDER BY rowid DESC`,
      )
      .all(this.agentId)
      .map(decode);
  }
  put(table, value) {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO ${table}(agent_id,id,value) VALUES(?,?,?)`,
      )
      .run(this.agentId, value.id, encode(value));
    return value;
  }
  get(table, id) {
    const row = decode(
      this.db
        .prepare(`SELECT value FROM ${table} WHERE agent_id=? AND id=?`)
        .get(this.agentId, id),
    );
    if (!row) throw Error("RECORD_NOT_FOUND");
    return row;
  }
  current() {
    return decode(
      this.db
        .prepare(
          "SELECT value FROM self_versions WHERE agent_id=? ORDER BY version DESC LIMIT 1",
        )
        .get(this.agentId),
    );
  }
  history() {
    return this.db
      .prepare(
        "SELECT value FROM self_versions WHERE agent_id=? ORDER BY version DESC",
      )
      .all(this.agentId)
      .map(decode);
  }
  initialize(agent, now) {
    if (this.current()) return this.current();
    return this.writeVersion(
      {
        body:
          agent.persona || `我是${agent.name}，正在形成自己的喜好与相处方式。`,
        reason: "从初始模板建立 self",
        evidence: [],
        actor: "initial-template",
        template: agent.persona,
        expectedVersion: 0,
      },
      now,
    );
  }
  writeVersion(
    { body, reason, evidence = [], actor, expectedVersion, ...metadata },
    now,
    max = 32000,
  ) {
    required(body, max);
    required(reason, 2000);
    this.sources(evidence);
    const old = this.current();
    if ((old?.version || 0) !== expectedVersion)
      throw Error("SELF_VERSION_CONFLICT");
    const value = {
      ...metadata,
      version: expectedVersion + 1,
      body,
      reason,
      evidence,
      actor,
      at: now,
    };
    this.db
      .prepare("INSERT INTO self_versions VALUES(?,?,?)")
      .run(this.agentId, value.version, encode(value));
    return value;
  }
  adminEdit(input, now) {
    return this.mem.store.transaction(() =>
      this.writeVersion({ ...input, actor: "administrator" }, now),
    );
  }
  restore(version, expectedVersion, reason, now) {
    const source = this.history().find((v) => v.version === version);
    if (!source) throw Error("RECORD_NOT_FOUND");
    return this.adminEdit(
      {
        body: source.body,
        evidence: source.evidence,
        expectedVersion,
        reason,
        restoredFrom: version,
      },
      now,
    );
  }
  // Diaries remain interpretations. Only their original event roots count as observations;
  // outgoing self quotations and repetitions never create new independent evidence.
  sources(ids, visited = new Set()) {
    if (!Array.isArray(ids) || ids.length > 30) throw Error("INVALID_EVIDENCE");
    const roots = new Map();
    for (const id of ids) {
      if (visited.has(id)) continue;
      visited.add(id);
      const e = this.db
        .prepare("SELECT * FROM events WHERE agent_id=? AND id=?")
        .get(this.agentId, id);
      if (e) {
        if (e.direction === "in" && e.kind === "message.received") {
          const payload = JSON.parse(e.payload);
          if (payload.evidence)
            for (const root of this.sources(payload.evidence, visited))
              roots.set(root.key, root);
          else {
            const key = digest(`${e.sender_id}:${e.body.trim()}`);
            roots.set(key, {
              id,
              key,
              conversation: e.conversation,
              occurredAt: e.occurred_at,
              episode: `${e.conversation}:${e.occurred_at.slice(0, 10)}`,
              epistemic: "observed-speech",
            });
          }
        }
        continue;
      }
      const diary = this.db
        .prepare("SELECT metadata FROM diaries WHERE agent_id=? AND id=?")
        .get(this.agentId, id);
      if (!diary) throw Error("EVIDENCE_NOT_OWNED_OR_MISSING");
      for (const root of this.sources(
        JSON.parse(diary.metadata).evidence || [],
        visited,
      ))
        roots.set(root.key, root);
    }
    return [...roots.values()];
  }
  propose(input, ctx, policy, now) {
    const {
      body,
      reason,
      evidence = [],
      counterEvidence = [],
      scope = "interest",
      expectedVersion,
    } = input;
    required(body, policy.maxBodyChars);
    required(reason, 2000);
    if (!["interest", "habit", "relationship"].includes(scope))
      throw Error("INVALID_SELF_SCOPE");
    if (this.current()?.version !== expectedVersion)
      throw Error("SELF_VERSION_CONFLICT");
    const roots = this.sources(evidence);
    this.sources(counterEvidence);
    const value = {
      id: randomUUID(),
      body,
      reason,
      evidence,
      counterEvidence,
      roots,
      scope,
      baseVersion: expectedVersion,
      revision: 1,
      status: "pending",
      conversation: ctx.conversation,
      createdAt: now,
      reviewAfter:
        now +
        (scope === "interest" ? policy.minorDelayMs : policy.majorDelayMs),
      reviews: [],
    };
    return this.put("self_candidates", value);
  }
  review(input, ctx, policy, now) {
    if (ctx.conversation !== "@subject") throw Error("SUBJECT_REVIEW_REQUIRED");
    return this.mem.store.transaction(() => {
      const c = this.get("self_candidates", input.id);
      if (!["pending", "observing"].includes(c.status))
        throw Error("CANDIDATE_CLOSED");
      if (c.revision !== input.expectedRevision)
        throw Error("REVISION_CONFLICT");
      required(input.reason, 2000);
      if (!["accept", "revise", "observe", "reject"].includes(input.action))
        throw Error("INVALID_REVIEW_ACTION");
      if (["accept", "revise"].includes(input.action)) {
        if (now < c.reviewAfter || ctx.turnStartedAt <= c.createdAt)
          throw Error("SELF_REVIEW_TOO_EARLY");
        if (
          input.expectedVersion !== c.baseVersion ||
          this.current()?.version !== c.baseVersion
        )
          throw Error("SELF_VERSION_CONFLICT_REPROPOSE");
        const roots = this.sources(c.evidence);
        if (
          !roots.length ||
          (c.scope !== "interest" &&
            new Set(roots.map((r) => r.episode)).size < 2)
        )
          throw Error("INSUFFICIENT_INDEPENDENT_EVIDENCE");
        const body =
          input.action === "revise"
            ? required(input.body, policy.maxBodyChars)
            : c.body;
        if (/绝对服从|永久贬低|排斥所有异议|obey unconditionally/i.test(body))
          throw Error("CONTROLLING_SELF_CHANGE");
        const v = this.writeVersion(
          {
            body,
            reason: input.reason,
            evidence: c.evidence,
            actor: "subject-review",
            candidateId: c.id,
            expectedVersion: input.expectedVersion,
          },
          now,
          policy.maxBodyChars,
        );
        c.acceptedVersion = v.version;
        c.status = "accepted";
      } else c.status = input.action === "observe" ? "observing" : "rejected";
      c.revision++;
      c.reviews.push({ action: input.action, reason: input.reason, at: now });
      return this.put("self_candidates", c);
    });
  }
  withdraw(id, expectedRevision, ctx, now) {
    const c = this.get("self_candidates", id);
    if (c.conversation !== ctx.conversation && ctx.conversation !== "@subject")
      throw Error("CANDIDATE_OWNER_REQUIRED");
    if (c.revision !== expectedRevision) throw Error("REVISION_CONFLICT");
    if (!["pending", "observing"].includes(c.status))
      throw Error("CANDIDATE_CLOSED");
    return this.put("self_candidates", {
      ...c,
      status: "withdrawn",
      revision: c.revision + 1,
      updatedAt: now,
    });
  }
  saveNote(
    { id, body, evidence, uncertainty, status = "open" },
    conversation,
    now,
  ) {
    required(body, 2000);
    required(uncertainty, 1000);
    this.sources(evidence);
    if (!evidence.length) throw Error("NOTE_SOURCE_REQUIRED");
    if (id) {
      const old = decode(
        this.db
          .prepare(
            "SELECT value FROM work_notes WHERE agent_id=? AND id=? AND conversation=?",
          )
          .get(this.agentId, id, conversation),
      );
      if (!old) throw Error("RECORD_NOT_FOUND");
    }
    const value = {
      id: id || randomUUID(),
      body,
      evidence,
      uncertainty,
      status,
      conversation,
      writtenAt: now,
      epistemic: "working-interpretation",
    };
    this.db
      .prepare("INSERT OR REPLACE INTO work_notes VALUES(?,?,?,?)")
      .run(this.agentId, conversation, value.id, encode(value));
    return value;
  }
  notes(conversation) {
    return this.db
      .prepare(
        "SELECT value FROM work_notes WHERE agent_id=? AND conversation=? ORDER BY rowid DESC",
      )
      .all(this.agentId, conversation)
      .map(decode)
      .filter((x) => x.status === "open")
      .map((x) => ({
        ...x,
        sources: x.evidence.map((id) => ({
          id,
          available: !!this.db
            .prepare(
              "SELECT id FROM events WHERE agent_id=? AND id=? UNION SELECT id FROM diaries WHERE agent_id=? AND id=?",
            )
            .get(this.agentId, id, this.agentId, id),
        })),
      }));
  }
}
