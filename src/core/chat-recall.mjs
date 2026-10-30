import { chatHistory } from "./chat-context.mjs";
import { recallBoundary } from "./recall-boundary.mjs";
import { references, quotedMessage } from "./person-cards.mjs";

const MAX_CHARS = 12000;
const KINDS =
  "('message.received','message.sent','legacy.message-observation')";

// Historical speech is a separate, read-only projection. Never call seen() or
// observeInput() for it: replay cannot grant authority or advance watermarks.
export function chatRecall(runtime, ctx, history, handoff, throughSeq) {
  const memory = runtime.memory.bind(ctx.agentId);
  const boundary = recallBoundary(runtime, ctx);
  const read = memory.db.prepare(
    "SELECT * FROM events WHERE agent_id=? AND conversation=? AND id=?",
  );
  const rows = memory.db
    .prepare(
      `SELECT * FROM events WHERE agent_id=? AND conversation=? AND seq<=? AND kind IN ${KINDS} ORDER BY seq DESC LIMIT 41`,
    )
    .all(ctx.agentId, ctx.conversation, throughSeq);
  const shown = new Set(history.items.map((x) => x.id));
  const sourceIds = new Set();
  const result = {
    items: [],
    quoted: [],
    earlier: [],
    missingQuotes: [],
    omittedBefore: rows.length > 40,
    quotesOmitted: 0,
    quoteContinuation: null,
    earlierOmitted: 0,
    earlierContinuation: null,
    continuation: { tool: "conversation_read", beforeSeq: throughSeq + 1 },
    notice:
      "历史回放，不是新来信，不改变处理水位。items 按本聊天账本顺序连续选取；quoted 是明确引用的较早消息；earlier 是尚未写入工作笔记的起始线索，是否仍适用需核对。省略处不编造过渡。",
  };
  const project = (row) =>
    chatHistory({
      items: [
        memory.feedEvent(row, ctx.conversation, new Set(), { fullText: true }),
      ],
    }).items[0];
  const available = (row) =>
    row && boundary.allowed(memory.event(row, ctx.conversation, true));
  function add(key, item, budget = MAX_CHARS - 300, prepend = false) {
    const items = prepend ? [item, ...result[key]] : [...result[key], item];
    if (JSON.stringify({ ...result, [key]: items }).length > budget)
      return false;
    result[key] = items;
    if (item.id) {
      shown.add(item.id);
      sourceIds.add(item.id);
    }
    return true;
  }
  function reference(row) {
    return {
      id: row.id,
      seq: row.seq,
      type: row.kind,
      bodyOmitted: true,
      notice: "原文超出本次材料预算；需要时完整续读，不据此猜测内容。",
      continuation: { tool: "memory_read", id: row.id, offset: 0 },
    };
  }
  const selectedRows = [];
  for (const row of rows.slice(0, 40)) {
    if (shown.has(row.id)) continue;
    // Stop at an unreadable/oversized boundary instead of skipping a hole and
    // presenting unrelated earlier speech as a continuous transcript.
    if (!available(row)) {
      result.omittedBefore = true;
      break;
    }
    if (!add("items", project(row), 8500, true)) {
      result.omittedBefore = true;
      if (!result.items.length) add("items", reference(row), 8500);
      break;
    }
    selectedRows.unshift(row);
  }
  result.continuation.beforeSeq = result.items[0]?.seq || throughSeq + 1;

  const candidates = [
    ...history.items
      .filter(
        (x) =>
          !x.summaryOmitted &&
          !x.bodyTruncated &&
          [
            "message.received",
            "message.sent",
            "legacy.message-observation",
          ].includes(x.type),
      )
      .map((x) => read.get(ctx.agentId, ctx.conversation, x.id)),
    selectedRows[0],
  ].filter(Boolean);
  const quoteRequests = candidates.flatMap((row) =>
    references(row).replies.map((messageId) => ({ row, messageId })),
  );
  function deferQuote(row) {
    result.quotesOmitted++;
    result.quoteContinuation ||= {
      tool: "conversation_read",
      aroundId: row.id,
    };
  }
  for (const { row, messageId } of quoteRequests.slice(0, 4)) {
    const target = quotedMessage(memory.db, row, messageId);
    if (!available(target)) {
      if (
        !add(
          "missingQuotes",
          {
            fromId: row.id,
            messageId,
            notice: "引用原文不可用、不可读取或不唯一，不能猜测。",
          },
          10000,
        )
      )
        deferQuote(row);
      continue;
    }
    if (shown.has(target.id)) continue;
    const item = { ...project(target), quotedBy: row.id };
    if (
      !add("quoted", item, 10000) &&
      !add("quoted", { ...reference(target), quotedBy: row.id }, 10000)
    )
      deferQuote(row);
  }
  for (const { row } of quoteRequests.slice(4)) deferQuote(row);
  // Keep original task conditions when no note carries their source yet.
  // These are separate fallback references, never a prefix welded onto the tail.
  const anchors = (
    memory.state(ctx.conversation).continuity?.anchors || []
  ).slice(0, 4);
  const noted = new Set((handoff.notes || []).flatMap((n) => n.evidence || []));
  for (const id of anchors) {
    if (shown.has(id) || noted.has(id)) continue;
    const row = read.get(ctx.agentId, ctx.conversation, id);
    if (!available(row) || row.seq > throughSeq) continue;
    if (!add("earlier", project(row)) && !add("earlier", reference(row))) {
      result.earlierOmitted++;
      result.earlierContinuation ||= {
        tool: "memory_read",
        id: row.id,
        offset: 0,
      };
    }
  }

  // Durable source tracking is required even though recall does not count as
  // new input. This is the same boundary/taint path as the existing handoff.
  for (const id of sourceIds) ctx.privateRead.add(id);
  ctx.persistTaint?.();
  return result;
}
