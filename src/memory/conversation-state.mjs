// @ts-check
// @ts-check
export const CONVERSATION_SCHEMA = 1;
/** @param {string} conversation */
export const isConversation = (conversation) =>
  /^(group|private):\d+$/.test(conversation);
/** Legacy v0 has no marker; unknown fields survive migration.
 * @param {unknown} value
 * @returns {Record<string, unknown>}
 */
export function readConversationState(value) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw Error("CONVERSATION_STATE_INVALID");
  const { _conversationSchema = 0, ...state } =
    /** @type {Record<string, unknown>} */ (value);
  if (
    typeof _conversationSchema !== "number" ||
    ![0, CONVERSATION_SCHEMA].includes(_conversationSchema)
  )
    throw Error("CONVERSATION_STATE_VERSION_UNSUPPORTED");
  return state;
}
/** @param {unknown} value */
export function writeConversationState(value) {
  return {
    ...readConversationState(value),
    _conversationSchema: CONVERSATION_SCHEMA,
  };
}
