// @ts-check
import { createHmac, randomBytes } from "node:crypto";

/** @typedef {import("./message-timing.mjs").MessageTiming} MessageTiming */
/** @typedef {import("./message-timing.mjs").TimingDelivery["outcome"]} DeliveryOutcome */
/** @typedef {"cooldown" | "wakeRateLimit" | "rhythm"} Gate */
/** @typedef {{number: number, windowMs: number, maxMs: number, busyAt?: number, firstAt?: number,
 * batchReady?: number, gates: Partial<Record<Gate, {at: number, end: number, wallEnd: number}>>}} Pending */

const sendTools = new Set([
  "qq_send",
  "qq_send_burst",
  "qq_send_voice",
  "qq_send_file",
  "qq_forward_send",
  "qq_send_poke",
  "qq_react",
  "app_share_send",
]);

/** @param {string} name @param {{action?: unknown} | null | undefined} args */
export function isTimedSendTool(name, args) {
  return (
    sendTools.has(name) || (name === "qq_draft" && args?.action === "continue")
  );
}

const policyDenials = new Set([
  "AGENT_PAUSED_OR_EXPIRED",
  "CONVERSATION_SILENCED",
  "FILE_PERMISSION_DISABLED",
  "QQ_NOT_CONNECTED",
  "INTENT_DECISION_REQUIRED",
  "PRIVATE_RECOLLECTION_REQUIRES_DISCLOSURE_GRANT",
  "PROTECTED_WORK_OUTBOUND_DENIED",
  "QQ_DRAFT_SOURCE_RECALLED",
  "QQ_DRAFT_TURN_EXPIRED",
  "RECOVERY_DELIVERY_BLOCKED",
  "REPLY_BURST_LIMIT",
  "TOOL_DISABLED",
  "TOOL_NOT_ALLOWED",
]);

/** @param {unknown} error @returns {DeliveryOutcome} */
export function timedDeliveryFailure(error) {
  const code =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : undefined;
  if (
    code === "INPUT_REVIEW_REQUIRED" ||
    code === "QQ_DRAFT_CONTINUE_REQUIRED" ||
    code === "TONE_REVIEW_SUGGESTED"
  )
    return "review-required";
  if (code === "QQ_DRAFT_DELIVERY_UNRESOLVED") return "unresolved-delivery";
  if (
    code === "DELIVERY_UNKNOWN" ||
    code === "DELIVERY_ALREADY_ATTEMPTED_UNKNOWN" ||
    code === "DELIVERY_CONFIRMED_AUDIT_FAILED"
  )
    return "unknown";
  if (code && policyDenials.has(code)) return "policy-blocked";
  if (code && /(?:^|_)RATE_LIMIT(?:ED)?$/.test(code)) return "rate-limited";
  return "failed";
}

// Correlate only the pending work observed by this process. The keyed digests
// are transient and never appear in the collector or in an exported sample.
export class ConversationTiming {
  #secret = randomBytes(32);
  /** @type {Map<string, Pending>} */
  #pending = new Map();

  /** @param {MessageTiming} timing */
  constructor(timing) {
    this.timing = timing;
  }

  /** @param {string} agent @param {string} conversation */
  #key(agent, conversation) {
    return createHmac("sha256", this.#secret)
      .update(JSON.stringify([agent, conversation]))
      .digest("hex");
  }

  /** @param {string} agent @param {string} conversation */
  get(agent, conversation) {
    if (!this.#pending.size) return;
    const key = this.#key(agent, conversation);
    const entry = this.#pending.get(key);
    if (entry && this.timing.hasOpen(entry.number)) return entry;
    this.#pending.delete(key);
  }

  /**
   * @param {string} agent @param {string} conversation
   * @param {{batchWindowMs: number, batchMaxMs: number}} behavior
   * @param {{inboundAt?: number, newBatch?: boolean, started?: number, due?: number, wallNow: number, at: number, busy: boolean, immediate?: boolean}} points
   */
  observe(
    agent,
    conversation,
    behavior,
    { inboundAt, newBatch, started, due, wallNow, at, busy, immediate },
  ) {
    let entry = this.get(agent, conversation);
    const scope = conversation.startsWith("group:")
      ? "group"
      : conversation.startsWith("private:")
        ? "private"
        : undefined;
    if (!scope) return;
    const windowMs = behavior.batchWindowMs;
    const maxMs = behavior.batchMaxMs;
    if (!entry) {
      if (inboundAt === undefined) return;
      if (this.#pending.size >= this.timing.maxSamples)
        for (const [key, value] of this.#pending)
          if (!this.timing.hasOpen(value.number)) this.#pending.delete(key);
      const number = this.timing.start(scope, { windowMs, maxMs }, inboundAt);
      if (number === undefined) return;
      entry = { number, windowMs, maxMs, gates: {} };
      this.#pending.set(this.#key(agent, conversation), entry);
      if (newBatch) {
        entry.firstAt = inboundAt;
        this.timing.mark(number, "firstInbound", inboundAt);
      }
    } else if (entry.windowMs !== windowMs || entry.maxMs !== maxMs) {
      this.timing.clearPolicy(entry.number);
    }
    if (inboundAt !== undefined) {
      if (entry.firstAt !== undefined && inboundAt < entry.firstAt) {
        this.timing.clearFirstInbound(entry.number);
        delete entry.firstAt;
      }
      this.timing.mark(entry.number, "lastInbound", inboundAt);
    }
    if (busy) entry.busyAt ??= at;
    if (started !== undefined)
      this.timing.mark(entry.number, "batchStarted", at + (started - wallNow));
    if (due !== undefined) {
      const ready = at + (due - wallNow);
      entry.batchReady = immediate
        ? Math.min(entry.batchReady ?? ready, ready)
        : ready;
      this.timing.mark(entry.number, "batchReady", entry.batchReady);
    }
  }

  /** @param {Pending} entry @param {Gate} gate @param {number} wallEnd @param {number} wallNow */
  defer(entry, gate, wallEnd, wallNow) {
    const previous = entry.gates[gate];
    if (previous?.wallEnd === wallEnd) return;
    const at = this.timing.clock();
    if (previous)
      this.timing.interval(
        entry.number,
        gate,
        previous.at,
        Math.min(previous.end, at),
      );
    if (wallEnd > wallNow)
      entry.gates[gate] = { at, end: at + (wallEnd - wallNow), wallEnd };
    else delete entry.gates[gate];
  }

  /** @param {string} agent @param {string} conversation */
  occupy(agent, conversation) {
    const entry = this.get(agent, conversation);
    if (entry) entry.busyAt ??= this.timing.clock();
  }

  /** @param {string} agent @param {string} conversation */
  release(agent, conversation) {
    const entry = this.get(agent, conversation);
    if (entry?.busyAt === undefined) return;
    this.timing.interval(
      entry.number,
      "busy",
      entry.busyAt,
      this.timing.clock(),
    );
    delete entry.busyAt;
  }

  /** @param {string} agent @param {string} conversation @param {boolean} dispatch */
  take(agent, conversation, dispatch) {
    const entry = this.get(agent, conversation);
    if (!entry) return;
    this.release(agent, conversation);
    const now = this.timing.clock();
    for (const [name, wait] of Object.entries(entry.gates))
      this.timing.interval(
        entry.number,
        /** @type {Gate} */ (name),
        wait.at,
        Math.min(wait.end, now),
      );
    this.#pending.delete(this.#key(agent, conversation));
    if (!dispatch) {
      this.timing.finish(entry.number, "skipped");
      return;
    }
    this.timing.mark(entry.number, "dispatched", now);
    return entry.number;
  }
}
