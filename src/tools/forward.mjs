import { recallBoundary } from "../core/recall-boundary.mjs";
import { createHash } from "node:crypto";
import { mdToPlain } from "../../vendor/dsh-qq/md-to-plain.js";
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
  recallBoundary(runtime, ctx).assert(event);
  if (event.conversation !== ctx.conversation) {
    ctx.privateRead.add(event.id);
    ctx.persistTaint?.();
  }
  return event;
}
function segments(node) {
  const c =
    node.message ??
    node.content ??
    node.text ??
    node.data?.message ??
    node.data?.content ??
    node.data?.text;
  return Array.isArray(c)
    ? c
    : typeof c === "string"
      ? [{ type: "text", data: { text: c } }]
      : c?.type
        ? [c]
        : typeof c?.text === "string"
          ? [{ type: "text", data: { text: c.text } }]
          : Array.isArray(c?.content)
            ? c.content
            : [];
}
// Keep the wire payload and the local representation together: fallback nodes
// contain exactly the text we send, while real message references retain only
// segments already observed for that message. This is not a QQ download receipt.
export function forwardPayload(events, agent, connection) {
  const nodes = [],
    messages = [];
  for (const e of events) {
    const referenced = e.type === "message.received" && e.messageId;
    const content = referenced
      ? e.payload?.segments
      : [
          {
            type: "text",
            data: { text: mdToPlain(e.body).slice(0, 8000) },
          },
        ];
    const name = String(e.senderId || agent.name);
    const uin = String(e.senderId || connection.accountId);
    nodes.push(
      referenced
        ? { type: "node", data: { id: e.gatewayMessageId || e.messageId } }
        : {
            type: "node",
            data: { name, uin, content },
          },
    );
    messages.push(
      Array.isArray(content)
        ? {
            sender: { user_id: uin, nickname: name },
            message: content,
          }
        : null,
    );
  }
  const snapshot = messages.every(Boolean) ? { version: 1, messages } : null;
  if (snapshot && Buffer.byteLength(JSON.stringify(snapshot)) > 2 * 1024 * 1024)
    throw Error("FORWARD_TOO_LARGE");
  return { nodes, snapshot };
}

