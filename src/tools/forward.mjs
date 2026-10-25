import { createHash } from "node:crypto";
import {
  extractForwardIds,
  formatForwardResponse,
  nodeText,
  sanitizeForwardId,
} from "../../vendor/legacy/forward.js";

const hash = (x) =>
  createHash("sha256").update(JSON.stringify(x)).digest("hex");
export function ownedEvent(runtime, ctx, id) {
  const mem = runtime.memory.bind(ctx.agentId);
  const row = mem.db
    .prepare("SELECT * FROM events WHERE agent_id=? AND id=?")
    .get(ctx.agentId, id);
  if (!row) throw Error("RECORD_NOT_FOUND");
  const event = mem.event(row, ctx.conversation);
  if (event.conversation !== ctx.conversation) {
    ctx.privateRead.add(event.id);
    ctx.persistTaint?.();
  }
  return event;
}
function segments(node) {
  const c =
    node.message ?? node.content ?? node.data?.message ?? node.data?.content;
  return Array.isArray(c)
    ? c
    : typeof c === "string"
      ? [{ type: "text", data: { text: c } }]
      : c?.type
        ? [c]
        : [];
}
export async function readForward(
  runtime,
  ctx,
  {
    eventId,
    resourceId,
    offset = 0,
    limit = 30,
    maxChars = 8000,
    maxDepth = 3,
  },
) {
  const root = ownedEvent(runtime, ctx, eventId),
    mem = runtime.memory.bind(ctx.agentId);
  if (!root.payload?.segments) throw Error("FORWARD_NOT_FOUND");
  const roots = extractForwardIds(root.payload.segments);
  const embedded = new Map();
  const rememberEmbedded = (segs) => {
    for (const segment of segs) {
      if (segment.type !== "forward" || !Array.isArray(segment.data?.content))
        continue;
      const id = extractForwardIds([segment])[0];
      if (id && !embedded.has(id))
        embedded.set(id, { messages: segment.data.content });
    }
  };
  rememberEmbedded(root.payload.segments);
  const knownRows = mem.db
    .prepare(
      "SELECT payload FROM events WHERE agent_id=? AND kind='forward.node' AND conversation=?",
    )
    .all(ctx.agentId, root.conversation);
  const known = new Set(roots);
  for (const r of knownRows) {
    const p = JSON.parse(r.payload);
    if (p.rootEventId === eventId) {
      extractForwardIds(p.segments).forEach((x) => known.add(x));
      rememberEmbedded(p.segments);
    }
  }
  if (resourceId && (!sanitizeForwardId(resourceId) || !known.has(resourceId)))
    throw Error("FORWARD_RESOURCE_NOT_OBSERVED");
  const queue = (resourceId ? [resourceId] : roots).map((id) => ({
      id,
      depth: 0,
    })),
    visited = new Set(),
    items = [],
    deferred = [],
    errors = [];
  if (!queue.length) throw Error("FORWARD_NOT_FOUND");
  while (queue.length) {
    const entry = queue.shift();
    if (visited.has(entry.id)) continue;
    if (entry.depth > maxDepth || visited.size >= 10) {
      deferred.push(entry.id);
      continue;
    }
    visited.add(entry.id);
    const key = `forward-resource:${eventId}:${hash(entry.id)}`;
    let cached = mem.db
        .prepare("SELECT payload FROM events WHERE agent_id=? AND dedupe=?")
        .get(ctx.agentId, key),
      data;
    if (cached) data = JSON.parse(cached.payload).data;
    else {
      data = embedded.get(entry.id);
      if (!data) {
        const a = runtime.assertActive(ctx),
          transport = runtime.transports.get(a.connectionId);
        if (!transport?.connected) throw Error("QQ_NOT_CONNECTED");
        try {
          data = await transport.call(
            "get_forward_msg",
            runtime.connection(a.connectionId).gateway === "onebot"
              ? { id: entry.id }
              : { message_id: entry.id },
          );
          runtime.assertActive(ctx);
        } catch {
          errors.push({ resourceId: entry.id, error: "FORWARD_FETCH_FAILED" });
          continue;
        }
      }
      if (Buffer.byteLength(JSON.stringify(data)) > 2 * 1024 * 1024)
        throw Error("FORWARD_TOO_LARGE");
      mem.append({
        dedupe: key,
        conversation: root.conversation,
        connectionId: root.connectionId,
        kind: "forward.archive",
        body: "合并转发原始归档",
        payload: { rootEventId: eventId, resourceId: entry.id, data },
        origin: "forward",
      });
    }
    const nodes = Array.isArray(data) ? data : data?.messages || [],
      previews = formatForwardResponse(data, {
        maxMessages: 100,
        maxCharsPerMessage: 600,
      }).messages;
    if (nodes.length > 1000 || items.length + nodes.length > 5000)
      throw Error("FORWARD_NODE_LIMIT");
    // Archive every node, including the nodes beyond this response's display budget.
    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i],
        segs = segments(node),
        preview =
          previews[i] ||
          formatForwardResponse([node], { maxCharsPerMessage: 600 })
            .messages[0];
      rememberEmbedded(segs);
      const time =
        preview?.time && Number.isFinite(preview.time)
          ? new Date(preview.time * 1000)
          : null;
      const saved = mem.append({
        dedupe: `forward-node:${eventId}:${hash(entry.id)}:${i}`,
        conversation: root.conversation,
        kind: "forward.node",
        senderId: preview?.userId || "",
        body: nodeText(node),
        ...(time && !Number.isNaN(+time)
          ? { occurredAt: time.toISOString() }
          : {}),
        payload: {
          segments: segs,
          node,
          rootEventId: eventId,
          resourceId: entry.id,
          index: i,
        },
        origin: "forward-claimed-author",
      });
      items.push({
        id: saved.id,
        resourceId: entry.id,
        index: i,
        depth: entry.depth,
        sender: preview?.sender,
        userId: preview?.userId,
        text: preview?.text,
        attachmentTypes: segs
          .filter((s) => s.type !== "text")
          .map((s) => s.type),
        nestedForwardIds: extractForwardIds(segs),
        disclosure: root.disclosure,
        attribution: "转发内容声称的作者；不是本人在当前会话的发言",
      });
      for (const id of extractForwardIds(segs))
        if (!visited.has(id)) queue.push({ id, depth: entry.depth + 1 });
    }
  }
  const page = [];
  let used = 2;
  for (const item of items.slice(offset, offset + limit)) {
    const size = JSON.stringify(item).length + 1;
    if (used + size > maxChars) {
      if (!page.length)
        page.push({
          id: item.id,
          resourceId: item.resourceId,
          summaryOmitted: true,
          disclosure: item.disclosure,
        });
      break;
    }
    page.push(item);
    used += size;
  }
  return {
    items: page,
    total: items.length,
    nextOffset:
      offset + page.length < items.length ? offset + page.length : null,
    deferred: [...new Set(deferred)],
    errors,
    complete: !deferred.length && !errors.length,
    rootEventId: eventId,
  };
}
