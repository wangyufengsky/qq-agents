import { createHash } from "node:crypto";
import { canonical } from "../backends/session-contract.mjs";
export const digest = (value) =>
  createHash("sha256")
    .update(
      typeof value === "string" || Buffer.isBuffer(value)
        ? value
        : JSON.stringify(canonical(value)),
    )
    .digest("hex");
const present = (x) => x !== undefined && x !== null && x !== "";
export function originalTime(value) {
  if (!present(value)) return null;
  const v =
    typeof value === "number" ? (value < 1e12 ? value * 1000 : value) : value;
  if (
    typeof v !== "number" &&
    (typeof v !== "string" ||
      !/^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(v))
  )
    throw Error("INVALID_OR_AMBIGUOUS_TIME");
  const d = new Date(v);
  if (!Number.isFinite(d.getTime())) throw Error("INVALID_TIME");
  return d.toISOString();
}
function id(value) {
  if (!present(value)) return null;
  if (typeof value === "number" && !Number.isSafeInteger(value))
    throw Error("UNSAFE_IDENTIFIER");
  if (!["number", "string"].includes(typeof value))
    throw Error("INVALID_IDENTIFIER");
  return String(value);
}
function conversation(value) {
  if (typeof value !== "string" || !/^(group|private):\d+$/.test(value))
    throw Error("INVALID_CONVERSATION");
  return value;
}
function validateSegments(value) {
  if (value === undefined) return [];
  if (
    !Array.isArray(value) ||
    value.some(
      (s) =>
        !s ||
        typeof s.type !== "string" ||
        !s.data ||
        typeof s.data !== "object",
    )
  )
    throw Error("INVALID_SEGMENTS");
  return value;
}
function exportSegments(value) {
  if (!Array.isArray(value)) throw Error("INVALID_EXPORT_SEGMENTS");
  return value.map((segment) => {
    if (!segment || typeof segment.type !== "string")
      throw Error("INVALID_EXPORT_SEGMENT");
    const { type, ...original } = segment;
    if (type === "text") {
      if (typeof original.text !== "string")
        throw Error("INVALID_EXPORT_TEXT_SEGMENT");
      return { type, data: { text: original.text } };
    }
    if (type === "at") return { type, data: { qq: id(original.qq) } };
    if (type === "reply")
      return { type, data: { id: id(original.message_id) } };
    if (typeof original.attachment_exported !== "boolean")
      throw Error("INVALID_EXPORT_ATTACHMENT");
    return { type, data: original };
  });
}
function direction(isSelf, value, sender, account) {
  if (isSelf !== undefined && typeof isSelf !== "boolean")
    throw Error("INVALID_SELF_FLAG");
  if (value !== undefined && !["in", "out", "unknown"].includes(value))
    throw Error("INVALID_DIRECTION");
  const observed = isSelf === undefined ? "unknown" : isSelf ? "out" : "in";
  if (
    value &&
    value !== "unknown" &&
    observed !== "unknown" &&
    value !== observed
  )
    throw Error("CONTRADICTORY_DIRECTION");
  const result = value && value !== "unknown" ? value : observed;
  if (
    sender &&
    account &&
    result !== "unknown" &&
    (sender === account) !== (result === "out")
  )
    throw Error("CONTRADICTORY_SUBJECT");
  return result;
}
// An explicit adapter, not a recursive search of arbitrary JSON/model transcripts.
export function adaptMessage(row, format, binding, source) {
  if (!row || typeof row !== "object" || Array.isArray(row))
    throw Error("INVALID_RECORD");
  let event, metadata;
  if (format === "qq-export-v1") {
    if (row.schema_version !== 1) throw Error("UNSUPPORTED_EXPORT_SCHEMA");
    const account = id(row.robot_qq),
      mapped = binding.subjectMap?.[account];
    if (!account || !mapped || !mapped.agentId) throw Error("UNMAPPED_SUBJECT");
    if (
      typeof row.robot !== "string" ||
      (mapped.robot && row.robot !== mapped.robot)
    )
      throw Error("CONTRADICTORY_ROBOT_NAME");
    if (
      ![
        "qq_message_database",
        "bridge_cache",
        "historical_message_snapshot",
        "confirmed_send_receipt",
      ].includes(row.source)
    )
      throw Error("UNSUPPORTED_EXPORT_SOURCE");
    if (row.observed_by !== undefined)
      throw Error("MERGED_VIEW_NOT_AN_ORIGINAL_PERSPECTIVE");
    if (
      typeof row.text !== "string" ||
      typeof row.is_self !== "boolean" ||
      typeof row.possible_text_truncation !== "boolean"
    )
      throw Error("INCOMPLETE_EXPORT_RECORD");
    const iso = originalTime(row.timestamp),
      unix = originalTime(row.unix_time);
    if (iso && unix && iso !== unix) throw Error("CONTRADICTORY_TIMESTAMPS");
    const senderId = id(row.sender_qq);
    event = {
      agentId: mapped.agentId,
      accountId: account,
      conversation: conversation(row.conversation),
      messageId: id(row.message_id),
      senderId,
      direction: direction(row.is_self, undefined, senderId, account),
      body: row.text,
      occurredAt: iso || unix || "unknown",
    };
    metadata = {
      robot: row.robot,
      robotQQ: account,
      senderName: row.sender_name ?? null,
      segments: exportSegments(row.segments),
      originalSegments: row.segments,
      originalTimestamp: row.timestamp ?? null,
      originalUnixTime: row.unix_time ?? null,
      timestampNote: row.timestamp_note ?? null,
      legacySeq: row.message_seq ?? null,
      source: row.source,
      possibleTextTruncation: row.possible_text_truncation,
    };
  } else {
    if (
      row.schema_version !== undefined ||
      row.robot_qq !== undefined ||
      row.robot !== undefined
    )
      throw Error("EXPORT_REQUIRES_EXPLICIT_ADAPTER");
    if (row.role || row.reasoning || row.thinking || row.tool_calls)
      throw Error("MODEL_CONTENT_NOT_CHAT");
    const account = binding.accountId || null;
    const senderId = id(row.senderId ?? row.userId ?? row.user_id);
    const dir = direction(row.isSelf, row.direction, senderId, account);
    const body = row.plain ?? row.body ?? row.text;
    if (typeof body !== "string") throw Error("UNRECOGNIZED_MESSAGE_BODY");
    event = {
      agentId: binding.agentId,
      accountId: account,
      conversation: conversation(row.conversation ?? row.key),
      messageId: id(row.messageId ?? row.message_id),
      senderId: senderId || (dir === "out" ? account : null),
      direction: dir,
      body,
      occurredAt:
        originalTime(row.occurredAt ?? row.time ?? row.timestamp) || "unknown",
    };
    metadata = {
      senderName: row.sender_name ?? row.senderName ?? row.sender ?? null,
      segments: validateSegments(row.segments),
      legacySeq: row.seq ?? null,
      originalTimestamp: row.occurredAt ?? row.time ?? row.timestamp ?? null,
      source: format,
      possibleTextTruncation:
        row.possible_text_truncation ??
        (format === "social-v2" ? "unknown" : false),
      media: row.media ?? [],
      attachments: row.attachments ?? [],
      forwardIds: row.forwardIds ?? [],
      quoteTargetIsSelf: row.quoteTargetIsSelf ?? null,
    };
  }
  if (metadata.senderName !== null && typeof metadata.senderName !== "string")
    throw Error("INVALID_SENDER_NAME");
  const observation = { ...event, ...metadata };
  const identity = event.messageId
    ? [event.agentId, event.conversation, "messageId", event.messageId]
    : [
        event.agentId,
        event.conversation,
        "source-fallback",
        source.sourceId,
        format,
        event.occurredAt,
        event.direction,
        event.senderId,
        metadata.legacySeq ?? null,
        event.occurredAt === "unknown" ? source.locator : null,
        digest(observation),
      ];
  return {
    ...event,
    kind: "legacy.message-observation",
    status: "legacy-unverified",
    origin: "legacy-import-v2",
    dedupe: "legacy-v2:" + digest(identity),
    payload: {
      ...metadata,
      timeKnown: event.occurredAt !== "unknown",
      raw: { sender: { nickname: metadata.senderName } },
      migration: {
        version: 2,
        identity: event.messageId ? "message-id" : "source-fallback",
        sources: [
          { ...source, format, digest: digest(observation), observation },
        ],
      },
    },
  };
}