function confirmedForward(runtime, ctx, root) {
  if (root.direction !== "out" || !root.messageId) return null;
  const mem = runtime.memory.bind(ctx.agentId);
  // A confirmed send and a pre-schema-6 observed echo can both exist. The
  // receipt-backed send is explicit provenance, not a guessed content match.
  const ns = root.payload?.messageNamespace ?? null;
  const rows = mem.db
    .prepare(
      "SELECT DISTINCT e.* FROM message_identities i JOIN events e ON e.id=i.event_id WHERE i.agent_id=? AND i.connection_id=? AND i.conversation=? AND i.message_id=? AND (? IS NULL OR i.namespace=?) AND e.kind='message.sent' AND e.status='confirmed' AND e.direction='out'",
    )
    .all(
      ctx.agentId,
      root.connectionId,
      root.conversation,
      root.messageId,
      ns,
      ns,
    );
  if (rows.length !== 1) return null;
  const sent = mem.event(rows[0], root.conversation),
    p = sent.payload;
  if (
    !Array.isArray(p.eventIds) ||
    !p.eventIds.length ||
    p.eventIds.length > 50
  )
    return null;
  const receipt = mem.delivery(p.requestId);
  if (
    receipt?.status !== "sent" ||
    receipt.message_id !== sent.messageId ||
    receipt.conversation !== sent.conversation
  )
    return null;
  const sources = p.eventIds.map((id) =>
    mem.db
      .prepare("SELECT * FROM events WHERE agent_id=? AND id=? AND seq<?")
      .get(ctx.agentId, id, sent.seq),
  );
  let snapshot = p.forwardSnapshot;
  if (!snapshot) {
    // Compatibility with confirmed 0.2.2 deliveries: their source event IDs
    // were persisted before the network write, and events are append-only.
    if (sources.some((x) => !x)) return null;
    snapshot = forwardPayload(
      sources.map((x) => mem.event(x, sent.conversation)),
      runtime.agent(ctx.agentId),
      runtime.connection(sent.connectionId),
    ).snapshot;
  }
  if (
    snapshot?.version !== 1 ||
    !Array.isArray(snapshot.messages) ||
    snapshot.messages.length !== p.eventIds.length ||
    snapshot.messages.some((node) => !Array.isArray(node?.message))
  )
    return null;
  return {
    eventId: sent.id,
    connectionId: sent.connectionId,
    data: { messages: snapshot.messages },
    sources: sources.map((row) =>
      row ? mem.event(row, sent.conversation) : null,
    ),
  };
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
  const confirmed = confirmedForward(runtime, ctx, root);
  const localRoot = root.type === "message.sent" && confirmed;
  const roots = localRoot
    ? ["sent:" + confirmed.eventId]
    : extractForwardIds(root.payload?.segments);
  const confirmedResources = new Map();
  const registered = new Set();
  const rememberConfirmed = (id, candidate) => {
    if (!candidate) return;
    if (!confirmedResources.has(id)) confirmedResources.set(id, candidate);
    else if (confirmedResources.get(id)?.eventId !== candidate.eventId)
      confirmedResources.set(id, null); // Ambiguous lineage is never guessed.
  };
  const rememberConfirmedChildren = (candidate) => {
    if (!candidate || registered.has(candidate.eventId)) return;
    registered.add(candidate.eventId);
    for (let i = 0; i < candidate.sources.length; i++) {
      const source = candidate.sources[i];
      if (
        !source ||
        source.type !== "message.received" ||
        source.direction !== "out" ||
        source.connectionId !== candidate.connectionId
      )
        continue;
      const observed = source.payload?.segments;
      // Only an exact source card that was actually included in this confirmed
      // send can supply nested fallback. A matching resource elsewhere cannot.
      if (
        !Array.isArray(observed) ||
        hash(observed) !== hash(candidate.data.messages[i]?.message)
      )
        continue;
      const ids = extractForwardIds(observed);
      if (ids.length === 1)
        rememberConfirmed(ids[0], confirmedForward(runtime, ctx, source));
    }
  };
  if (roots.length === 1) rememberConfirmed(roots[0], confirmed);
  rememberConfirmedChildren(confirmed);
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
  rememberEmbedded(root.payload?.segments || []);
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
      if (p.confirmedEventId) {
        const row = mem.db
          .prepare("SELECT * FROM events WHERE agent_id=? AND id=?")
          .get(ctx.agentId, p.confirmedEventId);
        const candidate =
          row &&
          confirmedForward(runtime, ctx, mem.event(row, root.conversation));
        rememberConfirmed(p.resourceId, candidate);
        rememberConfirmedChildren(candidate);
      }
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
    errors = [],
    warnings = [];
  if (!queue.length) throw Error("FORWARD_NOT_FOUND");
  while (queue.length) {
    const entry = queue.shift();
    if (visited.has(entry.id)) continue;
    if (entry.depth > maxDepth || visited.size >= 10) {
      deferred.push(entry.id);
      continue;
    }
    visited.add(entry.id);
    const confirmedSource = confirmedResources.get(entry.id);
    const key = `forward-resource:${eventId}:${hash(entry.id)}`;
    let cached = mem.db
        .prepare("SELECT payload FROM events WHERE agent_id=? AND dedupe=?")
        .get(ctx.agentId, key),
      data,
      source = "gateway",
      warning;
    if (cached) {
      const archive = JSON.parse(cached.payload);
      data = archive.data;
      source = archive.source || "gateway";
      warning = archive.warning;
    } else {
      if (localRoot && entry.id === roots[0]) {
        data = confirmed.data;
        source = "confirmed-send-sources";
      } else {
        data = embedded.get(entry.id);
        if (data) source = "observed-inline-content";
      }
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
          runtime.assertActive(ctx);
          if (confirmedSource) {
            data = confirmedSource.data;
            source = "confirmed-send-sources";
            warning = "GATEWAY_READ_FAILED_USING_CONFIRMED_SEND_SOURCES";
          } else {
            errors.push({
              resourceId: entry.id,
              error: "FORWARD_FETCH_FAILED",
            });
            continue;
          }
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
        payload: {
          rootEventId: eventId,
          resourceId: entry.id,
          data,
          source,
          warning,
        },
        origin: "forward",
      });
    }
    // The resource's confirmed lineage survives a successful gateway read too:
    // a deeper child may fail independently. Only returned child IDs are queued.
    rememberConfirmedChildren(confirmedSource);
    if (warning) warnings.push({ resourceId: entry.id, code: warning });
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
          source,
          confirmedEventId: confirmedSource?.eventId,
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
        source,
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
    warnings,
    complete: !deferred.length && !errors.length,
    rootEventId: eventId,
  };
}
