// @ts-check
import { interactionEvents, sentLedger } from "./closeness.mjs";
import { peopleInTurn, quotedSender } from "./person-cards.mjs";
import { recallBoundary } from "./recall-boundary.mjs";
import {
  DESKTOP_CONVERSATION,
  desktopInputCommitted,
  isGroupConversation,
} from "../home/desktop-archive.mjs";

/** @param {ReturnType<typeof elsewhereForTurn>} elsewhere */
export function elsewhereLine(elsewhere) {
  const withThem = elsewhere?.items.length,
    words = elsewhere?.words,
    own = words && (words.items.length || words.otherPrivate);
  if (!withThem && !own) return "";
  return `别处近况（程序统计的索引，不是完整原文；要用时按 continuation 回查。items 是本轮这些人和你在别处的直接来往，fromPrivate 是对方私聊里的事，不要在群里提起内容，除非对方先提。yourWords 是你自己最近在别的群或桌面说过的话：to 只按明确的 @ 和引用判断，unclear 表示没有明确对象，不要替自己猜；truncated 的摘录只是开头，涉及答应、承诺或结论时先回查上下文再认账；otherPrivate 只告诉你在别人私聊里也说过话，内容不在这里。其他会话的经历由你结合场合判断怎么用）：${JSON.stringify(
    {
      ...(withThem
        ? {
            items: elsewhere.items,
            ...(Object.keys(elsewhere.more).length
              ? { more: elsewhere.more }
              : {}),
          }
        : {}),
      ...(own
        ? {
            yourWords: {
              items: words.items,
              ...(Object.keys(words.more).length ? { more: words.more } : {}),
              ...(words.otherPrivate
                ? { otherPrivate: words.otherPrivate }
                : {}),
            },
          }
        : {}),
    },
  )}`;
}

const WORDS_PER_CHAT = 3;
const WORDS_PER_TURN = 8;
const EXCERPT_CHARS = 80;

/** Whom one of the agent's own messages was addressed to, only when the
 * message itself says so: an at or a reply. Never inferred from timing.
 * @param {any} memory @param {any} row @param {any} payload */
function addressees(memory, row, payload) {
  if (row.conversation === DESKTOP_CONVERSATION)
    return payload.desktop?.targetQq || [];
  const to = new Set();
  if (payload.atUserId != null) to.add(String(payload.atUserId));
  for (const s of Array.isArray(payload.segments) ? payload.segments : [])
    if (s?.type === "at" && s.data?.qq != null) to.add(String(s.data.qq));
  if (payload.replyTo != null) {
    const sender = quotedSender(memory.db, row, String(payload.replyTo));
    if (sender) to.add(String(sender));
  }
  return [...to];
}

/**
 * The agent's own confirmed words in other chats that this model session has
 * not yet been told about. A session starts from the agent's last confirmed
 * message in this chat, so it hears what it said elsewhere since it last
 * spoke here; afterwards only newer words appear.
 * @param {any} runtime @param {any} ctx @param {any} memory @param {any} boundary
 * @param {{fresh: boolean, now: number, lookbackMs: number, groupsOnly: boolean}} options */
function ownWords(
  runtime,
  ctx,
  memory,
  boundary,
  { fresh, now, lookbackMs, groupsOnly },
) {
  const sent =
    "agent_id=? AND kind='message.sent' AND direction='out' AND status='confirmed'";
  let through = fresh
    ? undefined
    : memory.state(ctx.conversation).elsewhereWordsThroughSeq;
  if (!Number.isInteger(through))
    through =
      memory.db
        .prepare(
          `SELECT MAX(seq) AS seq FROM events WHERE ${sent} AND conversation=?`,
        )
        .get(ctx.agentId, ctx.conversation).seq || 0;
  const rows = memory.db
    .prepare(
      `SELECT * FROM events WHERE ${sent} AND seq>? AND occurred_at>=? AND occurred_at<=? AND conversation<>? AND (conversation=? OR conversation LIKE 'group:%' OR conversation LIKE 'private:%') ORDER BY seq DESC`,
    )
    .all(
      ctx.agentId,
      through,
      new Date(now - lookbackMs).toISOString(),
      new Date(now).toISOString(),
      ctx.conversation,
      DESKTOP_CONVERSATION,
    );
  const items = [],
    /** @type {Record<string, number>} */ more = {},
    perChat = new Map(),
    privateChats = new Set();
  let privateMessages = 0,
    latest = through;
  for (const row of rows) {
    if (
      ctx.conversation === "@subject" &&
      row.conversation !== DESKTOP_CONVERSATION
    )
      continue;
    if (groupsOnly && !isGroupConversation(row.conversation)) continue;
    const payload = JSON.parse(row.payload || "{}");
    if (
      payload.protectedSocialSources?.length ||
      payload.protectedPeerQzoneTargets?.length ||
      payload.protectedOperations ||
      payload.protectedRepositories?.length ||
      !boundary.allowed({ ...row, payload }) ||
      !sentLedger(memory, row)
    )
      continue;
    latest = Math.max(latest, row.seq);
    // Words said in someone's private chat stay there: not the text, and not
    // whose chat it was, only that some were said.
    if (row.conversation.startsWith("private:")) {
      privateMessages++;
      privateChats.add(row.conversation);
      continue;
    }
    const count = perChat.get(row.conversation) || 0;
    if (count >= WORDS_PER_CHAT || items.length >= WORDS_PER_TURN) {
      more[row.conversation] = (more[row.conversation] || 0) + 1;
      continue;
    }
    perChat.set(row.conversation, count + 1);
    const text = [...(row.body || "")];
    const to = addressees(memory, row, payload);
    items.push({
      where: row.conversation,
      at: row.occurred_at,
      to: to.length ? to : "unclear",
      excerpt: text.slice(0, EXCERPT_CHARS).join(""),
      ...(text.length > EXCERPT_CHARS ? { truncated: true } : {}),
      continuation: { tool: "memory_read", id: row.id },
      seq: row.seq,
    });
  }
  return {
    items: items.reverse().map(({ seq: _seq, ...item }) => item),
    more,
    ...(privateMessages
      ? {
          otherPrivate: {
            messages: privateMessages,
            chats: privateChats.size,
          },
        }
      : {}),
    through: latest,
  };
}

