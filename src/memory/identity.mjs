import { randomUUID } from "node:crypto";
import { freezeEvidence, evidenceView } from "./evidence.mjs";
import { mergeProtection } from "./protection.mjs";
const encode = JSON.stringify;
const decode = (row) => (row ? JSON.parse(row.value) : null);
export const PERSON_ITEM_KINDS = ["promise", "shared", "boundary"];
const PERSON_ITEM_STATUSES = ["open", "done", "dropped"];
const MAX_OPEN_PERSON_ITEMS = 20;
const MAX_CLOSED_PERSON_ITEMS = 30;
const PROJECT_STATUSES = ["active", "paused", "done", "dropped"];
const MAX_LIVE_PROJECTS = 5;
const PROJECT_STEPS = 30;
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
  // What stands between the agent and one person, beside the card: a promise
  // it made, something they went through together, or a boundary the person
  // set. Shared by every conversation like the card, so it never holds
  // protected material. An item stays open until the agent closes it, and
  // closing needs a chat message from after it was written: the report back,
  // or the person saying it is no longer needed. Nothing closes silently.
  personItem(id) {
    return decode(
      this.db
        .prepare("SELECT value FROM person_items WHERE agent_id=? AND id=?")
        .get(this.agentId, String(id)),
    );
  }
  // Open items first, newest first within each, then closed ones.
  personItems(personId) {
    return this.db
      .prepare(
        "SELECT value FROM person_items WHERE agent_id=? AND json_extract(value,'$.personId')=? ORDER BY json_extract(value,'$.status')<>'open', json_extract(value,'$.updatedAt') DESC, rowid DESC",
      )
      .all(this.agentId, String(personId))
      .map(decode);
  }
  // Open items of one kind across everyone, oldest first: what has waited
  // longest comes up first.
  openPersonItems(kind) {
    return this.db
      .prepare(
        "SELECT value FROM person_items WHERE agent_id=? AND json_extract(value,'$.status')='open' AND (? IS NULL OR json_extract(value,'$.kind')=?) ORDER BY json_extract(value,'$.createdAt'), rowid",
      )
      .all(this.agentId, kind ?? null, kind ?? null)
      .map(decode);
  }
  savePersonItem(
    {
      id,
      personId,
      kind,
      body,
      evidence = [],
      status = "open",
      outcome = "",
      expectedRevision = 0,
    },
    { writtenIn, now },
  ) {
    personId = String(personId);
    if (!/^\d{5,12}$/.test(personId)) throw Error("INVALID_PERSON");
    if (
      (body !== undefined &&
        (typeof body !== "string" || !body.trim() || body.length > 300)) ||
      typeof outcome !== "string" ||
      outcome.length > 300 ||
      !PERSON_ITEM_STATUSES.includes(status)
    )
      throw Error("INVALID_PERSON_ITEM");
    if (!evidence.length) throw Error("NOTE_SOURCE_REQUIRED");
    freezeEvidence(this.mem, evidence, now);
    const old = id ? this.personItem(id) : null;
    if (id && !old) throw Error("RECORD_NOT_FOUND");
    if ((old?.revision || 0) !== expectedRevision)
      throw Error("REVISION_CONFLICT");
    if (old) {
      if (old.personId !== personId || (kind && kind !== old.kind))
        throw Error("INVALID_PERSON_ITEM");
      if (old.status !== "open") throw Error("PERSON_ITEM_CLOSED");
    } else if (
      !PERSON_ITEM_KINDS.includes(kind) ||
      body === undefined ||
      status !== "open"
    )
      throw Error("INVALID_PERSON_ITEM");
    const closing = status !== "open";
    if (closing) {
      if (!outcome.trim()) throw Error("INVALID_PERSON_ITEM");
      // A chat message with this person after the item was written: theirs,
      // or the agent's in their private chat or a chat they speak in. An
      // idle-time log, or a message to someone else, does not close it.
      const later = this.db.prepare(
        `SELECT e.seq FROM events e WHERE e.agent_id=? AND e.id=? AND e.seq>? AND (
          (e.kind IN ('message.received','voice.transcript') AND e.sender_id=?)
          OR (e.kind='message.sent' AND (e.conversation=? OR EXISTS (SELECT 1 FROM events h WHERE h.agent_id=e.agent_id AND h.conversation=e.conversation AND h.kind='message.received' AND h.sender_id=?))))`,
      );
      if (
        !evidence.some((x) =>
          later.get(
            this.agentId,
            x,
            old.sinceSeq,
            personId,
            "private:" + personId,
            personId,
          ),
        )
      )
        throw Error("PERSON_ITEM_CLOSE_NEEDS_MESSAGE");
    }
    if (
      !old &&
      this.personItems(personId).filter((x) => x.status === "open").length >=
        MAX_OPEN_PERSON_ITEMS
    )
      throw Error("PERSON_ITEM_LIMIT");
    const value = {
      id: old?.id || randomUUID(),
      personId,
      kind: old?.kind || kind,
      body: body === undefined ? old.body : body.trim(),
      status,
      ...(closing ? { outcome: outcome.trim(), closedAt: now } : {}),
      evidence,
      revision: (old?.revision || 0) + 1,
      writtenIn: writtenIn ?? null,
      createdIn: old?.createdIn ?? writtenIn ?? null,
      createdAt: old?.createdAt ?? now,
      updatedAt: now,
      // Messages after this point can close it.
      sinceSeq:
        old?.sinceSeq ??
        (this.db
          .prepare("SELECT MAX(seq) AS seq FROM events WHERE agent_id=?")
          .get(this.agentId).seq ||
          0),
      epistemic: "agent-impression",
      history: old
        ? [
            {
              revision: old.revision,
              body: old.body,
              status: old.status,
              evidence: old.evidence,
              writtenIn: old.writtenIn,
              updatedAt: old.updatedAt,
            },
            ...old.history,
          ].slice(0, 10)
        : [],
    };
    this.db
      .prepare("INSERT OR REPLACE INTO person_items VALUES(?,?,?)")
      .run(this.agentId, value.id, encode(value));
    // Closed items are kept for the console, the most recent ones per person.
    if (closing)
      this.db
        .prepare(
          "DELETE FROM person_items WHERE agent_id=? AND json_extract(value,'$.personId')=? AND json_extract(value,'$.status')<>'open' AND id NOT IN (SELECT id FROM person_items WHERE agent_id=? AND json_extract(value,'$.personId')=? AND json_extract(value,'$.status')<>'open' ORDER BY json_extract(value,'$.closedAt') DESC LIMIT ?)",
        )
        .run(
          this.agentId,
          personId,
          this.agentId,
          personId,
          MAX_CLOSED_PERSON_ITEMS,
        );
    return value;
  }
  // The administrator removes an item that should not be there; the agent
  // can write it again if it still applies.
  deletePersonItem(id, expectedRevision) {
    const old = this.personItem(id);
    if (!old) throw Error("RECORD_NOT_FOUND");
    if (old.revision !== expectedRevision) throw Error("REVISION_CONFLICT");
    this.db
      .prepare("DELETE FROM person_items WHERE agent_id=? AND id=?")
      .run(this.agentId, old.id);
    return { deleted: true, id: old.id };
  }
  // Something the agent pursues for itself across free-time turns: why it
  // cares, each step it took, what it made, where it got stuck, and in the
  // end whether it finished or let it go. Shared by every conversation, so
  // it can talk about its own work, and never holding protected material.
  project(id) {
    return decode(
      this.db
        .prepare("SELECT value FROM projects WHERE agent_id=? AND id=?")
        .get(this.agentId, String(id)),
    );
  }
  // Active ones first, then paused, then finished; most recently worked on
  // first within each.
  projects() {
    return this.db
      .prepare(
        "SELECT value FROM projects WHERE agent_id=? ORDER BY CASE json_extract(value,'$.status') WHEN 'active' THEN 0 WHEN 'paused' THEN 1 ELSE 2 END, json_extract(value,'$.updatedAt') DESC, rowid DESC",
      )
      .all(this.agentId)
      .map(decode);
  }
  saveProject(
    {
      id,
      title,
      why,
      progress = "",
      evidence = [],
      files = [],
      next,
      blocker,
      status,
      outcome = "",
      expectedRevision = 0,
    },
    { writtenIn, now },
  ) {
    const short = (value, max, required = false) =>
      value === undefined
        ? !required
        : typeof value === "string" &&
          value.length <= max &&
          (!required || !!value.trim());
    const old = id ? this.project(id) : null;
    if (id && !old) throw Error("RECORD_NOT_FOUND");
    if ((old?.revision || 0) !== expectedRevision)
      throw Error("REVISION_CONFLICT");
    if (
      // Required for a new project; never blanked on an update.
      !short(title, 60, !old || title !== undefined) ||
      !short(why, 300, !old || why !== undefined) ||
      !short(progress, 300) ||
      !short(next, 200) ||
      !short(blocker, 200) ||
      !short(outcome, 300) ||
      (status !== undefined && !PROJECT_STATUSES.includes(status)) ||
      !Array.isArray(files) ||
      files.length > 10 ||
      files.some((f) => typeof f !== "string" || !/^[a-f0-9]{64}$/.test(f))
    )
      throw Error("INVALID_PROJECT");
    if (old && ["done", "dropped"].includes(old.status))
      throw Error("PROJECT_CLOSED");
    const nextStatus = status ?? old?.status ?? "active";
    const closing = ["done", "dropped"].includes(nextStatus);
    if (closing && !outcome.trim()) throw Error("INVALID_PROJECT");
    if (!old && nextStatus !== "active") throw Error("INVALID_PROJECT");
    if (evidence.length) freezeEvidence(this.mem, evidence, now);
    if (
      nextStatus === "active" &&
      old?.status !== "active" &&
      this.projects().filter((p) => p.status === "active").length >=
        MAX_LIVE_PROJECTS
    )
      throw Error("PROJECT_LIMIT");
    const step = progress.trim()
      ? [
          {
            at: now,
            did: progress.trim(),
            evidence,
            files,
            writtenIn: writtenIn ?? null,
          },
        ]
      : [];
    const value = {
      id: old?.id || randomUUID(),
      title: title === undefined ? old.title : title.trim(),
      why: why === undefined ? old.why : why.trim(),
      status: nextStatus,
      steps: [...step, ...(old?.steps || [])].slice(0, PROJECT_STEPS),
      // Everything it made along the way, newest first.
      files: [...new Set([...files, ...(old?.files || [])])].slice(0, 30),
      next: next === undefined ? (old?.next ?? "") : next.trim(),
      blocker: blocker === undefined ? (old?.blocker ?? "") : blocker.trim(),
      ...(closing ? { outcome: outcome.trim(), closedAt: now } : {}),
      revision: (old?.revision || 0) + 1,
      createdIn: old?.createdIn ?? writtenIn ?? null,
      createdAt: old?.createdAt ?? now,
      updatedAt: now,
    };
    this.db
      .prepare("INSERT OR REPLACE INTO projects VALUES(?,?,?)")
      .run(this.agentId, value.id, encode(value));
    return value;
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
