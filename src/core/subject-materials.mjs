import { APP_CAPABILITIES } from "../apps/adapter.mjs";
import { APP_LEDGER, inAppHours } from "../apps/policy.mjs";
import { githubMarker } from "../github/policy.mjs";
import { contextProtection, trackMindRecords } from "./protected-mind.mjs";
import { recallBoundary } from "./recall-boundary.mjs";

const SUBJECT = "@subject";
const DAY = 86400000;
const IMPRESSION_CHARS = 80;
const NOTE_CHARS = 120;
const OPEN_NOTES = 8;

const clip = (text, max) => {
  const chars = Array.from(text);
  return chars.length > max ? chars.slice(0, max).join("") + "…" : text;
};

// Enough of a private target's own card to decide whether to reach out; the
// chat it hands off to shows the whole card. Cards hold no protected material,
// and reading one here does not count as that chat having seen it.
function cardBrief(memory, target) {
  const id = /^private:(\d+)$/.exec(target)?.[1];
  const card = id && memory.identity.personCard(id);
  if (!card) return {};
  return { call: card.call, impression: clip(card.body, IMPRESSION_CHARS) };
}

// Enough of a chat's open note to remember it and pick it up from there. The
// evidence IDs are what an intent can cite: a note ID is not evidence.
const noteBrief = (note) => ({
  id: note.id,
  conversation: note.conversation,
  body: clip(note.body, NOTE_CHARS),
  ...(note.uncertainty
    ? { uncertainty: clip(note.uncertainty, NOTE_CHARS) }
    : {}),
  evidence: note.evidence,
  updatedAt: new Date(note.writtenAt).toISOString(),
});

// What a free-time turn starts from: its own recent log, what happened lately,
// what chats left open, who it may reach out to, where it can explore with how
// much budget left, and how earlier shares went. Only AI-authored titles,
// notes, counts and times are included, never chat text.
export function subjectMaterials(runtime, ctx) {
  const a = runtime.agent(ctx.agentId),
    m = runtime.memory.bind(a.id),
    now = runtime.now();
  const boundary = recallBoundary(runtime, ctx, {
    publicOnly: ctx.freshSubject === true,
  });
  const logs = boundary.rows(
    m.db
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
      }),
  );
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
  const diaries = boundary.rows(
    m.db
      .prepare(
        "SELECT id,title,updated_at AS updatedAt FROM diaries WHERE agent_id=? ORDER BY updated_at DESC LIMIT 3",
      )
      .all(a.id),
  );
  // Protected notes are left out before the limit, so they take no place.
  const allNotes = m.identity.openNotes(),
    visibleNotes = boundary.rows(allNotes),
    notes = visibleNotes.slice(0, OPEN_NOTES);
  const shares = boundary
    .rows(m.identity.list("intentions"))
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
  const subject = m.state(SUBJECT),
    contactsToday = (subject.contacts || []).filter((t) => t > now - DAY),
    iso = (t) => (t > now ? new Date(t).toISOString() : undefined),
    lastAt = m.db.prepare(
      "SELECT observed_at AS at FROM events WHERE agent_id=? AND conversation=? AND kind=? ORDER BY seq DESC LIMIT 1",
    );
  const reach = {
    contactsLeftToday: Math.max(
      0,
      a.subject.maxContactsPerDay - contactsToday.length,
    ),
    nextContactAt: iso(
      (subject.lastContactAt || 0) + a.subject.contactCooldownMs,
    ),
    targets: runtime.subject.reachableTargets(a).map((x) => ({
      ...x,
      ...cardBrief(m, x.target),
      lastHeardAt: lastAt.get(a.id, x.target, "message.received")?.at || null,
      lastSaidAt: lastAt.get(a.id, x.target, "message.sent")?.at || null,
      cooldownUntil: iso(m.state(x.target).proactiveCooldownUntil || 0),
    })),
  };
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
  trackMindRecords(runtime, ctx, notes);
  for (const d of diaries) ctx.privateRead.add(d.id);
  for (const repo of logs.flatMap((l) => l.protectedRepositories || []))
    ctx.privateRead.add(githubMarker(repo));
  ctx.persistTaint?.();
  const withheldNotes = allNotes.length - visibleNotes.length;
  const openNotes = {
    notice:
      "各聊天还没完成的工作笔记，最近更新的在前。笔记归记下它的聊天，只有那个聊天能更新或结束它，空闲时间只看不改。想就某条去找对方，用 intent_create：evidence 填这条笔记的 evidence（笔记 id 本身不能当 evidence），background 里写上笔记 id，方便那个聊天对上。" +
      (withheldNotes
        ? "protectedNotListed 条带保护标记的笔记没有列出，不要推测内容。"
        : ""),
    items: notes.map(noteBrief),
    ...(visibleNotes.length > notes.length
      ? { more: visibleNotes.length - notes.length }
      : {}),
    ...(withheldNotes ? { protectedNotListed: withheldNotes } : {}),
  };
  const protection = contextProtection(runtime, ctx);
  const restricted =
    protection.protectedOperations ||
    protection.protectedRepositories.length > 0;
  const strip = ({ protectedRepositories, protectedOperations, ...rest }) => ({
    ...rest,
    ...(protectedRepositories?.length || protectedOperations
      ? { protected: true }
      : {}),
  });
  return {
    notice: ctx.freshSubject
      ? "本轮是新的空闲上下文，自动素材和交接已隔离受保护内容；原始记录仍保留。主动读取受保护记忆会限制本轮外网调用。旧日志中的权限判断不是当前授权，请以当前工具配置、参数 schema 和 contextGate 为准。"
      : "当前上下文已读来源继续生效；历史平台探测成功不代表当前上下文有联网权限。",
    lastLogs: logs.map(strip),
    recent: {
      conversations,
      diaryTitles: diaries.map((d) => ({ title: d.title, at: d.updatedAt })),
    },
    inbox,
    reach,
    explore: {
      platforms,
      appsOpenNow: appsOpen,
      fixedPublicReadsOnly: restricted,
      restrictedContext: restricted,
      readsLeftToday: Math.max(0, a.apps.maxReadsPerDay - reads),
      readsPerTurn: a.apps.maxReadsPerTurn,
      webSearch:
        a.network?.autonomous && !restricted
          ? a.subject.externalReads.map((x) => `${x.serverId}/${x.tool}`)
          : [],
      toolCallsThisTurn: a.subject.maxToolCallsPerTurn,
    },
    ...(allNotes.length ? { openNotes } : {}),
    shares: shares.map(strip),
  };
}