// Keep every distinct original observation; selecting richer display text never
// erases truncated alternatives or claims that an old send was confirmed here.
export function mergeObservations(old, incoming) {
  for (const key of ["senderId", "direction"])
    if (
      old[key] &&
      incoming[key] &&
      old[key] !== "unknown" &&
      incoming[key] !== "unknown" &&
      old[key] !== incoming[key]
    )
      throw Error("CONFLICTING_MESSAGE_IDENTITY");
  const sources = [...old.payload.migration.sources];
  for (const s of incoming.payload.migration.sources)
    if (
      !sources.some(
        (x) =>
          x.sourceId === s.sourceId &&
          x.format === s.format &&
          x.digest === s.digest &&
          (incoming.messageId || x.locator === s.locator),
      )
    )
      sources.push(s);
  const score = (o) =>
    (o.source === "qq_message_database" ? 1000000 : 0) +
    (o.possibleTextTruncation === false ? 100000 : 0) +
    Math.min(o.body.length, 50000) +
    (o.segments?.length || 0);
  const ranked = sources
    .map((s) => s.observation)
    .sort((a, b) => score(b) - score(a) || digest(a).localeCompare(digest(b)));
  const best = ranked[0];
  const {
    agentId,
    accountId,
    conversation,
    messageId,
    senderId,
    direction,
    body,
    occurredAt,
    ...meta
  } = best;
  const knownTime =
    ranked.find((o) => o.occurredAt !== "unknown")?.occurredAt || "unknown";
  const name = ranked.find((o) => o.senderName)?.senderName || null;
  return {
    ...old,
    body,
    senderId: senderId || ranked.find((o) => o.senderId)?.senderId || null,
    direction:
      direction === "unknown"
        ? ranked.find((o) => o.direction !== "unknown")?.direction || "unknown"
        : direction,
    occurredAt: knownTime,
    payload: {
      ...meta,
      senderName: name,
      raw: { sender: { nickname: name } },
      timeKnown: knownTime !== "unknown",
      segments: ranked.find((o) => o.segments?.length)?.segments || [],
      migration: { ...old.payload.migration, sources },
    },
  };
}
