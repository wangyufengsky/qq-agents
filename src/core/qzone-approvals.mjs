// @ts-check
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { sendQzone } from "./qzone.mjs";

const TTL = 24 * 60 * 60 * 1000;
const decision = z
  .object({
    approvalId: z.uuid(),
    agentId: z.string().min(1).max(64),
    digest: z.string().regex(/^[a-f0-9]{64}$/),
    action: z.enum(["approve", "cancel"]),
  })
  .strict();
const digest = (/** @type {any} */ value) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** A post approval owns immutable text, never a live model capability. */
export class QzoneApprovals {
  /** @param {any} runtime */
  constructor(runtime) {
    this.runtime = runtime;
    this.db = runtime.memory.db;
    // A crash cannot replay an approval. The delivery ledger remains authoritative.
    for (const row of this.db
      .prepare("SELECT * FROM qzone_approvals WHERE state='submitting'")
      .all()) {
      const receipt = runtime.memory
        .bind(row.agent_id)
        .delivery(row.request_id);
      this.setState(
        row.id,
        receipt
          ? receipt.status === "pending"
            ? "unknown"
            : receipt.status
          : "failed",
      );
    }
  }
  /** @param {string} id @param {string} state */
  setState(id, state) {
    this.db
      .prepare("UPDATE qzone_approvals SET state=? WHERE id=?")
      .run(state, id);
  }
  expire() {
    this.db
      .prepare(
        "UPDATE qzone_approvals SET state='expired' WHERE state='awaiting_approval' AND expires_at<=?",
      )
      .run(this.runtime.now());
  }
  /** @param {any} row */
  view(row) {
    const value = JSON.parse(row.value);
    return {
      approvalId: row.id,
      agentId: row.agent_id,
      requestId: row.request_id,
      status: row.state,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      ...value,
    };
  }
  list() {
    this.expire();
    return this.db
      .prepare(
        "SELECT * FROM qzone_approvals WHERE state IN ('awaiting_approval','submitting') ORDER BY created_at,id",
      )
      .all()
      .map((/** @type {any} */ row) => this.view(row));
  }
  /** Only receipt metadata goes back to the model, not another context's sources.
   * @param {any} row
   */
  receipt(row) {
    if (["sent", "failed", "unknown"].includes(row.state)) {
      const delivery = this.runtime.memory
        .bind(row.agent_id)
        .delivery(row.request_id);
      if (delivery && delivery.status !== "pending") {
        row.state = delivery.status;
        this.setState(row.id, row.state);
      }
    }
    return {
      approvalId: row.id,
      requestId: row.request_id,
      status: row.state,
      expiresAt: row.expires_at,
    };
  }
  /** @param {any} ctx @param {{requestId:string,content:string}} args */
  prepare(ctx, args) {
    const r = this.runtime;
    r.assertSafeOutput(ctx, args.content);
    this.expire();
    const a = r.agent(ctx.agentId),
      connection = r.connection(a.connectionId);
    const previous = this.db
      .prepare(
        "SELECT * FROM qzone_approvals WHERE agent_id=? AND request_id=?",
      )
      .get(a.id, args.requestId);
    if (previous) {
      const value = JSON.parse(previous.value);
      if (
        value.content !== args.content ||
        value.conversation !== ctx.conversation ||
        value.connectionId !== a.connectionId ||
        value.accountId !== connection.accountId
      )
        throw Error("QZONE_APPROVAL_CONFLICT");
      return this.receipt(previous);
    }
    // Generic turn-wide grants must not authorize a different public post.
    const probe = { ...ctx, grants: new Set() };
    try {
      r.assertDisclosure(probe, { external: true });
      return null;
    } catch (error) {
      if (
        !(error instanceof Error) ||
        error.message !== "PRIVATE_RECOLLECTION_EXTERNAL_CALL_BLOCKED"
      )
        throw error;
    }
    if (
      this.db
        .prepare(
          "SELECT count(*) AS n FROM qzone_approvals WHERE agent_id=? AND state IN ('awaiting_approval','submitting')",
        )
        .get(a.id).n >= 10
    )
      throw Error("QZONE_APPROVAL_LIMIT");
    const binding = {
      agentId: a.id,
      requestId: args.requestId,
      conversation: ctx.conversation,
      connectionId: a.connectionId,
      accountId: connection.accountId,
      visibility: "public",
      content: args.content,
      sources: [...probe.privateRead].sort(),
    };
    const id = randomUUID(),
      now = r.now();
    this.db
      .prepare(
        "INSERT INTO qzone_approvals(id,agent_id,request_id,state,created_at,expires_at,value) VALUES(?,?,?,'awaiting_approval',?,?,?)",
      )
      .run(
        id,
        a.id,
        args.requestId,
        now,
        now + TTL,
        JSON.stringify({ ...binding, digest: digest(binding) }),
      );
    return this.receipt(
      this.db.prepare("SELECT * FROM qzone_approvals WHERE id=?").get(id),
    );
  }
  /** @param {any} input */
  async act(input) {
    const {
      approvalId,
      agentId,
      digest: expected,
      action,
    } = decision.parse(input);
    this.expire();
    const row = this.db
      .prepare("SELECT * FROM qzone_approvals WHERE id=? AND agent_id=?")
      .get(approvalId, agentId);
    if (!row || JSON.parse(row.value).digest !== expected)
      throw Error("QZONE_APPROVAL_INVALID");
    if (row.state !== "awaiting_approval") throw Error("QZONE_APPROVAL_CLOSED");
    if (action === "cancel") {
      this.setState(row.id, "cancelled");
      return { ...this.receipt(row), status: "cancelled" };
    }
    const value = JSON.parse(row.value),
      r = this.runtime;
    const checkBinding = () => {
      const a = r.agent(agentId),
        connection = r.connection(a.connectionId);
      if (
        a.connectionId !== value.connectionId ||
        connection.accountId !== value.accountId
      )
        throw Error("QZONE_APPROVAL_CONFLICT");
      if (
        !connection.enabled ||
        !r.toolsFor(a, value.conversation).includes("qzone_post")
      )
        throw Error("TOOL_DISABLED");
      if (r.now() >= row.expires_at) throw Error("QZONE_APPROVAL_CLOSED");
    };
    checkBinding();
    return r.withContext(
      agentId,
      value.conversation,
      async (/** @type {any} */ ctx) => {
        // This context only sends the reviewed bytes. It never runs a model or
        // overwrites the model session's newer disclosure/source state.
        ctx.privateRead = new Set(value.sources);
        ctx.grants = new Set(value.sources);
        ctx.persistTaint = () => {};
        r.assertDisclosure(ctx, { external: true });
        r.assertSafeOutput(ctx, value.content);
        if (
          !this.db
            .prepare(
              "UPDATE qzone_approvals SET state='submitting' WHERE id=? AND state='awaiting_approval'",
            )
            .run(row.id).changes
        )
          throw Error("QZONE_APPROVAL_CLOSED");
        try {
          const result = await sendQzone(
            r,
            ctx,
            { requestId: row.request_id, content: value.content },
            checkBinding,
          );
          this.setState(row.id, "sent");
          return result;
        } catch (error) {
          const receipt = r.memory.bind(agentId).delivery(row.request_id);
          // Preflight failures are safe to retry by another explicit approval;
          // a ledger reservation can never be retried by this approval.
          this.setState(
            row.id,
            receipt
              ? receipt.status === "pending"
                ? "unknown"
                : receipt.status
              : r.now() >= row.expires_at
                ? "expired"
                : "awaiting_approval",
          );
          throw error;
        }
      },
    );
  }
}
