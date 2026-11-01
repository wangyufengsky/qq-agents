// @ts-check
import { interactionEvents } from "./closeness.mjs";
import { peopleInTurn } from "./person-cards.mjs";
import { recallBoundary } from "./recall-boundary.mjs";

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
  return { items, more, shown };
}
