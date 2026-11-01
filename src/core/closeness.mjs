// @ts-check
// The program counts directed contact; it does not judge a relationship.
// How close someone is, and how casually to speak, is the agent's own reading
// of the conversations and its person card. Only an administrator may state a
// closeness, and that statement is shown as the administrator's.
import { resolveMessage, scopeFor } from "../memory/message-ids.mjs";

// Values an administrator may set on a card. Never derived by the program.
export const CLOSENESS_TIERS = Object.freeze(["陌生", "认识", "熟", "很熟"]);
export const INTERACTION_DAY = 86400000;
export const INTERACTION_WINDOW_DAYS = 30;
const WINDOW = INTERACTION_WINDOW_DAYS * INTERACTION_DAY;
const EPISODE_GAP = 6 * 3600000;
// A projection is recomputed at most this often per role, person and account.
// It is kept in memory only: reading a card never writes it back.
export const INTERACTION_CACHE_MS = 10 * 60000;
const CACHE_LIMIT = 500;

/** @typedef {{ personId: string, conversation: string, direction: string, at: number, kind: string, status?: string, sent?: boolean, messageKey?: string }} Interaction */
/** Plain counts from archived, explicitly directed speech; no weighting, no tiers.
 * @param {Interaction[]} events @param {string} personId @param {number} now */
export function interactionFacts(events, personId, now) {
  let exchanges = 0,
    theyStarted = 0,
    youStarted = 0,
    youStartedAnswered = 0,
    /** @type {number | null} */
    last = null;
  /** @type {Map<string, {at:number,direction:string,opener:string,responded:boolean}>} */
  const chats = new Map();
  const seenMessages = new Set();
  for (const event of events
    .filter(
      (e) =>
        e.personId === personId &&
        Number.isFinite(e.at) &&
        e.at >= now - WINDOW &&
        e.at <= now &&
        ((e.kind === "message.received" && e.direction === "in") ||
          (e.kind === "message.sent" &&
            e.direction === "out" &&
            e.status === "confirmed" &&
            e.sent === true)),
    )
    .sort((a, b) => a.at - b.at)) {
    if (event.messageKey && seenMessages.has(event.messageKey)) continue;
    if (event.messageKey) seenMessages.add(event.messageKey);
    last = event.at;
    const previous = chats.get(event.conversation);
    if (!previous || event.at - previous.at >= EPISODE_GAP) {
      if (event.direction === "in") theyStarted++;
      else youStarted++;
      chats.set(event.conversation, {
        at: event.at,
        direction: event.direction,
        opener: event.direction,
        responded: false,
      });
      continue;
    }
    if (event.direction !== previous.direction) {
      exchanges++;
      if (
        previous.opener === "out" &&
        !previous.responded &&
        event.direction === "in"
      ) {
        youStartedAnswered++;
        previous.responded = true;
      }
    }
    previous.at = event.at;
    previous.direction = event.direction;
  }
  return {
    windowDays: INTERACTION_WINDOW_DAYS,
    exchanges,
    theyStarted,
    youStarted,
    youStartedAnswered,
    lastDirectAt: last === null ? null : new Date(last).toISOString(),
  };
}

/** @param {any} memory @param {any} row */
function sentLedger(memory, row) {
  if (
    row?.kind !== "message.sent" ||
    row.direction !== "out" ||
    row.status !== "confirmed" ||
    !row.message_id
  )
    return false;
  const id = JSON.parse(row.payload || "{}").requestId;
  if (typeof id !== "string") return false;
  const receipt = memory.delivery(id);
  return (
    receipt?.status === "sent" &&
    receipt.conversation === row.conversation &&
    receipt.message_id === row.message_id
  );
}
/** @param {any} memory @param {any} row @param {string} id */
function quoted(memory, row, id) {
  try {
    return resolveMessage(memory.db, scopeFor(row), id);
  } catch (error) {
    if (error instanceof Error && error.message === "AMBIGUOUS_MESSAGE_ID")
      return null;
    throw error;
  }
}

/** Normalize actual directed contacts; merely sharing a group is insufficient.
 * @param {any} memory @param {string} personId @param {number} now @param {string} accountId
 * @returns {Interaction[]} */
