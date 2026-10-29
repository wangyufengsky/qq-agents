import { recallPage } from "./recall-boundary.mjs";
import { looksLikeUnfinished } from "../../vendor/legacy/v2-wait.js";
import { allowed } from "./config.mjs";
import { references, quotedSender } from "./person-cards.mjs";

const priorities = {
  private: 100,
  mention: 90,
  question: 80,
  speaker: 75,
  name: 70,
  keyword: 60,
  poke: 55,
  message: 50,
  replyCheck: 40,
  sleep: 30,
  intent: 20,
  scheduled: 95,
  join: 45,
};
const endBatch = (state) => {
  delete state.wakeBatchAt;
  delete state.wakeBatchSenders;
};
// Wait batchWindowMs after the latest message, at most batchMaxMs after the first;
// a cap below the window keeps the window fixed from the first message.
function slide(a, state, now, senderId) {
  const { batchWindowMs, batchMaxMs } = a.behavior;
  state.wakeBatchAt ??= now;
  if (senderId && !state.wakeBatchSenders?.includes(senderId))
    state.wakeBatchSenders = [
      ...(state.wakeBatchSenders || []),
      senderId,
    ].slice(-20);
  const due = Math.min(
    state.wakeBatchAt + Math.max(batchWindowMs, batchMaxMs),
    now + batchWindowMs,
  );
  // A later rate-limit retry stays in place.
  state.wakeDueAt = Math.max(state.wakeDueAt ?? due, due);
}
export class ConversationEngine {
  constructor(runtime) {
    this.runtime = runtime;
    this.waiters = new Map();
    this.ticking = false;
  }
  now() {
    return +this.runtime.clock();
  }
  state(id, conversation) {
    return this.runtime.memory.bind(id).state(conversation);
  }
  write(id, conversation, state) {
    this.runtime.memory.bind(id).setState(conversation, state);
  }
  notify(id, conversation) {
    this.waiters.get(id + "|" + conversation)?.();
  }
  // A question someone puts to another group member: it @s only others, or
  // quotes a message someone else wrote. Read from the archived row when
  // there is one, since a quote names the message and not its author. A
  // private chat has no one else to ask, even when its user quotes
  // themselves.
  aimedElsewhere(a, e, accountId, archived) {
    if (!e.conversation.startsWith("group:")) return false;
    const at = e.segments
      .filter((s) => s.type === "at")
      .map((s) => String(s.data?.qq));
    if (at.length && !at.includes(accountId) && !at.includes("all"))
      return true;
    if (!archived?.id) return false;
    const m = this.runtime.memory.bind(a.id),
      row = m.db
        .prepare("SELECT * FROM events WHERE agent_id=? AND id=?")
        .get(a.id, archived.id);
    if (!row) return false;
    return references(row).replies.some((id) => {
      const author = quotedSender(m.db, row, id);
      return author != null && author !== accountId;
    });
  }
  reason(a, e, accountId, archived) {
    const wc = {
      ...a.wake,
      ...this.state(a.id, e.conversation).wakeConfig?.triggers,
    };
    // Only a poke aimed at this account is a wake; pokes between other members are just observed.
    if (e.kind === "notice.poke")
      return wc.poke && e.targetId === accountId ? "poke" : null;
    if (e.kind === "notice.join") return wc.joins ? "join" : null;
    if (!["message.received", "notice.file"].includes(e.kind)) return null;
    if (wc.private && e.conversation.startsWith("private:")) return "private";
    if (
      wc.mentions &&
      e.segments.some(
        (s) => s.type === "at" && String(s.data?.qq) === accountId,
      )
    )
      return "mention";
    if (
      wc.questions &&
      /[?？]/.test(e.body) &&
      !this.aimedElsewhere(a, e, accountId, archived)
    )
      return "question";
    if (wc.speakerIds?.includes(e.senderId)) return "speaker";
    if (wc.names && [a.name, ...a.aliases].some((n) => e.body.includes(n)))
      return "name";
    if (wc.keywords?.some((w) => e.body.includes(w))) return "keyword";
    return this.runtime.random() < wc.participation ? "message" : null;
  }
  // Whether a message speaks to this agent, whichever wake reason wins (a
  // question or a watched speaker can outrank a name or an @mention).
  addressed(a, e, accountId) {
    if (!["message.received", "notice.file"].includes(e.kind)) return false;
    return (
      e.conversation.startsWith("private:") ||
      e.segments.some(
        (s) => s.type === "at" && String(s.data?.qq) === accountId,
      ) ||
      [a.name, ...a.aliases].some((n) => n && e.body.includes(n))
    );
  }
  request(
    id,
    conversation,
    reason,
    {
      seq = 0,
      instruction = "",
      taskRunId = null,
      intentId = null,
      immediate = false,
      senderId = null,
      addressed = false,
    } = {},
  ) {
    const a = this.runtime.agent(id),
      state = this.state(id, conversation),
      now = this.now();
    // Timers left behind by wakes that were dropped elsewhere must not shape a new batch.
    if (!state.pendingWakes?.length) {
      delete state.wakeDueAt;
      endBatch(state);
    }
    state.pendingWakes ||= [];
    const existing = state.pendingWakes.find(
      (x) =>
        x.reason === reason &&
        x.taskRunId === taskRunId &&
        x.intentId === intentId,
    );
    if (existing) {
      existing.seq = Math.max(existing.seq, seq);
      if (addressed) existing.addressed = true;
    } else
      state.pendingWakes.push({
        reason,
        seq,
        instruction,
        taskRunId,
        intentId,
        at: now,
        ...(addressed ? { addressed: true } : {}),
      });
    // Never discard a persisted scheduled instruction when coalescing ordinary chat wakes.
    const tasks = state.pendingWakes.filter((x) => x.taskRunId || x.intentId),
      ordinary = state.pendingWakes
        .filter((x) => !x.taskRunId && !x.intentId)
        .slice(-20);
    state.pendingWakes = [...tasks, ...ordinary];
    if (immediate) {
      // Later chat wakes may join an immediate wake but never postpone it.
      endBatch(state);
      state.wakeDueAt = Math.min(state.wakeDueAt ?? now, now);
    } else if (state.wakeDueAt === undefined || state.wakeBatchAt !== undefined)
      slide(a, state, now, senderId);
    this.write(id, conversation, state);
    return this.flush(id, conversation);
  }
  // A follow-up that wakes nothing on its own still lets a sender in the pending batch finish.
  extend(id, conversation, senderId) {
    const state = this.state(id, conversation);
    if (
      !state.pendingWakes?.length ||
      !state.wakeBatchSenders?.includes(senderId)
    )
      return;
    slide(this.runtime.agent(id), state, this.now());
    this.write(id, conversation, state);
  }
  flush(id, conversation) {
    const runtime = this.runtime,
      a = runtime.agent(id),
      state = this.state(id, conversation),
      now = this.now();
    if (
      !runtime.writable(a, conversation) ||
      !runtime.transports.get(a.connectionId)?.connected ||
      runtime.running.has(id + "|" + conversation)
    )
      return { queued: true };
    if (!state.pendingWakes?.length || state.wakeDueAt > now)
      return { queued: true };
    const recent = (state.wakeTimes || []).filter((t) => t > now - 3600000);
    const minute = recent.filter((t) => t > now - 60000);
    const waits = [(state.lastWakeAt || 0) + a.wake.cooldownMs];
    if (minute.length >= a.behavior.maxWakePerMinute)
      waits.push(minute[minute.length - a.behavior.maxWakePerMinute] + 60000);
    if (recent.length >= a.behavior.maxWakePerHour)
      waits.push(recent[recent.length - a.behavior.maxWakePerHour] + 3600000);
    const retryAt = Math.max(...waits);
    if (retryAt > now) {
      state.wakeDueAt = retryAt;
      this.write(id, conversation, state);
      return { queued: true, rateLimited: true };
    }
    const pending = state.pendingWakes.filter((x) => {
      if (x.intentId) {
        const i = runtime.memory
          .bind(id)
          .identity.get("intentions", x.intentId);
        const valid =
          i.status === "handedoff" &&
          i.expiresAt > now &&
          runtime.subject.contactOpportunity(a, conversation);
        if (!valid && i.status === "handedoff")
          runtime.subject.transition(
            id,
            i,
            i.expiresAt <= now ? "expired" : "deferred",
            "queued contact opportunity no longer allowed",
            { eligibleAt: now + a.subject.contactCooldownMs },
          );
        return valid;
      }
      return x.taskRunId || !x.seq || x.seq > (state.readThroughSeq || 0);
    });
    state.pendingWakes = [];
    delete state.wakeDueAt;
    endBatch(state);
    if (!pending.length) {
      this.write(id, conversation, state);
      return { skipped: true };
    }
    pending.sort(
      (a, b) => (priorities[b.reason] || 0) - (priorities[a.reason] || 0),
    );
    state.wakeTimes = [...recent, now];
    state.lastWakeReason = pending[0].reason;
    state.replyCheckAt = null;
    if (state.wakeConfig)
      state.wakeConfig = { ...state.wakeConfig, sleepUntil: null };
    this.write(id, conversation, state);
    const job = runtime.wake(id, conversation, { reasons: pending });
    runtime.trackJob(job, id);
    return { started: true };
  }
  begin(ctx) {
    ctx.waitObservedMs = 0;
    ctx.observationSatisfied = false;
    ctx.waiting = false;
    ctx.wakeConfigured = false;
  }
  sent(ctx) {
    ctx.waitObservedMs = 0;
    ctx.observationSatisfied = false;
    const s = this.state(ctx.agentId, ctx.conversation);
    s.lastAiReplyAt = this.now();
    s.noActionCount = 0;
    this.write(ctx.agentId, ctx.conversation, s);
  }
  finish(ctx) {
    const a = this.runtime.agent(ctx.agentId),
      s = this.state(ctx.agentId, ctx.conversation);
    s.noActionCount = ctx.confirmedSends ? 0 : (s.noActionCount || 0) + 1;
    if (
      !ctx.wakeConfigured &&
      s.noActionCount < a.behavior.noActionLimit &&
      ctx.confirmedSends &&
      !ctx.activeIntentId &&
      !(s.proactiveCooldownUntil > this.now())
    )
      s.replyCheckAt = this.now() + a.behavior.replyCheckMs;
    if (s.noActionCount >= a.behavior.noActionLimit) s.replyCheckAt = null;
    this.write(a.id, ctx.conversation, s);
    this.flush(a.id, ctx.conversation);
  }
  setWake(ctx, { sleepMs, infinite = false, triggers, mode = "diving" }) {
    const a = this.runtime.assertActive(ctx);
    if (
      mode === "diving" &&
      a.behavior.preSleepWaitMs > 0 &&
      !ctx.observationSatisfied &&
      (ctx.waitObservedMs || 0) < a.behavior.preSleepWaitMs
    )
      throw Error("PRE_SLEEP_OBSERVATION_REQUIRED");
    const state = this.state(a.id, ctx.conversation);
    state.wakeConfig = {
      mode,
      infinite,
      triggers: { ...state.wakeConfig?.triggers, ...triggers },
      sleepUntil:
        mode === "active" || infinite ? null : this.now() + (sleepMs || 300000),
    };
    state.replyCheckAt =
      mode === "active" ? this.now() + a.behavior.replyCheckMs : null;
    ctx.wakeConfigured = true;
    this.write(a.id, ctx.conversation, state);
    return state.wakeConfig;
  }
  async wait(ctx, { timeoutMs = 30000, quietMs, afterSeq }) {
    const runtime = this.runtime,
      a = runtime.assertActive(ctx),
      key = a.id + "|" + ctx.conversation;
    if (this.waiters.has(key)) throw Error("ALREADY_WAITING");
    const duration = Math.min(timeoutMs, a.behavior.waitMaxMs),
      quiet = Math.max(quietMs ?? 8000, a.behavior.quietAfterNewMs);
    const from = afterSeq ?? ctx.shownSeq;
    if (from > ctx.shownSeq) throw Error("UNSEEN_WATERMARK");
    const realStart = Date.now(),
      end = realStart + duration;
    ctx.waiting = true;
    try {
      const reason = await new Promise((resolve, reject) => {
        let timer,
          lastSeq = from,
          lastChange = null,
          finished = false;
        const finish = (error, value) => {
          if (finished) return;
          finished = true;
          clearTimeout(timer);
          ctx.controller.signal.removeEventListener("abort", abort);
          this.waiters.delete(key);
          error ? reject(error) : resolve(value);
        };
        const abort = () => finish(Error("AGENT_PAUSED_OR_EXPIRED"));
        const check = () => {
          clearTimeout(timer);
          try {
            runtime.assertActive(ctx);
          } catch (e) {
            finish(e);
            return;
          }
          const s = this.state(a.id, ctx.conversation),
            seq = s.lastReceivedSeq || 0;
          if (seq > lastSeq) {
            lastSeq = seq;
            lastChange = Date.now();
          }
          if (lastChange !== null && Date.now() - lastChange >= quiet)
            return finish(null, "messages");
          if (Date.now() >= end)
            return finish(null, lastSeq > from ? "messages" : "timeout");
          timer = setTimeout(
            check,
            Math.max(
              1,
              Math.min(
                end - Date.now(),
                lastChange === null
                  ? duration
                  : quiet - (Date.now() - lastChange),
              ),
            ),
          );
        };
        this.waiters.set(key, check);
        ctx.controller.signal.addEventListener("abort", abort, { once: true });
        if (ctx.controller.signal.aborted) abort();
        else check();
      });
      runtime.assertActive(ctx);
      const messages = recallPage(
        runtime,
        ctx,
        runtime.memory.bind(a.id).conversation(
          {
            conversation: ctx.conversation,
            afterSeq: from,
            limit: 50,
            maxChars: 16000,
          },
          ctx.conversation,
        ),
      );
      runtime.contexts.seen(ctx, messages.items);
      ctx.feedThroughSeq = Math.max(
        ctx.feedThroughSeq || 0,
        messages.nextAfterSeq || 0,
      );
      ctx.waitObservedMs = (ctx.waitObservedMs || 0) + (Date.now() - realStart);
      ctx.observationSatisfied =
        reason === "messages" ||
        ctx.waitObservedMs >= a.behavior.preSleepWaitMs;
      return {
        reason,
        waitedMs: Date.now() - realStart,
        newMessages: messages,
        unfinished: messages.items.some((x) =>
          looksLikeUnfinished(x.body || x.summary),
        ),
      };
    } finally {
      ctx.waiting = false;
      this.waiters.delete(key);
    }
  }
  tick() {
    const runtime = this.runtime,
      now = this.now();
    const rows = runtime.memory.due.ready(now);
    for (const row of rows) {
      const a = runtime.config.agents.find(
        (agent) => agent.id === row.agent_id,
      );
      const conversation = row.conversation;
      if (
        !a ||
        !allowed(a, conversation) ||
        !runtime.writable(a, conversation)
      ) {
        runtime.memory.due.defer(row, now + 30000);
        continue;
      }
      let s = this.state(a.id, conversation);
      const sleep = s.wakeConfig?.sleepUntil;
      if (sleep && sleep <= now) {
        s.wakeConfig.sleepUntil = null;
        this.write(a.id, conversation, s);
        this.request(a.id, conversation, "sleep", { immediate: true });
      }
      s = this.state(a.id, conversation);
      if (
        s.replyCheckAt &&
        s.replyCheckAt <= now &&
        !(s.proactiveCooldownUntil > now)
      ) {
        s.replyCheckAt = null;
        this.write(a.id, conversation, s);
        this.request(a.id, conversation, "replyCheck");
      }
      const result = this.flush(a.id, conversation);
      if (result.queued && !result.rateLimited) {
        // Busy/disconnected work waits for a lifecycle signal or a bounded retry.
        const current = runtime.memory.due.current(a.id, conversation);
        if (current?.next_due_at !== null && current?.next_due_at <= now)
          runtime.memory.due.defer(current, now + 30000);
      }
    }
    return { examined: rows.length };
  }
  cancel(agentId) {
    // Capabilities are aborted by Runtime first, so long polls resolve immediately.
    for (const [key, fn] of this.waiters)
      if (key.startsWith(agentId + "|")) fn();
  }
}
