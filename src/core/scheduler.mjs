import { randomUUID } from "node:crypto";
import { allowed, inSilence } from "./config.mjs";
import {
  normalizeSchedule,
  nextOccurrence,
  previewOccurrences,
  describeSchedule,
  seededRandom,
} from "../../vendor/scheduler/schedule.js";
import {
  dateKey,
  isValidTimeZone,
  zonedParts,
  describeInstant,
} from "../../vendor/scheduler/time.js";
import {
  parseRemindCommand,
  formatTaskList,
  REMIND_HELP,
} from "../../vendor/scheduler/commands.js";

const sourceKey = "@scheduler";
const sensitive = (s) =>
  /(?:sk-|gh[pousr]_|Bearer\s)[A-Za-z0-9_-]{16,}|\/(?:Users|home)\/|-----BEGIN .*PRIVATE KEY/.test(
    s,
  );
export class TaskScheduler {
  constructor(runtime) {
    this.runtime = runtime;
    for (const a of runtime.config.agents) {
      const s = this.state(a.id),
        interrupted = new Set();
      for (const run of s.history)
        if (["reserved", "running", "queued"].includes(run.status)) {
          run.status = "unknown";
          run.reason = "RESTART_INTERRUPTED_DO_NOT_REPLAY";
          interrupted.add(run.id);
        }
      if (interrupted.size) {
        this.save(a.id, s);
        const mem = runtime.memory.bind(a.id);
        for (const row of mem.db
          .prepare("SELECT conversation,value FROM runtime WHERE agent_id=?")
          .all(a.id)) {
          const state = JSON.parse(row.value);
          if (state.pendingWakes)
            mem.setState(row.conversation, {
              ...state,
              pendingWakes: state.pendingWakes.filter(
                (w) => !interrupted.has(w.taskRunId),
              ),
            });
        }
      }
    }
  }
  state(id) {
    const s = this.runtime.memory.bind(id).state(sourceKey);
    if (s.version && s.version !== 1)
      throw Error("SCHEDULER_VERSION_UNSUPPORTED");
    return {
      version: 1,
      nextId: 1,
      tasks: [],
      history: [],
      counters: {},
      ...s,
    };
  }
  save(id, s) {
    s.history = s.history.slice(-1000);
    this.runtime.memory.bind(id).setState(sourceKey, s);
  }
  authorize(id, ctx) {
    const a = this.runtime.agent(id);
    if (ctx) {
      this.runtime.assertActive(ctx);
      if (
        ctx.agentId !== id ||
        !ctx.conversation.startsWith("private:") ||
        !a.ownerIds.includes(ctx.conversation.split(":")[1])
      )
        throw Error("OWNER_PRIVATE_ONLY");
      if (!a.scheduler.allowAiPrivate) throw Error("AI_SCHEDULING_DISABLED");
      this.runtime.assertDisclosure(ctx);
    }
    return a;
  }
  list(id, ctx) {
    this.authorize(id, ctx);
    return this.state(id)
      .tasks.filter((t) => !ctx || t.ownerConversation === ctx.conversation)
      .map((t) => ({
        ...t,
        scheduleText: describeSchedule(t.schedule),
        nextRunText: t.scheduledAt
          ? describeInstant(t.scheduledAt, t.timezone)
          : null,
      }));
  }
  preview(id, input) {
    const a = this.runtime.agent(id),
      schedule = normalizeSchedule(input.schedule),
      tz = input.timezone || a.scheduler.timezone;
    if (!isValidTimeZone(tz)) throw Error("INVALID_TIMEZONE");
    return previewOccurrences(schedule, this.runtime.now(), 5, {
      tz,
      seed: input.seed || "preview",
      holidays: new Set(a.scheduler.holidays),
    }).map((at) => ({
      at,
      text: describeInstant(at, tz),
      silenced:
        inSilence(a, new Date(at)) ||
        (input.targets || []).some((target) => this.quiet(a, target, at)),
    }));
  }
  validate(id, input, ctx, old = {}) {
    const a = this.authorize(id, ctx),
      p = a.scheduler;
    const t = { ...old, ...input };
    if (!["text", "ai"].includes(t.kind)) throw Error("INVALID_TASK_KIND");
    if (typeof t.name !== "string" || t.name.length > 100)
      throw Error("INVALID_TASK_NAME");
    t.text = t.kind === "text" ? String(t.text || "") : "";
    t.instruction = t.kind === "ai" ? String(t.instruction || "") : "";
    if (
      !(t.text || t.instruction) ||
      t.text.length > 2000 ||
      t.instruction.length > 1000 ||
      sensitive(JSON.stringify(t))
    )
      throw Error("INVALID_TASK_CONTENT");
    t.targets = [...new Set(t.targets || [ctx?.conversation].filter(Boolean))];
    if (
      !t.targets.length ||
      t.targets.length > 10 ||
      t.targets.some((x) => !allowed(a, x))
    )
      throw Error("TASK_TARGET_NOT_ALLOWED");
    if (
      ctx &&
      t.targets.some((x) => x !== ctx.conversation) &&
      !p.allowAiOtherTargets
    )
      throw Error("AI_OTHER_TARGETS_DISABLED");
    t.schedule = normalizeSchedule(t.schedule);
    if (ctx && t.schedule.type === "cron") throw Error("CRON_ADMIN_ONLY");
    t.timezone = t.timezone || p.timezone;
    if (!isValidTimeZone(t.timezone)) throw Error("INVALID_TIMEZONE");
    t.seed = old.seed || randomUUID();
    t.maxRuns = t.maxRuns ?? null;
    if (
      t.maxRuns !== null &&
      (!Number.isSafeInteger(t.maxRuns) || t.maxRuns < 1 || t.maxRuns > 100000)
    )
      throw Error("INVALID_MAX_RUNS");
    t.missedPolicy = t.missedPolicy || "grace";
    if (!["skip", "grace"].includes(t.missedPolicy))
      throw Error("INVALID_MISSED_POLICY");
    t.jitterMin = t.jitterMin ?? p.jitterMin;
    if (
      !Number.isSafeInteger(t.jitterMin) ||
      t.jitterMin < 0 ||
      t.jitterMin > 30
    )
      throw Error("INVALID_JITTER");
    if (typeof t.enabled !== "boolean" && t.enabled !== undefined)
      throw Error("INVALID_ENABLED");
    t.enabled = t.enabled !== false;
    // Every edit to an AI's non-owner-target task requires renewed approval, including re-enabling it.
    t.pendingConfirm = !!ctx && t.targets.some((x) => x !== ctx.conversation);
    if (t.pendingConfirm) t.enabled = false;
    const next = this.preview(id, t);
    if (t.schedule.type === "once" && !next.length)
      throw Error("TASK_TIME_IN_PAST");
    for (let i = 1; i < next.length; i++)
      if (next[i].at - next[i - 1].at < p.minIntervalMin * 60000)
        throw Error("TASK_INTERVAL_TOO_SHORT");
    return t;
  }
  advance(a, t, after) {
    t.scheduledAt = nextOccurrence(t.schedule, after, {
      tz: t.timezone,
      seed: t.seed,
      holidays: new Set(a.scheduler.holidays),
    });
    t.nextRunAt = t.scheduledAt;
    if (
      t.nextRunAt !== null &&
      !["dailyRandom", "monthlyRandom", "interval"].includes(t.schedule.type)
    )
      t.nextRunAt += Math.round(
        (seededRandom(t.seed + "|" + t.scheduledAt)() * 2 - 1) *
          t.jitterMin *
          60000,
      );
    if (t.nextRunAt !== null) t.nextRunAt = Math.max(after + 1, t.nextRunAt);
  }
  audit(id, action, t) {
    this.runtime.memory.bind(id).append({
      dedupe: "schedule-audit:" + randomUUID(),
      conversation: t.ownerConversation || "@admin",
      kind: "schedule." + action,
      direction: "internal",
      body: t.name || "定时任务",
      payload: { taskId: t.id, targets: t.targets },
    });
  }
  create(id, input, ctx) {
    const a = this.authorize(id, ctx),
      s = this.state(id);
    if (s.tasks.length >= a.scheduler.maxTasks) throw Error("TASK_LIMIT");
    const t = this.validate(id, input, ctx);
    Object.assign(t, {
      id: s.nextId++,
      runs: 0,
      createdAt: this.runtime.now(),
      ownerConversation: ctx?.conversation || null,
      createdBy: ctx ? "owner-ai" : "admin",
    });
    this.advance(a, t, this.runtime.now());
    s.tasks.push(t);
    this.save(id, s);
    this.audit(id, "created", t);
    return t;
  }
  update(id, taskId, patch, ctx) {
    this.authorize(id, ctx);
    const s = this.state(id),
      i = s.tasks.findIndex((t) => t.id === taskId),
      old = s.tasks[i];
    if (!old || (ctx && old.ownerConversation !== ctx.conversation))
      throw Error("TASK_NOT_FOUND");
    const t = this.validate(id, patch, ctx, old);
    this.advance(this.runtime.agent(id), t, this.runtime.now());
    s.tasks[i] = t;
    this.save(id, s);
    this.audit(id, "updated", t);
    return t;
  }
  remove(id, taskId, ctx) {
    this.authorize(id, ctx);
    const s = this.state(id),
      t = s.tasks.find((t) => t.id === taskId);
    if (!t || (ctx && t.ownerConversation !== ctx.conversation))
      throw Error("TASK_NOT_FOUND");
    s.tasks = s.tasks.filter((x) => x.id !== taskId);
    this.save(id, s);
    this.audit(id, "deleted", t);
    return { removed: taskId };
  }
  quiet(a, conversation, now) {
    const p = a.scheduler;
    if (!p.quietEnabled || !conversation.startsWith("group:")) return false;
    const parts = zonedParts(now, p.timezone),
      n = parts.hour * 60 + parts.minute;
    const minutes = (s) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3));
    const start = minutes(p.quietStart),
      end = minutes(p.quietEnd);
    return start === end
      ? false
      : start < end
        ? n >= start && n < end
        : n >= start || n < end;
  }
  reserve(id, taskId, { manual = false, requestId } = {}) {
    const a = this.runtime.agent(id),
      s = this.state(id),
      t = s.tasks.find((t) => t.id === taskId),
      now = this.runtime.now();
    if (!t) throw Error("TASK_NOT_FOUND");
    const occurrence = manual ? "manual:" + requestId : String(t.scheduledAt);
    const existing = s.history.filter(
      (r) => r.occurrence === occurrence && r.taskId === t.id,
    );
    if (existing.length) return existing;
    const day = dateKey(now, a.scheduler.timezone),
      c = s.counters[day] || { total: 0, perTask: {}, perTarget: {} };
    s.counters = { [day]: c };
    let common = null;
    if (!a.scheduler.enabled) common = "SCHEDULER_DISABLED";
    else if (
      !manual &&
      now - t.nextRunAt >
        (t.missedPolicy === "skip" ? 60000 : a.scheduler.missedGraceMin * 60000)
    )
      common = "MISSED";
    else if ((c.perTask[t.id] || 0) >= a.scheduler.perTaskPerDay)
      common = "TASK_DAILY_LIMIT";
    const results = t.targets.map((target) => {
      let reason = common;
      if (!reason && !this.runtime.writable(a, target))
        reason = "PAUSED_OR_SILENCED";
      if (!reason && !manual && this.quiet(a, target, now))
        reason = "QUIET_HOURS";
      if (!reason && c.total >= a.scheduler.totalPerDay)
        reason = "TOTAL_DAILY_LIMIT";
      if (
        !reason &&
        target.startsWith("group:") &&
        (c.perTarget[target] || 0) >= a.scheduler.perGroupPerDay
      )
        reason = "GROUP_DAILY_LIMIT";
      if (!reason) {
        c.total++;
        c.perTarget[target] = (c.perTarget[target] || 0) + 1;
      }
      return {
        id: randomUUID(),
        taskId: t.id,
        occurrence,
        target,
        at: now,
        status: reason
          ? reason === "MISSED"
            ? "missed"
            : "skipped"
          : "reserved",
        reason,
        kind: t.kind,
        instruction: t.instruction,
        text: t.text,
      };
    });
    c.perTask[t.id] = (c.perTask[t.id] || 0) + 1;
    if (!manual) {
      t.runs++;
      this.advance(a, t, Math.max(now, t.scheduledAt));
      if (t.nextRunAt === null || (t.maxRuns !== null && t.runs >= t.maxRuns))
        t.enabled = false;
    }
    s.history.push(...results);
    this.save(id, s);
    // Reservation and next occurrence are durable before the first network or model operation.
    for (const r of results)
      if (r.status === "reserved")
        this.runtime.trackJob(this.dispatch(id, r), id);
    return results;
  }
  async dispatch(id, run) {
    const a = this.runtime.agent(id);
    if (!this.runtime.writable(a, run.target)) {
      this.finish(id, run.id, "skipped", "PAUSED_OR_SILENCED");
      return;
    }
    if (run.kind === "ai") {
      this.finish(id, run.id, "queued");
      this.runtime.conversations.request(id, run.target, "scheduled", {
        instruction: run.instruction,
        taskRunId: run.id,
        immediate: true,
      });
    } else {
      this.finish(id, run.id, "running");
      try {
        const result = await this.runtime.withContext(id, run.target, (ctx) =>
          this.runtime.send(ctx, {
            requestId: "schedule:" + run.id,
            text: run.text,
          }),
        );
        this.finish(id, run.id, result.status);
      } catch (e) {
        this.finish(
          id,
          run.id,
          e.message === "DELIVERY_UNKNOWN" ? "unknown" : "failed",
          e.message,
        );
      }
    }
  }
  finish(id, runId, status, reason = "") {
    const s = this.state(id),
      r = s.history.find((x) => x.id === runId);
    if (!r) return;
    Object.assign(r, { status, reason, updatedAt: this.runtime.now() });
    this.save(id, s);
  }
  tick() {
    if (this.runtime.config.mode !== "live") return;
    for (const a of this.runtime.config.agents) {
      if (!a.scheduler.enabled) continue;
      for (const t of this.state(a.id).tasks)
        if (
          t.enabled &&
          t.nextRunAt !== null &&
          t.nextRunAt <= this.runtime.now()
        )
          this.reserve(a.id, t.id);
    }
  }
  runNow(id, taskId, requestId) {
    if (!requestId || typeof requestId !== "string" || requestId.length > 100)
      throw Error("REQUEST_ID_REQUIRED");
    if (this.runtime.config.mode !== "live") throw Error("ISOLATED_MODE");
    return this.reserve(id, taskId, { manual: true, requestId });
  }
  async command(a, e, archived) {
    const cmd = parseRemindCommand(e.body, {
      now: this.runtime.now(),
      tz: a.scheduler.timezone,
    });
    if (!cmd) return false;
    if (!this.runtime.writable(a, e.conversation))
      return this.runtime.skipOwnerCommand(a, e, archived, "scheduler");
    let text;
    try {
      if (cmd.error) text = cmd.error;
      else if (cmd.action === "help") text = REMIND_HELP;
      else if (cmd.action === "list") text = formatTaskList(this.list(a.id));
      else if (cmd.action === "add") {
        const task = this.create(a.id, {
          ...cmd.task,
          targets: [e.conversation],
        });
        text = `已登记 #${task.id} ${task.name}；${describeInstant(task.scheduledAt, task.timezone)}`;
      } else if (cmd.action === "delete") {
        this.remove(a.id, cmd.id);
        text = "任务已删除";
      } else if (["enable", "disable"].includes(cmd.action)) {
        this.update(a.id, cmd.id, { enabled: cmd.action === "enable" });
        text = "任务状态已更新";
      } else {
        this.runNow(a.id, cmd.id, archived.id);
        text = "执行请求已登记，请查看执行记录；此确认不代表已投递。";
      }
    } catch (error) {
      const failure = this.runtime.diagnostics.report(error, {
        component: "scheduler",
        agentId: a.id,
        conversation: e.conversation,
      });
      text =
        failure.status >= 500
          ? "定时操作遇到系统故障，请在管理台查看最近错误。"
          : "定时命令未成功，请在管理台检查规则、白名单和状态。";
    }
    await this.runtime.withContext(a.id, e.conversation, (ctx) =>
      this.runtime.send(ctx, {
        requestId: "remind-reply:" + archived.id,
        text,
      }),
    );
    return true;
  }
}
