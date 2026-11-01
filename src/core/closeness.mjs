// @ts-check
import { resolveMessage, scopeFor } from "../memory/message-ids.mjs";

export const CLOSENESS_TIERS = Object.freeze(["陌生", "认识", "熟", "很熟"]);
export const CLOSENESS_THRESHOLDS = Object.freeze([0, 4, 16, 48]);
export const CLOSENESS_DAY = 86400000;
export const CLOSENESS_CACHE_MS = CLOSENESS_DAY;
const WINDOW = 30 * CLOSENESS_DAY;
const HALF_LIFE = 14 * CLOSENESS_DAY;
const EPISODE_GAP = 6 * 3600000;

/** @typedef {{ personId: string, conversation: string, direction: string, at: number, kind: string, status?: string, sent?: boolean, messageKey?: string }} Interaction */
/** Calculate only from archived, explicitly directed speech, without mutating it.
 * @param {Interaction[]} events @param {string} personId @param {number} now */
export function closeness(events, personId, now) {
  let rounds = 0,
    incomingOpenings = 0,
    respondedOpenings = 0;
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
    const weight = 2 ** (-(now - event.at) / HALF_LIFE);
    const previous = chats.get(event.conversation);
    if (!previous || event.at - previous.at >= EPISODE_GAP) {
      if (event.direction === "in") incomingOpenings += weight;
      chats.set(event.conversation, {
        at: event.at,
        direction: event.direction,
        opener: event.direction,
        responded: false,
      });
      continue;
    }
    if (event.direction !== previous.direction) {
      rounds += weight;
      if (
        previous.opener === "out" &&
        !previous.responded &&
        event.direction === "in"
      ) {
        respondedOpenings += weight;
        previous.responded = true;
      }
    }
    previous.at = event.at;
    previous.direction = event.direction;
  }
  // Unanswered one-sided chatter cannot create familiarity by itself.
  const score =
    rounds +
    Math.min(rounds, incomingOpenings * 0.5) +
    Math.min(rounds, respondedOpenings * 0.5);
  let level = 0;
  for (let index = 1; index < CLOSENESS_THRESHOLDS.length; index++)
    if (score >= CLOSENESS_THRESHOLDS[index]) level = index;
  return {
    tier: CLOSENESS_TIERS[level],
    at: now,
    score,
    rounds,
    incomingOpenings,
    respondedOpenings,
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
export function closenessEvents(memory, personId, now, accountId) {
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

/** Cache only a derived tier, scoped to this role's own card and current account.
 * @param {any} memory @param {string} personId @param {number} now @param {string} accountId */
export function personCloseness(memory, personId, now, accountId) {
  const row = memory.db
    .prepare("SELECT value FROM person_notes WHERE agent_id=? AND person_id=?")
    .get(memory.agentId, personId);
  const card = row ? JSON.parse(row.value) : null;
  const cached = card?.closeness;
  if (CLOSENESS_TIERS.includes(cached?.override))
    return {
      tier: cached.override,
      override: cached.override,
      at: now,
      overridden: true,
    };
  if (
    CLOSENESS_TIERS.includes(cached?.tier) &&
    cached.accountId === accountId &&
    Number.isFinite(cached.at) &&
    now >= cached.at &&
    now - cached.at < CLOSENESS_CACHE_MS
  )
    return { tier: cached.tier, at: cached.at, overridden: false };
  const computed = closeness(
    closenessEvents(memory, personId, now, accountId),
    personId,
    now,
  );
  if (card) {
    card.closeness = { tier: computed.tier, at: now, accountId };
    memory.db
      .prepare(
        "UPDATE person_notes SET value=? WHERE agent_id=? AND person_id=?",
      )
      .run(JSON.stringify(card), memory.agentId, personId);
  }
  return { tier: computed.tier, at: now, overridden: false };
}

/** Derived caches are disposable; administrator overrides are durable intent.
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

/** @param {any[]} targets */
export function rankReachTargets(targets) {
  return targets
    .map((target, index) => ({ target, index }))
    .sort(
      (a, b) =>
        Math.max(0, CLOSENESS_TIERS.indexOf(b.target.closeness?.tier)) -
          Math.max(0, CLOSENESS_TIERS.indexOf(a.target.closeness?.tier)) ||
        (Date.parse(a.target.lastSaidAt || "") || 0) -
          (Date.parse(b.target.lastSaidAt || "") || 0) ||
        a.index - b.index,
    )
    .map(({ target }) => target);
}
