import { taintMedia } from "../tools/legacy.mjs";
import { createHash } from "node:crypto";
import { contentIdentity } from "./urls.mjs";
import { saveFileImage } from "../tools/saved-media.mjs";
const terminal = new Set([
  "completed",
  "cancelled",
  "expired",
  "failed",
  "unknown",
]);
const hash = (s) => createHash("sha256").update(s).digest("hex");
function unrestricted(ctx) {
  if (
    [...ctx.privateRead].some((id) =>
      /^(operations|operations-result|github-private):/.test(id),
    )
  )
    throw Error("RESTRICTED_CONTEXT_MIND_WRITE_BLOCKED");
}
function attempts(service, agentId) {
  const m = service.memory(agentId);
  return m.db
    .prepare(
      "SELECT payload,observed_at FROM events WHERE agent_id=? AND kind='message.send-attempt' ORDER BY seq DESC",
    )
    .all(agentId)
    .flatMap((row) => {
      const app = JSON.parse(row.payload).appShare;
      return app ? [{ ...app, at: Date.parse(row.observed_at) }] : [];
    });
}
export function shareList(service, agentId) {
  return (
    service
      .memory(agentId)
      .identity?.list("intentions")
      .filter((i) => i.appShare) || []
  );
}
function checkPeer(service, ctx, record, target) {
  const r = service.runtime,
    a = r.agent(ctx.agentId),
    peerIds = r.config.connections
      .filter((c) => c.id !== a.connectionId)
      .map((c) => String(c.accountId));
  if (
    peerIds.includes(String(record.source?.senderId)) &&
    record.source?.conversation === target
  )
    throw Error("APP_PEER_REFLECTION_DENIED");
  for (const peer of r.config.agents.filter((x) => x.id !== a.id))
    if (
      attempts(service, peer.id).some(
        (x) =>
          x.key === record.key &&
          x.target === target &&
          x.at > r.now() - a.apps.dedupeMs,
      )
    )
      throw Error("APP_PEER_ALREADY_SHARED");
  if (!target.startsWith("private:") || !peerIds.includes(target.slice(8)))
    return;
  // Do not reflect a peer's received share back to that peer, even after re-reading it.
  if (record.source?.senderId === target.slice(8))
    throw Error("APP_PEER_REFLECTION_DENIED");
  for (const peer of r.config.agents.filter((x) => x.id !== a.id)) {
    const ownAccount = String(r.connection(a.connectionId).accountId);
    if (
      attempts(service, peer.id).some(
        (x) => x.key === record.key && x.target === "private:" + ownAccount,
      )
    )
      throw Error("APP_PEER_LOOP_DENIED");
  }
}
export function assertShare(
  service,
  ctx,
  record,
  target,
  { intentId, requestId } = {},
) {
  unrestricted(ctx);
  const r = service.runtime,
    a = service.active(ctx, record.platform, { sharing: true });
  if (
    !record.ok ||
    record.origin !== "app-browser" ||
    !record.url ||
    !record.key
  )
    throw Error("APP_BROWSED_SOURCE_REQUIRED");
  if (contentIdentity(record.url, record.platform).key !== record.key)
    throw Error("APP_SOURCE_INVALID");
  if (Date.parse(record.fetchedAt) + a.apps.shareTtlMs <= r.now())
    throw Error("APP_SOURCE_EXPIRED");
  checkPeer(service, ctx, record, target);
  const all = attempts(service, a.id),
    recent = all.filter((x) => x.at > r.now() - 86400000);
  const delivery = service.memory(a.id).delivery(requestId || "");
  if (!delivery && recent.length >= a.apps.maxSharesPerDay)
    throw Error("APP_SHARE_BUDGET");
  if (
    all.some(
      (x) =>
        x.key === record.key &&
        x.target === target &&
        x.requestId !== requestId &&
        (x.at > r.now() - a.apps.dedupeMs ||
          ["unknown", "pending"].includes(
            service.memory(a.id).delivery(x.requestId)?.status,
          )),
    )
  )
    throw Error("APP_SHARE_DUPLICATE");
  if (
    shareList(service, a.id).some(
      (i) =>
        i.id !== intentId &&
        i.appShare.key === record.key &&
        i.target === target &&
        (!terminal.has(i.status) ||
          i.status === "unknown" ||
          i.sentAt > r.now() - a.apps.dedupeMs),
    )
  )
    throw Error("APP_SHARE_DUPLICATE");
  return a;
}
export function proposeShare(service, ctx, args) {
  const r = service.runtime;
  if (!r.subject) throw Error("APP_SUBJECT_UNAVAILABLE");
  const record = service.get(ctx, args.recordId),
    a = assertShare(service, ctx, record, args.target);
  const now = r.now();
  return r.subject.create(ctx, {
    topic: record.key + " → " + args.target,
    target: args.target,
    reason: args.reason,
    background: args.background || "",
    evidence: [record.recordId],
    eligibleAt: now,
    expiresAt: Math.min(
      now + a.apps.shareTtlMs,
      Date.parse(record.fetchedAt) + a.apps.shareTtlMs,
    ),
    expectsResponse: false,
    appShare: {
      recordId: record.recordId,
      key: record.key,
      platform: record.platform,
      url: record.url,
      title: record.title,
      author: record.author,
      readingScope: record.readingScope,
      source: record.source || null,
    },
  });
}
export async function fetchImage(service, ctx, { recordId, index = 0 }) {
  const record = service.get(ctx, recordId),
    r = service.runtime;
  service.active(ctx, record.platform, { spend: true });
  r.assertDisclosure(ctx);
  if (!r.media) throw Error("MEDIA_UNAVAILABLE");
  const url = record.images?.length
    ? record.images[index]
    : index === 0
      ? record.image
      : null;
  if (!record.ok || !url) throw Error("APP_IMAGE_UNAVAILABLE");
  const file = await r.callTool(ctx, "file_download", { url });
  service.active(ctx, record.platform);
  const image = saveFileImage(r, ctx, file.fileId, {
    title: record.title || "App 图片",
    kind: "app-image",
    appRecordId: recordId,
  });
  return {
    ...image,
    id: image.mediaId,
    readingScope: "registered-image",
    notice: "登记成功不代表已理解图片；需实际查看图片后才能描述。",
  };
}
export async function sendShare(service, ctx, { recordId, comment, mediaId }) {
  const r = service.runtime,
    record = service.get(ctx, recordId);
  const i = ctx.activeIntentId
    ? service.memory(ctx.agentId).identity.get("intentions", ctx.activeIntentId)
    : null;
  if (i && (!i.appShare || i.appShare.recordId !== recordId))
    throw Error("APP_INTENT_SOURCE_MISMATCH");
  const requestId = i
    ? "intent:" + i.id
    : "app:" +
      hash(
        ctx.agentId +
          "|" +
          ctx.conversation +
          "|" +
          record.key +
          "|" +
          recordId,
      );
  assertShare(service, ctx, record, ctx.conversation, {
    intentId: i?.id,
    requestId,
  });
  if (!comment.trim() || /https?:\/\/|\b(?:BV[A-Za-z0-9]{10})\b/.test(comment))
    throw Error("APP_COMMENT_REQUIRES_PLAIN_TEXT");
  const body = comment.trim() + "\n" + record.url,
    segments = [{ type: "text", data: { text: body } }];
  if (mediaId) {
    if (!r.media) throw Error("MEDIA_UNAVAILABLE");
    const meta = r.media.metadata(ctx.agentId, mediaId);
    if (meta?.appRecordId !== recordId)
      throw Error("APP_IMAGE_SOURCE_MISMATCH");
    taintMedia(ctx, meta);
    unrestricted(ctx);
    r.assertDisclosure(ctx);
    segments.push(r.media.segment(ctx.agentId, mediaId));
  }
  const appShare = {
    recordId,
    key: record.key,
    platform: record.platform,
    url: record.url,
    readingScope: record.readingScope,
    target: ctx.conversation,
    requestId,
  };
  return r.deliver(ctx, {
    requestId,
    intent: { type: "app-share", recordId, comment, mediaId },
    body,
    metadata: { appShare, segments },
    send: (transport) => transport.send(ctx.conversation, segments),
  });
}
// Called inside the existing serialized outbox immediately before reservation.
export function beforeShareDelivery(service, ctx, metadata) {
  const i = ctx.activeIntentId
    ? service.memory(ctx.agentId).identity.get("intentions", ctx.activeIntentId)
    : null;
  if (i?.appShare && !metadata?.appShare)
    throw Error("APP_SHARE_TOOL_REQUIRED");
  if (!metadata?.appShare) return;
  const v = metadata.appShare,
    record = service.get(ctx, v.recordId);
  if (i && i.appShare?.recordId !== v.recordId)
    throw Error("APP_INTENT_SOURCE_MISMATCH");
  assertShare(service, ctx, record, ctx.conversation, {
    intentId: i?.id,
    requestId: v.requestId,
  });
}

export async function cancelShare(service, agentId, id, revision) {
  const r = service.runtime,
    i = service.memory(agentId).identity?.get("intentions", id);
  if (!i?.appShare) throw Error("APP_INTENT_NOT_FOUND");
  if (i.revision !== revision) throw Error("REVISION_CONFLICT");
  if (
    terminal.has(i.status) ||
    service.memory(agentId).delivery("intent:" + id)
  )
    throw Error("APP_SHARE_ALREADY_ATTEMPTED_OR_CLOSED");
  const result = r.subject.transition(
    agentId,
    i,
    "cancelled",
    "administrator cancelled",
  );
  await r.cancel(agentId);
  return result;
}
