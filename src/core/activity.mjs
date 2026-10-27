// A role's activity timeline: one entry per model turn (a chat reply or a
// free-time turn), with what that turn actually did attached. Records are
// linked by conversation and the turn's time window; nothing is stored here.
const SUBJECT = "@subject";
const GRACE_MS = 5000;
const EVENT_KINDS = [
  "app.observation",
  "subject.log",
  "message.sent",
  "action.confirmed",
  "message.send-result",
  "external.read",
  "github.read",
];
const iso = (ms) => new Date(ms).toISOString();
const clip = (s, n) => {
  const t = String(s || "")
    .replace(/\s+/g, " ")
    .trim();
  return t.length > n ? t.slice(0, n) + "…" : t;
};
const parse = (s) => {
  try {
    return JSON.parse(s);
  } catch {
    return {};
  }
};
const isTimelineConversation = (c) =>
  c === SUBJECT || c.startsWith("group:") || c.startsWith("private:");

// Browse records of one turn, grouped by content: list items, the page read
// and its comments merge under one title instead of one row per record.
function browsing(rows) {
  const contents = new Map(),
    searches = [],
    failures = [];
  for (const row of rows) {
    const a = parse(row.payload).app || {};
    if (a.ok === false) {
      failures.push({
        platform: a.platform,
        operation: a.operation,
        error: a.error,
      });
      continue;
    }
    if (a.operation === "search" && !a.key) {
      searches.push({ platform: a.platform, query: clip(a.query, 60) });
      continue;
    }
    const key = a.key || row.id;
    const item = contents.get(key) || {
      key,
      recordId: row.id,
      platform: a.platform,
      title: "",
      url: a.url || null,
      listed: false,
      read: false,
      comments: [],
    };
    if (a.operation === "comments")
      item.comments.push({
        author: clip(a.author, 24),
        text: clip(a.text, 80),
      });
    else {
      if (a.title) item.title ||= clip(a.title, 80);
      if (a.operation === "read") {
        item.read = true;
        item.recordId = row.id;
      } else item.listed = true;
      if (a.query)
        searches.push({ platform: a.platform, query: clip(a.query, 60) });
    }
    if (!item.url && a.url) item.url = a.url;
    contents.set(key, item);
  }
  const items = [...contents.values()].map((x) => ({
    ...x,
    title: x.title || "（未取得标题的内容）",
  }));
  // Read pages first; listed-only items are the feed the turn skimmed.
  items.sort(
    (a, b) =>
      Number(b.read) - Number(a.read) || b.comments.length - a.comments.length,
  );
  const unique = [];
  for (const s of searches)
    if (!unique.some((u) => u.platform === s.platform && u.query === s.query))
      unique.push(s);
  return { items, searches: unique, failures };
}

