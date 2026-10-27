import { APP_CAPABILITIES } from "../apps/adapter.mjs";
import { APP_LEDGER, inAppHours } from "../apps/policy.mjs";
import { githubMarker } from "../github/policy.mjs";
import { trackMindRecords } from "./protected-mind.mjs";

const SUBJECT = "@subject";
const DAY = 86400000;

// What a free-time turn starts from: its own recent log, what happened lately,
// where it can explore with how much budget left, and how earlier shares went.
// Only AI-authored titles and counts are included, never chat text.
export function subjectMaterials(runtime, ctx) {
  const a = runtime.agent(ctx.agentId),
    m = runtime.memory.bind(a.id),
    now = runtime.now();
  const logs = m.db
    .prepare(
      "SELECT id,observed_at AS at,payload FROM events WHERE agent_id=? AND conversation=? AND kind='subject.log' ORDER BY seq DESC LIMIT 3",
    )
    .all(a.id, SUBJECT)
    .map((row) => {
      const p = JSON.parse(row.payload);
      return {
        id: row.id,
        at: row.at,
        did: p.did,
        summary: p.summary,
        found: (p.found || []).map((f) => f.title),
        next: p.next || "",
        ...(p.restReason ? { restReason: p.restReason } : {}),
        protectedRepositories: p.protectedRepositories,
        protectedOperations: p.protectedOperations,
      };
    });
  // Recent rows bound the scan; counts per conversation, no message bodies.
  const floor =
    (m.db
      .prepare("SELECT MAX(seq) AS seq FROM events WHERE agent_id=?")
      .get(a.id).seq || 0) - 5000;
  const since = new Date(now - DAY).toISOString();
  const conversations = m.db
    .prepare(
      "SELECT conversation, COUNT(*) AS messages, MAX(observed_at) AS lastAt FROM events WHERE agent_id=? AND seq>? AND direction='in' AND kind='message.received' AND observed_at>? GROUP BY conversation ORDER BY messages DESC LIMIT 6",
    )
    .all(a.id, floor, since);
  const cursor = m.state(SUBJECT).activityCursor || 0;
  const inbox = m.db
    .prepare(
      "SELECT conversation, COUNT(*) AS unread FROM events WHERE agent_id=? AND direction='in' AND seq>? GROUP BY conversation ORDER BY unread DESC LIMIT 6",
    )
    .all(a.id, cursor);
  const diaries = m.db
    .prepare(
      "SELECT id,title,updated_at AS updatedAt FROM diaries WHERE agent_id=? ORDER BY updated_at DESC LIMIT 3",
    )
    .all(a.id);
  const shares = m.identity
    .list("intentions")
    .slice(0, 5)
    .map((i) => ({
      id: i.id,
      topic: i.topic,
      target: i.target,
      status: i.status,
      last: i.history?.at(-1)?.reason || null,
      protectedRepositories: i.protectedRepositories,
      protectedOperations: i.protectedOperations,
    }));
  const reads = (m.state(APP_LEDGER).calls || []).filter(
    (t) => t > now - DAY,
  ).length;
  const appsOpen =
    a.apps.enabled && inAppHours(a.apps, runtime.clock(), { requested: false });
  const platforms = a.apps.enabled
    ? a.apps.platforms
        .filter((p) => APP_CAPABILITIES[p])
        .map((p) => ({
          platform: p,
          entries: Object.keys(APP_CAPABILITIES[p].browse || {}),
          search: !!APP_CAPABILITIES[p].search,
        }))
    : [];
  // Everything shown here becomes part of what the turn has read.
  trackMindRecords(runtime, ctx, logs, "subject-log");
  trackMindRecords(runtime, ctx, shares, "intent");
  for (const d of diaries) ctx.privateRead.add(d.id);
  for (const repo of logs.flatMap((l) => l.protectedRepositories || []))
    ctx.privateRead.add(githubMarker(repo));
  ctx.persistTaint?.();
  const strip = ({ protectedRepositories, protectedOperations, ...rest }) => ({
    ...rest,
    ...(protectedRepositories?.length || protectedOperations
      ? { protected: true }
      : {}),
  });
  return {
    lastLogs: logs.map(strip),
    recent: {
      conversations,
      diaryTitles: diaries.map((d) => ({ title: d.title, at: d.updatedAt })),
    },
    inbox,
    explore: {
      platforms,
      appsOpenNow: appsOpen,
      readsLeftToday: Math.max(0, a.apps.maxReadsPerDay - reads),
      readsPerTurn: a.apps.maxReadsPerTurn,
      webSearch: a.network?.autonomous
        ? a.subject.externalReads.map((x) => `${x.serverId}/${x.tool}`)
        : [],
      toolCallsThisTurn: a.subject.maxToolCallsPerTurn,
    },
    shares: shares.map(strip),
  };
}
