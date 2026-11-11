// @ts-check
import { createHash } from "node:crypto";
import { draftScope } from "./draft-delivery.mjs";
import { groupDeliveryEvidence } from "../transport/delivery-history.mjs";

const EVIDENCE_WINDOW_MS = 10 * 60000;
const CHECK_INTERVAL_MS = 5000;
const CANDIDATE_LIMIT = 50;
const groupId = (/** @type {string} */ conversation) =>
  /^group:([1-9]\d{0,19})$/.exec(conversation)?.[1];

/** @typedef {import("../memory/qq-drafts.mjs").DraftScope} Scope */
/** @typedef {NonNullable<ReturnType<typeof groupDeliveryEvidence>>} Evidence */
/** @typedef {{requestId:string,created:number,text?:string,imageMd5?:string}} Candidate */

/** @param {any} runtime @param {Scope} scope @param {string} mediaId */
function imageDigest(runtime, scope, mediaId) {
  try {
    const image = runtime.media?.read(scope.agentId, mediaId);
    if (!image) return null;
    const bytes = Buffer.from(image.data, "base64");
    if (createHash("sha256").update(bytes).digest("hex") !== mediaId)
      return null;
    return createHash("md5").update(bytes).digest("hex");
  } catch {
    return null;
  }
}

export class DeliveryRecovery {
  /** @param {any} runtime */
  constructor(runtime) {
    this.runtime = runtime;
    this.checks = new Map();
  }

  /** @param {Scope} scope */
  currentTransport(scope) {
    const { runtime } = this;
    if (
      runtime.closed ||
      runtime.maintenance.active ||
      !groupId(scope.conversation)
    )
      return null;
    const agent = runtime.config.agents.find(
      (/** @type {any} */ a) => a.id === scope.agentId,
    );
    if (
      agent?.connectionId !== scope.connectionId ||
      !runtime.writable(agent, scope.conversation)
    )
      return null;
    const connection = runtime.connection(scope.connectionId);
    const transport = runtime.transports.get(scope.connectionId);
    if (
      connection.enabled &&
      connection.accountId === scope.accountId &&
      transport?.connected
    )
      return transport;
    return null;
  }

  /** @param {Scope} scope @returns {Candidate[]} */
  candidates(scope) {
    const { runtime } = this;
    const memory = runtime.memory.bind(scope.agentId);
    const namespace =
      runtime.connection(scope.connectionId).messageIdNamespace || "onebot";
    const rows = memory.db
      .prepare(
        `SELECT d.request_id AS requestId,d.created_at AS createdAt,e.body,e.payload
        FROM deliveries d JOIN events e ON e.agent_id=d.agent_id AND e.dedupe='send:'||d.request_id||':pending'
        WHERE d.agent_id=? AND d.conversation=? AND d.status='unknown' AND d.created_at>=?
          AND e.conversation=d.conversation AND e.connection_id=? AND e.sender_id=?
          AND coalesce(json_extract(e.payload,'$.messageNamespace'),json_extract(e.payload,'$.referenceNamespace'),'onebot')=?
        ORDER BY d.created_at LIMIT ?`,
      )
      .all(
        scope.agentId,
        scope.conversation,
        new Date(runtime.now() - EVIDENCE_WINDOW_MS).toISOString(),
        scope.connectionId,
        scope.accountId,
        namespace,
        CANDIDATE_LIMIT + 1,
      );
    // A truncated set cannot prove that an attempt is unique.
    if (rows.length > CANDIDATE_LIMIT) return [];
    const digests = new Map();
    return rows.flatMap((/** @type {any} */ row) => {
      const p = JSON.parse(row.payload);
      if (
        p.deliveryType === "action" ||
        p.actionKind ||
        p.replyTo ||
        p.requestedReplyTo ||
        p.atUserId ||
        p.fileId ||
        p.audioId ||
        p.eventIds
      )
        return [];
      const created = Math.floor(Date.parse(row.createdAt) / 1000) * 1000;
      const parts = p.segments ?? [
        { type: "text", data: { text: row.body } },
        ...(p.mediaId ? [{ type: "image", data: { mediaId: p.mediaId } }] : []),
      ];
      if (!Array.isArray(parts)) return [];
      const image = p.mediaId ? parts.at(-1) : null;
      if (
        p.mediaId &&
        (image?.type !== "image" || image.data?.mediaId !== p.mediaId)
      )
        return [];
      const textParts = image ? parts.slice(0, -1) : parts;
      if (
        !textParts.every(
          (part) =>
            part?.type === "text" && typeof part.data?.text === "string",
        )
      )
        return [];
      const text = textParts.map((part) => part.data.text).join("");
      if (!image)
        return text ? [{ requestId: row.requestId, created, text }] : [];
      if (!digests.has(p.mediaId))
        digests.set(p.mediaId, imageDigest(runtime, scope, p.mediaId));
      const digest = digests.get(p.mediaId);
      return digest
        ? [{ requestId: row.requestId, created, text, imageMd5: digest }]
        : [];
    });
  }

