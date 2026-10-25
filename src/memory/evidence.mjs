import { createHash } from "node:crypto";
import { extractForwardIds } from "../../vendor/legacy/forward.js";
const digest = (value) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const normalize = (text) =>
  String(text || "")
    .normalize("NFKC")
    .trim()
    .replace(/\s+/g, " ");

// Immutable, agent-owned source proof. IDs remain lookup handles; they are not
// themselves a historical revision. Never recompute an accepted proof from a diary's latest edit.
export function freezeEvidence(memory, ids, now) {
  if (
    !Array.isArray(ids) ||
    ids.length > 30 ||
    ids.some((id) => typeof id !== "string")
  )
    throw Error("INVALID_EVIDENCE");
  const references = new Map(),
    roots = new Map(),
    members = new Map(),
    visiting = new Set(),
    resolved = new Map();
  function visit(id) {
    if (visiting.has(id)) return [];
    if (references.has(id)) return resolved.get(id) || [];
    if (references.size + visiting.size >= 120)
      throw Error("EVIDENCE_GRAPH_TOO_LARGE");
    visiting.add(id);
    const row = memory.db
      .prepare("SELECT * FROM events WHERE agent_id=? AND id=?")
      .get(memory.agentId, id);
    if (row) {
      const p = JSON.parse(row.payload || "{}"),
        app = p.app;
      let parents = Array.isArray(p.evidence) ? p.evidence : [];
      if (app)
        parents = [
          ...(app.evidence || []),
          ...(app.source?.eventId ? [app.source.eventId] : []),
        ];
      if (row.kind === "forward.node" && p.rootEventId)
        parents = [...parents, p.rootEventId];
      // Resolve explicit replies to the original observed message in its actual namespace.
      for (const s of p.segments || [])
        if (s.type === "reply" && s.data?.id != null) {
          const source = memory.db
            .prepare(
              "SELECT id FROM events WHERE agent_id=? AND connection_id=? AND conversation=? AND message_id=? ORDER BY seq LIMIT 1",
            )
            .get(
              memory.agentId,
              row.connection_id,
              row.conversation,
              String(s.data.id),
            );
          if (source) parents.push(source.id);
        }
      parents = [...new Set(parents)];
      const inherited = parents.flatMap((parent) => visit(parent));
      const text = app?.text ?? row.body;
      const metadata = {
        conversation: row.conversation,
        connectionId: row.connection_id,
        senderId: row.sender_id,
        occurredAt: row.occurred_at,
        kind: row.kind,
        ...(app
          ? {
              origin: app.origin,
              platform: app.platform,
              key: app.key,
              url: app.url,
              readingScope: app.readingScope,
              coverage: app.coverage,
              fetchedAt: app.fetchedAt,
              sourceMayBeTruncated: app.sourceMayBeTruncated,
              source: app.source,
            }
          : {}),
        ...(row.kind === "forward.node"
          ? { resourceId: p.resourceId, index: p.index, claimedAuthor: true }
          : {}),
      };
      references.set(id, {
        id,
        type: "event",
        digest: digest({ body: row.body, payload: p }),
        excerpt: String(text).slice(0, 2000),
        excerptTruncated: String(text).length > 2000,
        metadata,
        parents,
      });
      const forwarded = extractForwardIds(p.segments || []);
      const quoted = (p.segments || []).filter(
        (s) => s.type === "reply" && s.data?.id != null,
      );
      let key, epistemic;
      if (app?.key) {
        key = "app:" + normalize(app.key);
        epistemic = "external-source-claim";
      } else if (row.kind === "forward.node") {
        key = "forward:" + p.resourceId;
        epistemic = "forwarded-claim";
      } else if (
        row.direction === "in" &&
        row.kind === "message.received" &&
        !parents.length
      ) {
        if (forwarded.length) {
          key = "forward:" + [...forwarded].sort().join("|");
          epistemic = "forward-reference";
        } else if (quoted.length) {
          key =
            "unresolved-quote:" +
            row.connection_id +
            ":" +
            quoted
              .map((s) => String(s.data.id))
              .sort()
              .join("|");
          epistemic = "unresolved-reference";
        } else if (normalize(row.body)) {
          key = "speech:" + normalize(row.body);
          epistemic = (p.segments || []).some((s) =>
            ["json", "image", "video", "record"].includes(s.type),
          )
            ? "unexpanded-reference"
            : "observed-speech";
        }
      }
      if (key) {
        key = digest(key);
        // Forwarded excerpts and their enclosing card are one originating source.
        if (!members.has(key)) members.set(key, new Set());
        members.get(key).add(id);
        const candidate = {
          id,
          key,
          contentKey: normalize(text)
            ? digest("text:" + normalize(text))
            : undefined,
          conversation: row.conversation,
          occurredAt: row.occurred_at,
          episode:
            app?.key ||
            (forwarded.length || row.kind === "forward.node" || quoted.length
              ? key
              : `${row.conversation}:${row.occurred_at.slice(0, 10)}`),
          epistemic,
        };
        const old = roots.get(key),
          strength = (root) => (root?.epistemic === "forwarded-claim" ? 2 : 1);
        if (
          !old ||
          strength(candidate) > strength(old) ||
          (strength(candidate) === strength(old) && candidate.id < old.id)
        )
          roots.set(key, candidate);
      }
      resolved.set(id, key ? [key] : inherited);
    } else {
      const diary = memory.db
        .prepare("SELECT * FROM diaries WHERE agent_id=? AND id=?")
        .get(memory.agentId, id);
      if (!diary) throw Error("EVIDENCE_NOT_OWNED_OR_MISSING");
      const metadata = JSON.parse(diary.metadata);
      if (metadata.protectedOperations)
        throw Error("RESTRICTED_EVIDENCE_NOT_ALLOWED_IN_MIND");
      const parents = metadata.evidence || [];
      const inherited = parents.flatMap((parent) => visit(parent));
      resolved.set(id, inherited);
      references.set(id, {
        id,
        type: "diary",
        revision: diary.revision,
        digest: digest({ title: diary.title, body: diary.body, metadata }),
        excerpt: diary.body.slice(0, 2000),
        excerptTruncated: diary.body.length > 2000,
        metadata: {
          title: diary.title,
          writtenAt: diary.updated_at,
          epistemic: "subjective-interpretation",
        },
        parents,
      });
    }
    visiting.delete(id);
    return resolved.get(id) || [];
  }
  const keys = [...new Set(ids.flatMap((id) => visit(id)))],
    contentSeen = new Set(),
    independent = [],
    subsumed = new Set();
  // An expansion and the message/card it expands are one source, even if both
  // are explicit entry IDs. Keep the full ancestry in references for audit.
  function ancestors(id, seen = new Set()) {
    if (seen.has(id)) return seen;
    seen.add(id);
    for (const parent of references.get(id)?.parents || [])
      ancestors(parent, seen);
    return seen;
  }
  for (const key of keys) {
    const root = roots.get(key);
    if (["external-source-claim", "forwarded-claim"].includes(root.epistemic))
      for (const member of members.get(key) || [])
        for (const parent of references.get(member)?.parents || [])
          for (const id of ancestors(parent))
            for (const parentKey of resolved.get(id) || [])
              if (parentKey !== key) subsumed.add(parentKey);
  }
  for (const key of keys) {
    const root = roots.get(key);
    if (subsumed.has(key)) continue;
    if (root.contentKey && contentSeen.has(root.contentKey)) continue;
    if (root.contentKey) contentSeen.add(root.contentKey);
    independent.push(root);
  }
  return {
    version: 1,
    status: "frozen",
    capturedAt: now,
    entryIds: [...ids],
    references: [...references.values()],
    roots: independent,
  };
}

export function evidenceView(memory, record) {
  const snapshot = record.evidenceSnapshot;
  if (!snapshot)
    return {
      status: "legacy-unpinned",
      notice:
        "旧记录没有冻结日记版本；不把当前日记当历史依据。候选须重新提出才可采纳。",
      entryIds: record.evidence || [],
      roots: record.roots || [],
    };
  return {
    ...snapshot,
    availability: snapshot.references.map((ref) => {
      const row =
        ref.type === "diary"
          ? memory.db
              .prepare("SELECT revision FROM diaries WHERE agent_id=? AND id=?")
              .get(memory.agentId, ref.id)
          : memory.db
              .prepare("SELECT id FROM events WHERE agent_id=? AND id=?")
              .get(memory.agentId, ref.id);
      const revisionAvailable =
        ref.type !== "diary" ||
        !!memory.db
          .prepare("SELECT 1 FROM diary_revisions WHERE id=? AND revision=?")
          .get(ref.id, ref.revision);
      return {
        id: ref.id,
        available: !!row,
        revisionAvailable,
        currentRevision: row?.revision,
        changed: ref.type === "diary" && !!row && row.revision !== ref.revision,
      };
    }),
  };
}
