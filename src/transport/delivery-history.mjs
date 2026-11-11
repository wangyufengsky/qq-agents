// @ts-check

const HISTORY_LIMIT = 40;

/** @param {unknown} value @returns {string} */
function id(value) {
  return typeof value === "string" ||
    (typeof value === "number" && Number.isSafeInteger(value))
    ? String(value)
    : "";
}

/** @param {any} row @param {string} accountId @param {string} groupId */
export function groupDeliveryEvidence(row, accountId, groupId) {
  if (
    row?.post_type !== "message_sent" ||
    row.message_type !== "group" ||
    id(row.self_id) !== accountId ||
    id(row.user_id) !== accountId ||
    id(row.group_id) !== groupId ||
    // NapCat's message_id is a local lookup key. real_seq is the QQ message
    // sequence, so a locally queued item alone cannot establish delivery.
    !/^[1-9]\d{0,19}$/.test(id(row.real_seq)) ||
    !/^-?[1-9]\d{0,10}$/.test(id(row.message_id)) ||
    !Array.isArray(row.message) ||
    !Number.isSafeInteger(Number(row.time)) ||
    Number(row.time) <= 0
  )
    return null;

  const parts = /** @type {any[]} */ (row.message);
  const at = Number(row.time) * 1000;
  const messageId = id(row.message_id);
  // The sender builds the message with text first, then one image.
  const image = parts.at(-1)?.type === "image" ? parts.at(-1) : null;
  const textParts = image ? parts.slice(0, -1) : parts;
  if (
    !textParts.every(
      (part) => part?.type === "text" && typeof part.data?.text === "string",
    )
  )
    return null;
  const text = textParts.map((part) => part.data.text).join("");
  if (!image) return text ? { at, messageId, text } : null;
  const file = image.data?.file;
  const match =
    typeof file === "string" &&
    /^([a-f0-9]{32})\.(?:png|jpe?g|webp|gif)$/i.exec(file);
  return match
    ? { at, messageId, text, imageMd5: match[1].toLowerCase() }
    : null;
}

/** @param {any} transport @param {string} accountId @param {string} groupId */
export async function readGroupDeliveryEvidence(transport, accountId, groupId) {
  const response = await transport.call(
    "get_group_msg_history",
    {
      group_id: groupId,
      count: HISTORY_LIMIT,
      disable_get_url: true,
      parse_mult_msg: false,
      quick_reply: true,
    },
    4000,
    { maxBytes: 512 * 1024 },
  );
  const messages = response?.messages;
  if (!Array.isArray(messages) || messages.length > HISTORY_LIMIT)
    return { items: [], after: Infinity };
  const items = messages
    .map((row) => groupDeliveryEvidence(row, accountId, groupId))
    .filter((evidence) => evidence !== null);
  const times = messages.map((row) => Number(row?.time) * 1000);
  // The oldest second in a full page may contain other matching messages
  // outside the page. Only later attempts have complete time coverage.
  const after =
    messages.length < HISTORY_LIMIT
      ? -Infinity
      : times.every((time) => Number.isSafeInteger(time) && time > 0)
        ? Math.min(...times)
        : Infinity;
  return { items, after };
}
