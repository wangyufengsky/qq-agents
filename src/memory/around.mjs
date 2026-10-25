import { timelineAnchor, timelineNeighbors, timeBasis } from "./timeline.mjs";

// Timeline cursors are intentionally separate from ledger seq / read watermarks.
export function around(
  memory,
  { aroundId, aroundCursor, contextSeconds = 600, limit, maxChars },
  current,
  budget,
) {
  const db = memory.db,
    agentId = memory.agentId;
  if (
    !Number.isInteger(contextSeconds) ||
    contextSeconds < 1 ||
    contextSeconds > 3600
  )
    throw Error("INVALID_BUDGET");
  const center = db
    .prepare("SELECT * FROM events WHERE agent_id=? AND id=?")
    .get(agentId, aroundId);
  if (!center) throw Error("RECORD_NOT_FOUND");
  const anchor = timelineAnchor(db, agentId, aroundId),
    c = aroundCursor;
  const ceiling =
    c?.ceiling ??
    db
      .prepare("SELECT COALESCE(MAX(seq),0) n FROM events WHERE agent_id=?")
      .get(agentId).n;
  if (
    c &&
    (!anchor ||
      c.anchorId !== aroundId ||
      c.anchorTime !== anchor.time_ms ||
      c.connectionId !== anchor.connection_id ||
      c.seconds !== contextSeconds ||
      !["before", "after"].includes(c.direction) ||
      !Number.isSafeInteger(c.ceiling) ||
      c.ceiling < center.seq ||
      !Number.isSafeInteger(c.time_ms) ||
      typeof c.event_id !== "string")
  )
    throw Error("INVALID_OR_STALE_TIMELINE_CURSOR");
  const query = (direction, count, cursor) =>
    timelineNeighbors(db, anchor, {
      direction,
      count,
      seconds: contextSeconds,
      ceiling,
      cursor,
    });
  let selected;
  if (!anchor) selected = [center];
  else if (c) selected = query(c.direction, limit, c);
  else {
    const before = query("before", limit),
      after = query("after", limit);
    // Budget the anchor first, then alternate nearest neighbors. Presentation
    // order is restored afterwards, so a small budget cannot drop the anchor.
    selected = [center];
    for (let i = 0; selected.length < limit && (before[i] || after[i]); i++) {
      if (before[i]) selected.push(before[i]);
      if (after[i] && selected.length < limit) selected.push(after[i]);
    }
  }
  let items = budget(
    selected.map((r) => memory.event(r, current, true)),
    maxChars,
  );
  const retained = new Set(items.map((r) => r.id));
  const rows = selected.filter((r) => retained.has(r.id));
  const clockOf = (r) => ({
    time_ms: r.time_ms ?? anchor?.time_ms,
    event_id: r.id,
  });
  const sorted = [...rows].sort(
    (a, b) =>
      clockOf(a).time_ms - clockOf(b).time_ms || a.id.localeCompare(b.id),
  );
  const cursor = (direction, row) => {
    if (!anchor || !row || !query(direction, 1, clockOf(row)).length)
      return null;
    return {
      anchorId: aroundId,
      anchorTime: anchor.time_ms,
      connectionId: anchor.connection_id,
      seconds: contextSeconds,
      ceiling,
      direction,
      ...clockOf(row),
    };
  };
  items = sorted.map((r) => items.find((i) => i.id === r.id));
  return {
    items,
    ordering: "message-time-then-id",
    timeKnown: !!anchor,
    timeBasis: timeBasis(center.occurred_at, center.payload, center.origin),
    nextAroundBefore: cursor("before", sorted[0]),
    nextAroundAfter: cursor("after", sorted.at(-1)),
    nextAfterSeq: null,
    previousBeforeSeq: null,
    readThroughSeq: null,
    markReadEligible: false,
    source: memory.event(center, current, true).source,
    truncated: items.length < selected.length,
    notice:
      "Reliable message-time neighborhood, then stable event UUID; not ledger order or proof of one topic. Observation/unknown times have no temporal neighbors. Continue with aroundId, contextSeconds and a nextAround cursor; enrichment is live, restart after time corrections. Use memory_related for explicit references and conversation/afterSeq for ledger reading; these cursors cannot mark messages read.",
  };
}
