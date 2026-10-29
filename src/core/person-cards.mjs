// @ts-check
// A model session meets a person card once: when that person first comes up
// there, and again only after the card changes. A new session starts with
// none seen, so a card never repeats turn after turn.
import { resolveMessage, scopeFor } from "../memory/message-ids.mjs";

const MAX_CARDS_PER_TURN = 10;
const QQ = /^\d{5,12}$/;
// What the transport writes into the body for at and reply segments; read
// only when an archived message kept no segments.
const MENTION = /\[提及 QQ:(\d{5,12})\]/g;
const QUOTE = /\[引用:([^\]\s]{1,128})\]/g;
// What a session has seen: this card, at this revision.
/** @param {any} card */
const seenKey = (card) => `${card.id}:${card.revision}`;

/** @param {any} event An archived events row. */
function references(event) {
  const segments = JSON.parse(event.payload || "{}").segments;
  if (!Array.isArray(segments))
    return {
      mentions: [...event.body.matchAll(MENTION)].map((x) => x[1]),
      replies: [...event.body.matchAll(QUOTE)].map((x) => x[1]),
    };
  const of = (/** @type {string} */ type, /** @type {string} */ key) =>
    segments
      .filter((s) => s?.type === type && s.data?.[key] != null)
      .map((s) => String(s.data[key]));
  return { mentions: of("at", "qq"), replies: of("reply", "id") };
}

// Who wrote the quoted message, when this source knows it exactly; a reply to
// something never archived, or to an id two messages share, names no one.
/** @param {any} db @param {any} event @param {string} messageId */
function quotedSender(db, event, messageId) {
  try {
    return resolveMessage(db, scopeFor(event), messageId)?.sender_id;
  } catch (error) {
    if (error instanceof Error && error.message === "AMBIGUOUS_MESSAGE_ID")
      return undefined;
    throw error;
  }
}

// Who this turn is about, in order: who spoke in the new messages, the other
// side of a private chat (even with nothing new, as when an intent or a timer
// opens the conversation), then whom those messages mention or reply to.
/** @param {any} memory @param {string} conversation @param {any[]} items @param {string} accountId */
function peopleInTurn(memory, conversation, items, accountId) {
  const incoming = items.filter((x) => x.direction === "in");
  const people = new Set(incoming.map((x) => x.senderId));
  people.add(/^private:(\d+)$/.exec(conversation)?.[1]);
  const row = memory.db.prepare(
    "SELECT * FROM events WHERE agent_id=? AND id=?",
  );
  for (const item of incoming) {
    const event = row.get(memory.agentId, item.id);
    if (!event) continue;
    const { mentions, replies } = references(event);
    for (const id of mentions) people.add(id);
    for (const id of replies) people.add(quotedSender(memory.db, event, id));
  }
  return [...people].filter((id) => QQ.test(id || "") && id !== accountId);
}

// The name this QQ last showed, so the model can tell whom a card is about.
/** @param {any} memory @param {string} id */
function lastName(memory, id) {
  const row = memory.db
    .prepare("SELECT names FROM people WHERE agent_id=? AND qq=?")
    .get(memory.agentId, id);
  return row ? JSON.parse(row.names).at(-1) : undefined;
}

/**
 * @param {any} memory Bound agent memory.
 * @param {string} conversation
 * @param {any[]} items Records this turn shows the model.
 * @param {{fresh: boolean, accountId: string}} options
 */
export function personCardsForTurn(memory, conversation, items, options) {
  const shown = options.fresh
    ? {}
    : { ...memory.state(conversation).personCardsShown };
  const cards = [];
  for (const id of peopleInTurn(
    memory,
    conversation,
    items,
    options.accountId,
  )) {
    if (cards.length >= MAX_CARDS_PER_TURN) break;
    const card = memory.identity.personCard(id);
    if (!card || shown[id] === seenKey(card)) continue;
    const nickname = lastName(memory, id);
    cards.push({
      personId: card.personId,
      ...(nickname ? { nickname } : {}),
      call: card.call,
      impression: card.body,
      revision: card.revision,
      updatedAt: card.updatedAt,
      ...(card.author === "admin" ? { editedBy: "admin" } : {}),
    });
    shown[id] = seenKey(card);
  }
  return { cards, shown };
}

/** A card the agent just wrote is already known to this session. @param {any} memory @param {string} conversation @param {any} card */
export function markPersonCardShown(memory, conversation, card) {
  const state = memory.state(conversation);
  memory.setState(conversation, {
    ...state,
    personCardsShown: {
      ...state.personCardsShown,
      [card.personId]: seenKey(card),
    },
  });
}
