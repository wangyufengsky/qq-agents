import { looksLikeUnfinished } from "../../vendor/legacy/v2-wait.js";
import { allowed } from "./config.mjs";

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
  proactive: 20,
  scheduled: 95,
  join: 45,
};
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
  reason(a, e, accountId) {
    const wc = {
      ...a.wake,
      ...this.state(a.id, e.conversation).wakeConfig?.triggers,
    };
    if (e.kind === "notice.poke") return wc.poke ? "poke" : null;
    if (e.kind === "notice.join") return wc.joins ? "join" : null;
    if (e.kind !== "message.received") return null;
    if (wc.private && e.conversation.startsWith("private:")) return "private";
    if (
      wc.mentions &&
      e.segments.some(
        (s) => s.type === "at" && String(s.data?.qq) === accountId,
      )
    )
      return "mention";
    if (wc.questions && /[?？]/.test(e.body)) return "question";
    if (wc.speakerIds?.includes(e.senderId)) return "speaker";
    if (wc.names && [a.name, ...a.aliases].some((n) => e.body.includes(n)))
      return "name";
    if (wc.keywords?.some((w) => e.body.includes(w))) return "keyword";
    return this.runtime.random() < wc.participation ? "message" : null;
  }
  request(
    id,
    conversation,
    reason,
    { seq = 0, instruction = "", taskRunId = null, immediate = false } = {},
  ) {
    const a = this.runtime.agent(id),
      state = this.state(id, conversation),
      now = this.now();
    state.pendingWakes ||= [];
    const existing = state.pendingWakes.find(
      (x) => x.reason === reason && x.taskRunId === taskRunId,
    );
    if (existing) existing.seq = Math.max(existing.seq, seq);
    else
      state.pendingWakes.push({ reason, seq, instruction, taskRunId, at: now });
    // Never discard a persisted scheduled instruction when coalescing ordinary chat wakes.
    const tasks = state.pendingWakes.filter((x) => x.taskRunId),
      ordinary = state.pendingWakes.filter((x) => !x.taskRunId).slice(-20);
    state.pendingWakes = [...tasks, ...ordinary];
    state.wakeDueAt ??= immediate ? now : now + a.behavior.batchWindowMs;
    if (immediate) state.wakeDueAt = Math.min(state.wakeDueAt, now);
    this.write(id, conversation, state);
    return this.flush(id, conversation);
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
    const pending = state.pendingWakes.filter(
      (x) => x.taskRunId || !x.seq || x.seq > (state.readThroughSeq || 0),
    );
    state.pendingWakes = [];
    delete state.wakeDueAt;
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
      ctx.confirmedSends
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
      const messages = runtime.memory.bind(a.id).conversation(
        {
          conversation: ctx.conversation,
          afterSeq: from,
          limit: 50,
          maxChars: 16000,
        },
        ctx.conversation,
      );
      ctx.shownSeq = Math.max(ctx.shownSeq, messages.readThroughSeq || 0);
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
    for (const a of runtime.config.agents) {
      const mem = runtime.memory.bind(a.id),
        rows = mem.db
          .prepare("SELECT conversation,value FROM runtime WHERE agent_id=?")
          .all(a.id);
      for (const row of rows) {
        const conversation = row.conversation;
        if (!allowed(a, conversation) || !runtime.writable(a, conversation))
          continue;
        let s = this.state(a.id, conversation);
        const sleep = s.wakeConfig?.sleepUntil;
        if (sleep && sleep <= now) {
          s.wakeConfig.sleepUntil = null;
          this.write(a.id, conversation, s);
          this.request(a.id, conversation, "sleep", { immediate: true });
        }
        s = this.state(a.id, conversation);
        if (s.replyCheckAt && s.replyCheckAt <= now) {
          s.replyCheckAt = null;
          this.write(a.id, conversation, s);
          this.request(a.id, conversation, "replyCheck");
        }
        s = this.state(a.id, conversation);
        const p = a.behavior.proactive;
        if (p.enabled && (!s.nextProactiveAt || s.nextProactiveAt <= now)) {
          const due = !!s.nextProactiveAt;
          s.nextProactiveAt =
            now + p.minMs + Math.floor(runtime.random() * (p.maxMs - p.minMs));
          this.write(a.id, conversation, s);
          const hour = Number(
            new Intl.DateTimeFormat("en", {
              timeZone: p.timezone,
              hour: "2-digit",
              hourCycle: "h23",
            }).format(new Date(now)),
          );
          let chance = p.probability;
          if (hour >= 23 || hour < 8) chance *= p.nightFactor;
          if (s.lastAiReplyAt && now - s.lastAiReplyAt < 1800000) chance *= 0.5;
          if ((s.sendTimes || []).filter((x) => now - x < 3600000).length >= 5)
            chance *= 0.3;
          if (
            due &&
            now - (s.lastIncomingAt || now) >= p.idleMs &&
            !runtime.running.has(a.id + "|" + conversation) &&
            runtime.random() < chance
          )
            this.request(a.id, conversation, "proactive");
        }
        this.flush(a.id, conversation);
      }
    }
  }
  cancel(agentId) {
    // Capabilities are aborted by Runtime first, so long polls resolve immediately.
    for (const [key, fn] of this.waiters)
      if (key.startsWith(agentId + "|")) fn();
  }
}
