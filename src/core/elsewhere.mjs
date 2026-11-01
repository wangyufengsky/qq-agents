// @ts-check
import { interactionEvents, sentLedger } from "./closeness.mjs";
import { peopleInTurn, quotedSender } from "./person-cards.mjs";
import { recallBoundary } from "./recall-boundary.mjs";

const WORDS_PER_CHAT = 3;
const WORDS_PER_TURN = 8;
const EXCERPT_CHARS = 80;

/** Whom one of the agent's own messages was addressed to, only when the
 * message itself says so: an at or a reply. Never inferred from timing.
 * @param {any} memory @param {any} row @param {any} payload */
function addressees(memory, row, payload) {
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
 * @param {{fresh: boolean, now: number, lookbackMs: number}} options */
function ownWords(runtime, ctx, memory, boundary, { fresh, now, lookbackMs }) {
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
      `SELECT * FROM events WHERE ${sent} AND seq>? AND occurred_at>=? AND occurred_at<=? AND conversation<>? AND (conversation LIKE 'group:%' OR conversation LIKE 'private:%') ORDER BY seq DESC`,
    )
    .all(
      ctx.agentId,
      through,
      new Date(now - lookbackMs).toISOString(),
      new Date(now).toISOString(),
      ctx.conversation,
    );
  const items = [],
    /** @type {Record<string, number>} */ more = {},
    perChat = new Map(),
    privateChats = new Set();
  let privateMessages = 0,
    latest = through;
  for (const row of rows) {
    const payload = JSON.parse(row.payload || "{}");
    if (
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
 * @param {{fresh: boolean, now?: number, accountId: string}} options */
export function elsewhereForTurn(
  runtime,
  ctx,
  historyItems,
  { fresh, now = Date.now(), accountId },
) {
  const config = runtime.agent(ctx.agentId).behavior.elsewhere;
  if (!config.enabled || !/^(group|private):/.test(ctx.conversation))
    return null;
  const memory = runtime.memory.bind(ctx.agentId);
  const shown = fresh
    ? {}
    : { ...memory.state(ctx.conversation).elsewhereShown };
  const boundary = recallBoundary(runtime, ctx);
  const candidates = [];
  for (const personId of peopleInTurn(
    memory,
    ctx.conversation,
    historyItems,
    accountId,
  )) {
    const events = interactionEvents(memory, personId, now, accountId, {
      since: now - config.windowMs,
      allowed: (row) =>
        row.conversation !== ctx.conversation &&
        boundary.allowed(row) &&
        (row.direction !== "in" ||
          row.seq <= (memory.state(row.conversation).readThroughSeq || 0)),
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
        ctx.conversation.startsWith("group:")
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
  });
  return { items, more, shown, words };
}
