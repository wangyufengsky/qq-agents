import { timeBasis, timelineAnchor, timelineNeighbors } from "./timeline.mjs";
const messageKinds = [
  "message.received",
  "message.sent",
  "legacy.message-observation",
];
const payload = (row) => JSON.parse(row.payload || "{}");
const string = (value, max = 120) =>
  typeof value === "string" ? value.slice(0, max) : null;
export function provenance(row) {
  const p = payload(row),
    raw = p.raw || {};
  const [kind, id] = row.conversation.split(":");
  const name = kind === "group" ? string(raw.group_name) : null;
  const segments = Array.isArray(p.segments) ? p.segments : [];
  return {
    timeBasis: timeBasis(row.occurred_at, p, row.origin),
    source: {
      agentId: row.agent_id,
      kind: ["group", "private"].includes(kind) ? kind : "internal",
      id: id || null,
      conversation: row.conversation,
      connectionId: row.connection_id,
      name,
      nameObservedAt: name ? row.observed_at : null,
    },
    senderName: string(raw.sender?.card || raw.sender?.nickname) || null,
    replyToMessageIds: [
      ...new Set([
        ...(row.kind === "message.sent" && p.replyTo != null
          ? [String(p.replyTo)]
          : []),
        ...segments
          .filter((s) => s.type === "reply" && s.data?.id != null)
          .map((s) => String(s.data.id)),
      ]),
    ].slice(0, 10),
    mentions: [
      ...new Set(
        segments
          .filter((s) => s.type === "at" && s.data?.qq != null)
          .map((s) => String(s.data.qq)),
      ),
    ].slice(0, 30),
  };
}
function message(row, anchorId) {
  const p = provenance(row);
  return {
    id: row.id,
    seq: row.seq,
    messageId: row.message_id,
    senderId: row.sender_id,
    senderName: p.senderName,
    occurredAt: row.occurred_at,
    timeBasis: p.timeBasis,
    body: row.body.slice(0, 200),
    bodyTruncated: row.body.length > 200,
    matched: row.id === anchorId,
    mentions: p.mentions,
    replyTo: p.replyToMessageIds.map((messageId) => ({
      messageId,
      status: "unavailable",
    })),
  };
}
export function sceneParticipants(messages) {
  const people = new Map();
  for (const m of messages) {
    if (!m.senderId) continue;
    const p = people.get(m.senderId) || {
      id: m.senderId,
      observedNames: [],
      messageCount: 0,
    };
    if (m.senderName && !p.observedNames.includes(m.senderName))
      p.observedNames.push(m.senderName);
    p.messageCount++;
    people.set(p.id, p);
  }
  return [...people.values()];
}
export function sceneForMatch(db, agentId, anchor, { before, after, seconds }) {
  if (!messageKinds.includes(anchor.kind)) return undefined;
  const clock = timelineAnchor(db, agentId, anchor.id),
    timeKnown = !!clock;
  let more = false;
  const seen = new Set([anchor.message_id || anchor.id]);
  function adjacent(count, direction) {
    if (!count || !timeKnown) return [];
    const older = direction === "before";
    const rows = timelineNeighbors(db, clock, {
      direction,
      count: count * 3 + 1,
      seconds,
    });
    const selected = [];
    for (const row of rows) {
      const key = row.message_id || row.id;
      if (seen.has(key)) continue;
      seen.add(key);
      selected.push(row);
      if (selected.length > count) break;
    }
    more ||= selected.length > count || rows.length === count * 3 + 1;
    selected.splice(count);
    return older ? selected.reverse() : selected;
  }
  const rows = [
    ...adjacent(before, "before"),
    anchor,
    ...adjacent(after, "after"),
  ];
  const source = provenance(anchor).source;
  if (!source.name) {
    const named = rows
      .map(provenance)
      .map((x) => x.source)
      .find((x) => x.name);
    if (named)
      Object.assign(source, {
        name: named.name,
        nameObservedAt: named.nameObservedAt,
      });
  }
  const messages = rows.map((row) => message(row, anchor.id)),
    quoted = [],
    byMessage = new Map(
      messages.filter((x) => x.messageId).map((x) => [x.messageId, x]),
    );
  let lookups = 0;
  for (const m of messages)
    for (const ref of m.replyTo) {
      let target = byMessage.get(ref.messageId);
      if (!target) {
        if (++lookups > 5) {
          ref.status = "lookup-budget";
          continue;
        }
        const row = db
          .prepare(
            "SELECT * FROM events WHERE agent_id=? AND connection_id=? AND conversation=? AND message_id=? AND kind IN ('message.received','message.sent','legacy.message-observation') ORDER BY kind='message.received' DESC,seq LIMIT 1",
          )
          .get(
            agentId,
            anchor.connection_id,
            anchor.conversation,
            ref.messageId,
          );
        if (row) {
          target = message(row, anchor.id);
          quoted.push(target);
          byMessage.set(ref.messageId, target);
        }
      }
      if (target)
        Object.assign(ref, { eventId: target.id, status: "observed" });
    }
  return {
    source,
    anchorId: anchor.id,
    relationship: "temporal-neighborhood-not-a-topic",
    window: { before, after, seconds },
    timeKnown,
    participantsScope: "returned-neighborhood-only",
    participants: sceneParticipants(messages),
    messages,
    quoted,
    contextTruncated: more,
    ordering: "message-time-then-archive-order",
    timeBasis: provenance(anchor).timeBasis,
    expand: {
      tool: "conversation_read",
      aroundId: anchor.id,
      contextSeconds: seconds,
    },
  };
}
export function fitScene(item, maxChars) {
  if (!item.scene) return item;
  const copy = structuredClone(item),
    scene = copy.scene;
  while (JSON.stringify(copy).length + 3 > maxChars) {
    if (scene.quoted.length) {
      scene.quoted.pop();
      scene.quotedOmitted = true;
    } else if (scene.messages.length > 1) {
      const center = scene.messages.findIndex((x) => x.id === scene.anchorId);
      scene.messages.splice(
        center >= scene.messages.length - center - 1
          ? 0
          : scene.messages.length - 1,
        1,
      );
      scene.participants = sceneParticipants(scene.messages);
    } else break;
    scene.contextTruncated = true;
  }
  return copy;
}

// Page-local deduplication: keep stable record IDs and explicit references to
// earlier returned scenes. Never merge unrelated temporal neighborhoods.
export function deduplicateScenes(items) {
  const seen = new Map();
  return items.map((item) => {
    if (!item.scene) return item;
    const scene = structuredClone(item.scene);
    scene.sharedRecords = [];
    for (const key of ["messages", "quoted"]) {
      scene[key] = scene[key].filter((m) => {
        const previous = seen.get(m.id);
        if (previous && m.id !== scene.anchorId) {
          scene.sharedRecords.push({
            id: m.id,
            sceneAnchorId: previous,
            role: key,
          });
          return false;
        }
        seen.set(m.id, scene.anchorId);
        return true;
      });
    }
    scene.participants = sceneParticipants(scene.messages);
    scene.expandRelations = { tool: "memory_related", id: item.id };
    return { ...item, scene };
  });
}
