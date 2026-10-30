// @ts-check
// Who is talking to whom in a group, read from @ and quote segments, so the
// model can tell a question put to someone else, or one already answered,
// from one put to the room, and see how much of the chat lately was its own.
import { references, quotedMessage } from "./person-cards.mjs";

const RECENT = 20;
const QUESTION = /[?？]/;

/**
 * @param {any} memory Bound agent memory.
 * @param {string} conversation
 * @param {any[]} items Records this turn shows the model.
 * @param {string} accountId
 */
export function floorForTurn(memory, conversation, items, accountId) {
  if (!conversation.startsWith("group:")) return null;
  const row = memory.db.prepare(
    "SELECT * FROM events WHERE agent_id=? AND id=?",
  );
  const incoming = items
    .filter((x) => x.direction === "in")
    .map((x) => row.get(memory.agentId, x.id))
    .filter(Boolean);
  const toYou = [],
    betweenOthers = [];
  /** @type {Map<string, Set<string>>} */
  const answered = new Map();
  for (const event of incoming) {
    const { mentions, replies } = references(event);
    const quoted = replies
      .map((id) => quotedMessage(memory.db, event, id))
      .filter(Boolean);
    const to = [
      ...new Set([
        ...mentions.filter((x) => x !== "all"),
        // The agent's own messages are archived without a sender.
        ...quoted
          .map((q) => (q.direction === "out" ? accountId : q.sender_id))
          .filter((x) => x != null),
      ]),
    ];
    if (to.includes(accountId)) toYou.push(event.id);
    else if (to.length) betweenOthers.push({ id: event.id, to });
    // Another member quoting a question answers it, wherever it was asked.
    for (const q of quoted)
      if (
        QUESTION.test(q.body) &&
        q.direction === "in" &&
        q.sender_id !== event.sender_id
      )
        answered.set(
          q.id,
          (answered.get(q.id) || new Set()).add(event.sender_id),
        );
  }
  const answeredByOthers = [...answered].map(([id, by]) => ({
    id,
    by: [...by],
  }));
  const recent = memory.db
    .prepare(
      "SELECT direction FROM events WHERE agent_id=? AND conversation=? AND kind IN ('message.received','message.sent') ORDER BY seq DESC LIMIT ?",
    )
    .all(memory.agentId, conversation, RECENT);
  const yours = recent.filter(
    (/** @type {any} */ x) => x.direction === "out",
  ).length;
  if (!toYou.length && !betweenOthers.length && !answeredByOthers.length)
    return yours ? { recent: { yours, of: recent.length } } : null;
  return {
    ...(toYou.length ? { toYou } : {}),
    ...(betweenOthers.length ? { betweenOthers } : {}),
    ...(answeredByOthers.length ? { answeredByOthers } : {}),
    recent: { yours, of: recent.length },
  };
}