export function interactionEvents(memory, personId, now, accountId) {
  const rows = memory.db
    .prepare(
      "SELECT * FROM events WHERE agent_id=? AND occurred_at>=? AND occurred_at<=? AND kind IN ('message.received','message.sent') AND (sender_id=? OR direction='out') AND (conversation=? OR conversation LIKE 'group:%') ORDER BY occurred_at,seq",
    )
    .iterate(
      memory.agentId,
      new Date(now - WINDOW).toISOString(),
      new Date(now).toISOString(),
      personId,
      "private:" + personId,
    );
  const result = [];
  const seen = new Set();
  for (const row of rows) {
    const p = JSON.parse(row.payload || "{}");
    if (p.protectedOperations || p.protectedRepositories?.length) continue;
    const incoming =
      row.kind === "message.received" &&
      row.direction === "in" &&
      row.sender_id === personId;
    // The agent owns its confirmed ledger across connection/account changes.
    const outgoing = sentLedger(memory, row);
    if (!incoming && !outgoing) continue;
    let directed = row.conversation === "private:" + personId;
    if (row.conversation.startsWith("group:")) {
      const segments = Array.isArray(p.segments) ? p.segments : [];
      const observedAccount = String(
        p.raw?.self_id || p.accountId || accountId,
      );
      const target = incoming ? observedAccount : personId;
      directed =
        (!incoming && String(p.atUserId || "") === target) ||
        segments.some(
          (/** @type {any} */ s) =>
            s.type === "at" && String(s.data?.qq || "") === target,
        );
      const replies = [
        ...segments
          .filter((/** @type {any} */ s) => s.type === "reply")
          .map((/** @type {any} */ s) => s.data?.id),
        ...(!incoming && p.replyTo != null ? [p.replyTo] : []),
      ];
      directed ||= replies.some((id) => {
        if (id == null) return false;
        const original = quoted(memory, row, String(id));
        if (!original) return false;
        const source = JSON.parse(original.payload || "{}");
        if (source.protectedOperations || source.protectedRepositories?.length)
          return false;
        return incoming
          ? sentLedger(memory, original)
          : original?.sender_id === personId &&
              original.kind === "message.received" &&
              original.direction === "in";
      });
    }
    if (!directed) continue;
    const identities = memory.db
      .prepare(
        "SELECT namespace,message_id FROM message_identities WHERE agent_id=? AND event_id=? UNION SELECT namespace,message_id FROM message_aliases WHERE agent_id=? AND event_id=?",
      )
      .all(memory.agentId, row.id, memory.agentId, row.id);
    const keys = identities.map((/** @type {any} */ i) =>
      JSON.stringify([
        row.connection_id,
        row.conversation,
        i.namespace,
        i.message_id,
      ]),
    );
    if (outgoing) keys.push("send:" + p.requestId);
    if (!keys.length) keys.push("event:" + row.id);
    if (keys.some((/** @type {string} */ key) => seen.has(key))) continue;
    for (const key of keys) seen.add(key);
    result.push({
      messageKey: keys[0],
      personId,
      conversation: row.conversation,
      direction: incoming ? "in" : "out",
      kind: row.kind,
      status: row.status,
      sent: outgoing,
      at: Date.parse(row.occurred_at),
    });
  }
  return result;
}

/** @type {WeakMap<object, Map<string, {at: number, facts: any}>>} */
const caches = new WeakMap();

/** Facts about directed contact with one person, cached briefly in memory.
 * @param {any} memory @param {string} personId @param {number} now @param {string} accountId */
export function personInteraction(memory, personId, now, accountId) {
  let cache = caches.get(memory.db);
  if (!cache) caches.set(memory.db, (cache = new Map()));
  const key = JSON.stringify([memory.agentId, personId, accountId]);
  const hit = cache.get(key);
  if (hit && now >= hit.at && now - hit.at < INTERACTION_CACHE_MS)
    return hit.facts;
  const facts = interactionFacts(
    interactionEvents(memory, personId, now, accountId),
    personId,
    now,
  );
  cache.delete(key);
  cache.set(key, { at: now, facts });
  // Insertion order makes the first key the least recently computed.
  if (cache.size > CACHE_LIMIT)
    cache.delete(/** @type {string} */ (cache.keys().next().value));
  return facts;
}

/** The administrator's statement, if any. Legacy derived tiers are ignored.
 * @param {any} card */
export function adminCloseness(card) {
  const value = card?.closeness?.override;
  return CLOSENESS_TIERS.includes(value) ? value : undefined;
}

/** A card as the agent or console sees it: stored legacy caches never leave,
 * contact facts and an administrator's statement are attached separately.
 * @param {any} memory @param {any} card @param {number} now @param {string} accountId */
export function withInteraction(memory, card, now, accountId) {
  const { closeness: _, ...rest } = card;
  const admin = adminCloseness(card);
  return {
    ...rest,
    interaction: personInteraction(memory, card.personId, now, accountId),
    ...(admin ? { adminCloseness: admin } : {}),
  };
}

/** Derived caches from earlier versions are disposable; administrator
 * statements are durable intent.
 * @param {any} card @returns {any} */
export function withoutClosenessCache(card) {
  const result = { ...card };
  if (result.closeness) {
    if (CLOSENESS_TIERS.includes(result.closeness.override))
      result.closeness = { override: result.closeness.override };
    else delete result.closeness;
  }
  if (Array.isArray(result.history))
    result.history = result.history.map(withoutClosenessCache);
  return result;
}