  /** @param {Scope} scope @param {Evidence[]} evidence @param {string} by @param {number} [after] */
  reconcile(scope, evidence, by, after = -Infinity) {
    if (!evidence.length) return;
    const { runtime } = this;
    const memory = runtime.memory.bind(scope.agentId);
    const known = memory.db.prepare(
      "SELECT 1 FROM deliveries WHERE agent_id=? AND conversation=? AND message_id=? LIMIT 1",
    );
    const available = [
      ...new Map(evidence.map((row) => [row.messageId, row])).values(),
    ].filter(
      (row) => !known.get(scope.agentId, scope.conversation, row.messageId),
    );
    const matches = this.candidates(scope).map((candidate) => ({
      requestId: candidate.requestId,
      evidence: available.filter(
        (row) =>
          candidate.created > after &&
          row.at >= candidate.created &&
          row.at <= candidate.created + EVIDENCE_WINDOW_MS &&
          candidate.imageMd5 === row.imageMd5 &&
          candidate.text === row.text,
      ),
    }));
    for (const match of matches) {
      if (match.evidence.length !== 1) continue;
      const [row] = match.evidence;
      if (
        matches.some((other) => other !== match && other.evidence.includes(row))
      )
        continue;
      memory.reconcileDelivery(match.requestId, "sent", {
        by,
        messageId: row.messageId,
      });
    }
  }

  /** @param {Scope} scope @param {any} raw */
  observeEcho(scope, raw) {
    if (!this.currentTransport(scope)) return;
    const target = groupId(scope.conversation);
    const evidence = target
      ? groupDeliveryEvidence(raw, scope.accountId, target)
      : null;
    if (evidence?.imageMd5) this.reconcile(scope, [evidence], "gateway-echo");
  }

  /** @param {Scope} scope */
  async check(scope) {
    const target = groupId(scope.conversation);
    const transport = this.currentTransport(scope);
    if (!target || !transport?.readGroupDeliveryEvidence) return;
    const key = JSON.stringify([
      scope.agentId,
      scope.accountId,
      scope.conversation,
    ]);
    const previous = this.checks.get(scope.connectionId);
    if (previous?.job) return previous.key === key ? previous.job : undefined;
    const time = this.runtime.now();
    if (previous && time - previous.time < CHECK_INTERVAL_MS) return;
    if (!this.candidates(scope).length) return;

    const namespace = this.runtime.connection(
      scope.connectionId,
    ).messageIdNamespace;
    const job = (async () => {
      let history;
      try {
        history = await transport.readGroupDeliveryEvidence(target);
      } catch {
        // An unsupported or unavailable history endpoint provides no verdict.
        return;
      }
      if (
        this.currentTransport(scope) === transport &&
        this.runtime.connection(scope.connectionId).messageIdNamespace ===
          namespace
      )
        this.reconcile(scope, history.items, "gateway-history", history.after);
    })();
    this.checks.set(scope.connectionId, { key, time, job });
    try {
      await job;
    } finally {
      this.checks.set(scope.connectionId, { key, time });
    }
  }

  /** @param {Scope} scope */
  checkInBackground(scope) {
    const job = this.check(scope).catch((cause) => {
      if (!this.runtime.closed)
        this.runtime.diagnostics.report(
          Error("DELIVERY_RECONCILIATION_FAILED", { cause }),
          {
            component: "runtime",
            agentId: scope.agentId,
            conversation: scope.conversation,
          },
        );
    });
    this.runtime.trackWork(job);
  }

  /** @param {any} ctx @param {string} [requestId] */
  async verify(ctx, requestId) {
    const { runtime } = this;
    runtime.assertActive(ctx);
    const scope = draftScope(runtime, ctx);
    // Existing Codex threads retain their original native tool fields.
    if (requestId === undefined) {
      await this.check(scope);
      runtime.assertActive(ctx);
      return;
    }
    const memory = runtime.memory.bind(scope.agentId);
    const attempt = memory.db
      .prepare(`SELECT d.status,d.message_id FROM deliveries d
      JOIN events e ON e.agent_id=d.agent_id AND e.dedupe='send:'||d.request_id||':pending'
      WHERE d.agent_id=? AND d.conversation=? AND d.request_id=?
        AND e.conversation=d.conversation AND e.connection_id=? AND e.sender_id=?`);
    const receipt = () =>
      attempt.get(
        scope.agentId,
        scope.conversation,
        requestId,
        scope.connectionId,
        scope.accountId,
      );
    const before = receipt();
    if (!before) throw Error("DELIVERY_NOT_FOUND");
    if (before.status === "unknown") await this.check(scope);
    runtime.assertActive(ctx);
    const current = receipt();
    if (!current) throw Error("DELIVERY_NOT_FOUND");
    return { requestId, status: current.status, messageId: current.message_id };
  }
}
