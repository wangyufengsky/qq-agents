// @ts-check
// A model session meets a person card once: when that person first speaks
// there, and again only after the card changes. A new session starts with
// none seen, so a card never repeats turn after turn.
const MAX_CARDS_PER_TURN = 10;
// What a session has seen: this card, at this revision.
/** @param {any} card */
const seenKey = (card) => `${card.id}:${card.revision}`;

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
  const speakers = new Set(
    items
      .filter(
        (x) =>
          x.direction === "in" &&
          /^\d{5,12}$/.test(x.senderId || "") &&
          x.senderId !== options.accountId,
      )
      .map((x) => x.senderId),
  );
  const cards = [];
  for (const id of speakers) {
    if (cards.length >= MAX_CARDS_PER_TURN) break;
    const card = memory.identity.personCard(id);
    if (!card || shown[id] === seenKey(card)) continue;
    cards.push({
      personId: card.personId,
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
