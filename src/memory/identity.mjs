import { randomUUID } from "node:crypto";
import { freezeEvidence, evidenceView } from "./evidence.mjs";
import { mergeProtection } from "./protection.mjs";
const encode = JSON.stringify;
const decode = (row) => (row ? JSON.parse(row.value) : null);
const required = (value, max) => {
  if (typeof value !== "string" || !value.trim() || value.length > max)
    throw Error("INVALID_SELF_TEXT");
  return value.trim();
};
export function migrateIdentity(db) {
  if (db.prepare("PRAGMA user_version").get().user_version >= 4) return;
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
    this.anchors(agent);
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
  anchors(agent) {
    const initial = this.history().at(-1),
      template = initial?.template ?? agent.persona ?? "",
      previous = this.mem.state("@identity").anchors;
    // Free-form persona cannot be reliably parsed into immutable identity and
    // evolving character. Preserve it until the administrator explicitly supplies
    // appearance (including an explicit 'no fixed appearance') before replacement.
    const anchors = {
      name: agent.name,
      appearance: agent.appearance || previous?.appearance || "",
      requiresMigration:
        !!template && !(agent.appearance || previous?.appearance),
    };
    this.mem.setState("@identity", { anchors });
    return anchors;
  }
  writeVersion(
    {
      body,
      reason,
      evidence = [],
      evidenceSnapshot,
      actor,
      expectedVersion,
      ...metadata
    },
    now,
    max = 32000,
  ) {
    required(body, max);
    required(reason, 2000);
    evidenceSnapshot ??= this.freeze(evidence, now);
    const old = this.current();
    if (old && this.mem.state("@identity").anchors?.requiresMigration)
      throw Error("IDENTITY_ANCHORS_REQUIRE_MIGRATION");
    if ((old?.version || 0) !== expectedVersion)
      throw Error("SELF_VERSION_CONFLICT");
    const value = {
      ...metadata,
      version: expectedVersion + 1,
      body,
      reason,
      evidence,
      evidenceSnapshot,
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
        evidenceSnapshot: source.evidenceSnapshot || {
          version: 1,
          status: "legacy-unpinned",
          entryIds: source.evidence || [],
          references: [],
          roots: source.roots || [],
        },
        expectedVersion,
        reason,
        restoredFrom: version,
        ...(source.counterEvidenceSnapshot
          ? {
              counterEvidence: source.counterEvidence || [],
              counterEvidenceSnapshot: source.counterEvidenceSnapshot,
            }
          : {}),
      },
      now,
    );
  }
  sources(ids) {
    return freezeEvidence(this.mem, ids, Date.now()).roots;
  }
  freeze(ids, now) {
    return freezeEvidence(this.mem, ids, now);
  }
  evidence(record) {
    return evidenceView(this.mem, record);
  }
  withEvidence(record) {
    return {
      ...record,
      evidenceSnapshot: this.evidence(record),
      ...(record.counterEvidence
        ? {
            counterEvidenceSnapshot: evidenceView(this.mem, {
              evidence: record.counterEvidence,
              evidenceSnapshot: record.counterEvidenceSnapshot,
            }),
          }
        : {}),
    };
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
    const evidenceSnapshot = this.freeze(evidence, now),
      counterEvidenceSnapshot = this.freeze(counterEvidence, now),
      roots = evidenceSnapshot.roots;
    const value = {
      id: randomUUID(),
      body,
      reason,
      evidence,
      counterEvidence,
      evidenceSnapshot,
      counterEvidenceSnapshot,
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
        if (c.evidenceSnapshot?.status !== "frozen")
          throw Error("EVIDENCE_SNAPSHOT_REQUIRED_REPROPOSE");
        const roots = c.evidenceSnapshot.roots.filter(
          (r) =>
            ![
              "unresolved-reference",
              "unexpanded-reference",
              "forward-reference",
            ].includes(r.epistemic),
        );
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
            evidenceSnapshot: c.evidenceSnapshot,
            counterEvidence: c.counterEvidence,
            counterEvidenceSnapshot: c.counterEvidenceSnapshot,
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
    protection = {},
  ) {
    required(body, 2000);
    required(uncertainty, 1000);
    const proof = freezeEvidence(this.mem, evidence, now, {
      allowProtected: true,
    });
    if (!evidence.length) throw Error("NOTE_SOURCE_REQUIRED");
    let old;
    if (id) {
      old = decode(
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
      ...mergeProtection(
        old,
        protection,
        ...proof.references.map((r) => r.metadata),
      ),
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
  // Open notes across every group and private chat, most recently written
  // first, for free time to see what is still pending. Only the chat that
  // wrote a note can change it.
  openNotes() {
    return this.db
      .prepare(
        "SELECT value FROM work_notes WHERE agent_id=? AND (conversation LIKE 'group:%' OR conversation LIKE 'private:%') AND json_extract(value,'$.status')='open' ORDER BY json_extract(value,'$.writtenAt') DESC, rowid DESC",
      )
      .all(this.agentId)
      .map(decode);
  }
  // A person card is the agent's own view of someone: how to address them and
  // how they get along. Every conversation shares it, like Self, so it never
  // holds protected material. Recent revisions stay for review.
  personCard(personId) {
    return decode(
      this.db
        .prepare(
          "SELECT value FROM person_notes WHERE agent_id=? AND person_id=?",
        )
        .get(this.agentId, String(personId)),
    );
  }
  personCards() {
    return this.db
      .prepare(
        "SELECT value FROM person_notes WHERE agent_id=? ORDER BY json_extract(value,'$.updatedAt') DESC",
      )
      .all(this.agentId)
      .map(decode);
  }
  savePersonCard(
    { personId, call = "", body, evidence = [], expectedRevision = 0 },
    { writtenIn, author = "agent", now },
  ) {
    personId = String(personId);
    if (!/^\d{5,12}$/.test(personId)) throw Error("INVALID_PERSON");
    if (
      typeof call !== "string" ||
      call.trim().length > 40 ||
      typeof body !== "string" ||
      !body.trim() ||
      body.length > 600
    )
      throw Error("INVALID_PERSON_NOTE");
    // The administrator vouches for an edit; the agent cites what it saw.
    if (author === "agent") {
      if (!evidence.length) throw Error("NOTE_SOURCE_REQUIRED");
      freezeEvidence(this.mem, evidence, now);
    }
    const old = this.personCard(personId);
    if ((old?.revision || 0) !== expectedRevision)
      throw Error("REVISION_CONFLICT");
    const value = {
      // Stable for the card's life; a card deleted and written again is a
      // new card even though its revision restarts at 1.
      id: old?.id || randomUUID(),
      personId,
      call: call.trim(),
      body: body.trim(),
      evidence,
      revision: (old?.revision || 0) + 1,
      author,
      writtenIn: writtenIn ?? null,
      updatedAt: now,
      epistemic: "agent-impression",
      history: old
        ? [
            {
              revision: old.revision,
              call: old.call,
              body: old.body,
              evidence: old.evidence,
              author: old.author,
              writtenIn: old.writtenIn,
              updatedAt: old.updatedAt,
            },
            ...old.history,
          ].slice(0, 10)
        : [],
    };
    this.db
      .prepare("INSERT OR REPLACE INTO person_notes VALUES(?,?,?)")
      .run(this.agentId, personId, encode(value));
    return value;
  }
  deletePersonCard(personId, expectedRevision) {
    const old = this.personCard(personId);
    if (!old) throw Error("RECORD_NOT_FOUND");
    if (old.revision !== expectedRevision) throw Error("REVISION_CONFLICT");
    this.db
      .prepare("DELETE FROM person_notes WHERE agent_id=? AND person_id=?")
      .run(this.agentId, old.personId);
    return { deleted: true, personId: old.personId };
  }
  // The agent's own account of its mood, written when it actually changes,
  // with why. Only the agent writes or clears it; nothing computes or decays
  // it, and it stops applying when it expires. Every change is a new row, so
  // the console can show the history (read-only).
  moodHistory(limit = 50) {
    return this.db
      .prepare(
        "SELECT value FROM moods WHERE agent_id=? ORDER BY rowid DESC LIMIT ?",
      )
      .all(this.agentId, limit)
      .map(decode);
  }
  // Who each mood is about: the people whose incoming messages (or their
  // voice transcripts) it cites as evidence, never the agent's own account.
  // Read from the cited events each time; nothing is copied onto the mood.
  moodPeople(moods, accountId) {
    const cited = [...new Set(moods.flatMap((x) => x.evidence || []))];
    const senders = new Map(
      cited.length
        ? this.db
            .prepare(
              "SELECT id,sender_id FROM events WHERE agent_id=? AND (direction='in' OR kind='voice.transcript') AND id IN (SELECT value FROM json_each(?))",
            )
            .all(this.agentId, encode(cited))
            .filter(
              (r) =>
                /^\d{5,12}$/.test(r.sender_id || "") &&
                r.sender_id !== accountId,
            )
            .map((r) => [r.id, r.sender_id])
        : [],
    );
    return new Map(
      moods.map((x) => [
        x.id,
        [
          ...new Set(
            (x.evidence || []).map((id) => senders.get(id)).filter(Boolean),
          ),
        ],
      ]),
    );
  }
  currentMood(now) {
    const [latest] = this.moodHistory(1);
    return latest?.action === "set" && latest.expiresAt > now ? latest : null;
  }
  setMood(
    { mood = "", intensity, reason, hours = 4, evidence = [], clear = false },
    { writtenIn, now },
  ) {
    if (
      typeof reason !== "string" ||
      !reason.trim() ||
      reason.length > 300 ||
      typeof mood !== "string" ||
      mood.length > 40 ||
      (!clear &&
        (!mood.trim() ||
          !Number.isInteger(intensity) ||
          intensity < 1 ||
          intensity > 5)) ||
      !(hours >= 0.5 && hours <= 24)
    )
      throw Error("INVALID_MOOD");
    if (evidence.length) freezeEvidence(this.mem, evidence, now);
    const [previous] = this.moodHistory(1);
    // A strong mood still in effect changes only for something that happened
    // after it was written: a newer record cited as evidence. Without one it
    // stays until it expires, so a fresh session cannot flip it on a whim.
    if (
      previous?.action === "set" &&
      previous.expiresAt > now &&
      previous.intensity >= 4 &&
      !evidence.some(
        (id) =>
          (this.db
            .prepare("SELECT seq FROM events WHERE agent_id=? AND id=?")
            .get(this.agentId, id)?.seq ?? 0) > (previous.sinceSeq ?? 0),
      )
    )
      throw Error("MOOD_CHANGE_NEEDS_CAUSE");
    const value = {
      id: randomUUID(),
      action: clear ? "clear" : "set",
      ...(clear
        ? {}
        : {
            mood: mood.trim(),
            intensity,
            since: now,
            expiresAt: now + Math.round(hours * 3600000),
            // Records after this point can count as a cause for changing it.
            sinceSeq:
              this.db
                .prepare("SELECT MAX(seq) AS seq FROM events WHERE agent_id=?")
                .get(this.agentId).seq || 0,
          }),
      evidence,
      reason: reason.trim(),
      writtenIn: writtenIn ?? null,
      writtenAt: now,
      previousId: previous?.id ?? null,
    };
    this.db
      .prepare("INSERT INTO moods VALUES(?,?,?)")
      .run(this.agentId, value.id, encode(value));
    // Keep a bounded history; the oldest changes go first.
    this.db
      .prepare(
        "DELETE FROM moods WHERE agent_id=? AND rowid NOT IN (SELECT rowid FROM moods WHERE agent_id=? ORDER BY rowid DESC LIMIT 500)",
      )
      .run(this.agentId, this.agentId);
    return value;
  }
}
