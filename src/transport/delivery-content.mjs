// @ts-check

// Compare what QQ displays without changing the wire payload or the legacy
// request hash. Adjacent text segments have no visible boundary in QQ.
/** @param {unknown} parts */
export function deliveryContentKey(parts) {
  if (!Array.isArray(parts)) return null;
  /** @type {Array<[string,string]>} */
  const content = [];
  for (const part of parts) {
    const type = part?.type;
    if (type === "text" && typeof part.data?.text === "string") {
      const text = part.data.text;
      if (!text) continue;
      const last = content.at(-1);
      if (last?.[0] === "text") last[1] += text;
      else content.push(["text", text]);
      continue;
    }
    if (type !== "at" && type !== "reply" && type !== "face") return null;
    const value = part.data?.[type === "at" ? "qq" : "id"];
    if (typeof value !== "string") return null;
    content.push([type, value]);
  }
  return content.length ? JSON.stringify(content) : null;
}

/** @param {string} body @param {any} payload */
export function attemptedContentKey(body, payload) {
  if (
    payload.deliveryType === "action" ||
    payload.actionKind ||
    payload.mediaId ||
    payload.audioId ||
    payload.fileId ||
    payload.eventIds
  )
    return null;
  return deliveryContentKey(
    payload.segments ?? [
      ...(payload.replyTo
        ? [{ type: "reply", data: { id: payload.replyTo } }]
        : []),
      ...(payload.atUserId
        ? [{ type: "at", data: { qq: payload.atUserId } }]
        : []),
      { type: "text", data: { text: body } },
    ],
  );
}