export function activityPage(
  memory,
  agentId,
  { before, filter = "all", limit = 20, now = Date.now() } = {},
) {
  const m = memory.bind(agentId);
  const cap = Math.min(Math.max(limit, 1), 50);
  const ceiling = Number.isFinite(before) ? before : Number.MAX_SAFE_INTEGER;
  const conversationClause =
    filter === "subject"
      ? "AND json_extract(value,'$.conversation')='@subject'"
      : filter === "chat"
        ? "AND (json_extract(value,'$.conversation') LIKE 'group:%' OR json_extract(value,'$.conversation') LIKE 'private:%')"
        : "AND (json_extract(value,'$.conversation')='@subject' OR json_extract(value,'$.conversation') LIKE 'group:%' OR json_extract(value,'$.conversation') LIKE 'private:%')";
  // Browsing can only be judged after linking, so read a wider batch for it.
  const batch = filter === "browse" ? cap * 4 : cap + 1;
  const scanned = m.db
    .prepare(
      `SELECT value FROM model_turns WHERE agent_id=? AND json_extract(value,'$.startedAt')<? ${conversationClause} ORDER BY json_extract(value,'$.startedAt') DESC LIMIT ?`,
    )
    .all(agentId, ceiling, batch)
    .map((r) => parse(r.value));
  // Learner and other internal turns are not part of a role's timeline.
  const turns = scanned.filter(
    (t) =>
      t.conversation && isTimelineConversation(t.conversation) && t.startedAt,
  );
  const scanEnd =
    scanned.length === batch ? scanned.at(-1).startedAt || null : null;
  if (!turns.length) return { items: [], nextBefore: scanEnd };
  const windowOf = (t) => [t.startedAt - 1000, (t.endedAt || now) + GRACE_MS];
  const from = Math.min(...turns.map((t) => windowOf(t)[0])),
    to = Math.max(...turns.map((t) => windowOf(t)[1]));
  const events = m.db
    .prepare(
      `SELECT id,conversation,kind,status,observed_at AS at,body,payload FROM events WHERE agent_id=? AND observed_at>=? AND observed_at<=? AND kind IN (${EVENT_KINDS.map(() => "?").join(",")}) ORDER BY seq`,
    )
    .all(agentId, iso(from), iso(to), ...EVENT_KINDS);
  const diaries = m.db
    .prepare(
      "SELECT id,title,created_at AS createdAt,updated_at AS updatedAt,metadata FROM diaries WHERE agent_id=? AND updated_at>=? AND updated_at<=?",
    )
    .all(agentId, iso(from), iso(to));
  const intents = m.identity.list("intentions");
  const within = (t, at) => {
    const [a, b] = windowOf(t),
      x = typeof at === "number" ? at : Date.parse(at);
    return x >= a && x <= b;
  };
  const entries = turns.map((t) => {
    const mine = events.filter(
      (e) => e.conversation === t.conversation && within(t, e.at),
    );
    const log = mine
      .filter((e) => e.kind === "subject.log")
      .map((e) => {
        const p = parse(e.payload);
        return {
          did: p.did,
          summary: p.summary,
          found: (p.found || []).map((f) => f.title),
          next: p.next || "",
          restReason: p.restReason || null,
        };
      })
      .at(-1);
    const sent = mine
      .filter((e) => e.kind === "message.sent" || e.kind === "action.confirmed")
      .map((e) => ({
        text: clip(e.body, 120),
        action: e.kind === "action.confirmed",
      }));
    const failedSends = mine.filter(
      (e) =>
        e.kind === "message.send-result" &&
        ["failed", "unknown"].includes(e.status),
    ).length;
    const writes = diaries
      .filter((d) => within(t, d.updatedAt))
      .filter((d) => {
        // writtenIn is { conversation, connectionId } (older rows may hold a string).
        const w = parse(d.metadata).writtenIn,
          where = typeof w === "string" ? w : w?.conversation;
        return !where || where === t.conversation;
      })
      .map((d) => ({
        id: d.id,
        title: clip(d.title, 60),
        revised: d.createdAt !== d.updatedAt,
      }));
    const created = intents
      .filter((i) => i.createdIn === t.conversation && within(t, i.createdAt))
      .map((i) => ({
        topic: clip(i.topic, 60),
        target: i.target,
        status: i.status,
      }));
    const decided = intents
      .filter((i) => i.target === t.conversation)
      .flatMap((i) =>
        (i.history || [])
          .filter(
            (h) =>
              ["selected", "deferred", "cancelled", "completed"].includes(
                h.status,
              ) && within(t, h.at),
          )
          .map((h) => ({ topic: clip(i.topic, 60), status: h.status })),
      );
    const reads = mine.filter(
      (e) => e.kind === "external.read" || e.kind === "github.read",
    ).length;
    const calls = Array.isArray(t.toolCalls) ? t.toolCalls : null;
    return {
      turnId: t.id,
      conversation: t.conversation,
      kind: t.conversation === SUBJECT ? "subject" : "chat",
      reasons: t.reason || [],
      startedAt: t.startedAt,
      endedAt: t.endedAt || null,
      status: t.status,
      tools: calls && {
        total: calls.length,
        failed: calls.filter((c) => !c.ok).length,
        names: [...new Set(calls.map((c) => c.name))],
      },
      log: log || null,
      sent,
      failedSends,
      browsing: browsing(mine.filter((e) => e.kind === "app.observation")),
      externalReads: reads,
      diaries: writes,
      intents: { created, decided },
    };
  });
  const filtered =
    filter === "browse"
      ? entries.filter(
          (e) =>
            e.browsing.items.length ||
            e.browsing.searches.length ||
            e.externalReads,
        )
      : entries;
  const page = filtered.slice(0, cap);
  // Continue after the last shown entry, or past everything scanned when the
  // browse filter matched fewer entries than the page holds.
  const nextBefore = filtered.length > cap ? page.at(-1).startedAt : scanEnd;
  return { items: page, nextBefore };
}