// This read-only projection never advances source chat watermarks.
/** @param {any} runtime @param {any} ctx @param {any[]} historyItems
 * @param {{fresh: boolean, now?: number, accountId: string, groupsOnly?: boolean, personIds?: string[]}} options */
export function elsewhereForTurn(
  runtime,
  ctx,
  historyItems,
  { fresh, now = Date.now(), accountId, groupsOnly = false, personIds },
) {
  const config = runtime.agent(ctx.agentId).behavior.elsewhere;
  if (
    !config?.enabled ||
    (!isGroupConversation(ctx.conversation) &&
      !ctx.conversation.startsWith("private:") &&
      ctx.conversation !== "@subject")
  )
    return null;
  const memory = runtime.memory.bind(ctx.agentId);
  const shown = fresh
    ? {}
    : { ...memory.state(ctx.conversation).elsewhereShown };
  const boundary = recallBoundary(runtime, ctx, {
    publicOnly: ctx.freshSubject === true,
  });
  const candidates = [];
  for (const personId of personIds ??
    peopleInTurn(memory, ctx.conversation, historyItems, accountId)) {
    const events = interactionEvents(memory, personId, now, accountId, {
      since: now - config.windowMs,
      allowed: (row) =>
        row.conversation !== ctx.conversation &&
        (!groupsOnly || isGroupConversation(row.conversation)) &&
        boundary.allowed(row) &&
        (row.direction !== "in" ||
          (row.conversation === DESKTOP_CONVERSATION
            ? desktopInputCommitted(memory, row)
            : row.seq <= (memory.state(row.conversation).readThroughSeq || 0))),
    });
    const latest = events.at(-1);
    if (!latest) continue;
    const previous =
      shown[personId] &&
      memory.db
        .prepare("SELECT occurred_at,seq FROM events WHERE agent_id=? AND id=?")
        .get(ctx.agentId, shown[personId]);
    if (
      previous &&
      (Date.parse(previous.occurred_at) > latest.at ||
        (Date.parse(previous.occurred_at) === latest.at &&
          previous.seq >= latest.seq))
    )
      continue;
    const chats = new Map();
    for (const event of events) {
      const list = chats.get(event.conversation) || [];
      list.push(event);
      chats.set(event.conversation, list);
    }
    for (const [conversation, list] of chats) {
      const last = list.at(-1);
      candidates.push({
        personId,
        where: conversation.startsWith("private:") ? "private" : conversation,
        lastAt: new Date(last.at).toISOString(),
        messages: list.length,
        startedBy: list[0].direction === "in" ? "them" : "you",
        lastFrom: last.direction === "in" ? "them" : "you",
        ...(conversation.startsWith("private:") &&
        isGroupConversation(ctx.conversation)
          ? { fromPrivate: true }
          : {}),
        continuation: { tool: "memory_read", id: last.id },
        latestId: latest.id,
        seq: last.seq,
      });
    }
  }
  candidates.sort((a, b) => b.lastAt.localeCompare(a.lastAt) || b.seq - a.seq);
  const counts = new Map();
  const items = [];
  /** @type {Record<string, number>} */
  const more = {};
  for (const { latestId, seq, ...item } of candidates) {
    const count = counts.get(item.personId) || 0;
    if (items.length >= 6 || count >= 2) {
      more[item.personId] = (more[item.personId] || 0) + 1;
      continue;
    }
    counts.set(item.personId, count + 1);
    items.push(item);
    if (item.continuation.id === latestId) shown[item.personId] = latestId;
  }
  const words = ownWords(runtime, ctx, memory, boundary, {
    fresh,
    now,
    lookbackMs: config.ownLookbackMs ?? 86400000,
    groupsOnly,
  });
  if (ctx.conversation === "@subject" && !words.items.length) return null;
  return { items, more, shown, words };
}
