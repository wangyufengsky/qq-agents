// @ts-check
import {
  zonedParts,
  zonedToUtc,
  addDays,
} from "../../vendor/scheduler/time.js";

/** @param {string} value */
const minutes = (value) =>
  Number(value.slice(0, 2)) * 60 + Number(value.slice(3));

/** The interval containing now, including the morning after a midnight crossing.
 * @param {any} behavior @param {number} now
 */
export function sleepWindow(behavior, now) {
  const rhythm = behavior.rhythm;
  if (!rhythm?.enabled) return null;
  const timezone = rhythm.timezone || behavior.proactive.timezone;
  const local = zonedParts(now, timezone);
  const start = minutes(rhythm.sleep.start),
    end = minutes(rhythm.sleep.end);
  const overnight = start > end;
  // Resolve wall-clock boundaries first. On a repeated DST hour the scheduler's
  // timezone helper selects the earlier occurrence; membership must use those
  // same absolute instants, not the wall-clock minute appearing a second time.
  for (const startDay of [local, addDays(local, -1)]) {
    const endDay = overnight ? addDays(startDay, 1) : startDay;
    const from = zonedToUtc(
      {
        ...startDay,
        hour: Math.floor(start / 60),
        minute: start % 60,
        second: 0,
      },
      timezone,
    );
    const until = zonedToUtc(
      { ...endDay, hour: Math.floor(end / 60), minute: end % 60, second: 0 },
      timezone,
    );
    if (now >= from && now < until)
      return { start: from, end: until, timezone };
  }
  return null;
}

/** One draw per sleep interval is shared by every chat and survives process restarts.
 * @param {any} runtime @param {any} agent @param {boolean} [persist]
 */
export function rhythmStatus(runtime, agent, persist = false) {
  const rhythm = agent.behavior.rhythm;
  if (!rhythm?.enabled) return { state: "disabled", label: "作息未开启" };
  const now = runtime.now(),
    memory = runtime.memory.bind(agent.id);
  const state = memory.state("@subject");
  const window = sleepWindow(agent.behavior, now);
  const key = JSON.stringify([rhythm, agent.behavior.proactive.timezone]);
  let saved = state.rhythmSleep;
  if (window && (saved?.start !== window.start || saved?.key !== key)) {
    saved = {
      ...window,
      key,
      until:
        window.end +
        Math.round((persist ? runtime.random() : 0) * rhythm.wakeJitterMs),
    };
    if (persist) memory.setState("@subject", { ...state, rhythmSleep: saved });
  }
  const sleeping =
    !!window || (saved?.key === key && saved.until > now && saved.start <= now);
  const timezone = rhythm.timezone || agent.behavior.proactive.timezone;
  if (sleeping) {
    const wake = new Intl.DateTimeFormat("zh-CN", {
      timeZone: timezone,
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).format(saved.until);
    return {
      state: "sleeping",
      label: `睡觉中，预计 ${wake} 起床`,
      until: saved.until,
      start: saved.start,
      end: saved.end,
      timezone,
    };
  }
  const local = zonedParts(now, timezone);
  const remaining =
    (minutes(rhythm.sleep.start) - local.hour * 60 - local.minute + 1440) %
    1440;
  return {
    state: remaining <= 30 ? "bedtime" : "awake",
    label: remaining <= 30 ? "快睡了" : "醒着",
    timezone,
  };
}

/** @param {any} agent @param {string} conversation */
export const urgentOwner = (agent, conversation) =>
  agent.behavior.rhythm?.urgentOwners &&
  conversation.startsWith("private:") &&
  agent.ownerIds.includes(conversation.slice(8));

/** Only postpones ordinary wakeups; it never grants a new wake or reply budget.
 * @param {any} runtime @param {any} agent @param {any} state @param {string} conversation
 * @param {{exempt?: boolean, direct?: boolean}} [options]
 */
export function deferForRhythm(
  runtime,
  agent,
  state,
  conversation,
  options = {},
) {
  const rhythm = agent.behavior.rhythm;
  if (state.rhythmBaseDueAt !== undefined)
    state.wakeDueAt = state.rhythmBaseDueAt;
  if (!rhythm?.enabled || options.exempt || urgentOwner(agent, conversation)) {
    resetRhythmState(state);
    return;
  }
  state.rhythmBaseDueAt ??= state.wakeDueAt;
  const now = runtime.now(),
    status = rhythmStatus(runtime, agent, true);
  if (status.state === "sleeping" && rhythm.sleepMode === "defer") {
    state.rhythmLateChecked = true;
    state.rhythmDeferredUntil = status.until;
    state.rhythmSleepPeriod = {
      start: status.start,
      end: status.end,
      timezone: status.timezone,
    };
    state.wakeDueAt = Math.max(state.wakeDueAt ?? now, status.until);
    return;
  }
  if (options.direct && status.state !== "sleeping") {
    delete state.rhythmLateUntil;
    state.rhythmLateChecked = true;
    return;
  }
  if (state.rhythmLateUntil !== undefined)
    state.wakeDueAt = Math.max(state.wakeDueAt ?? now, state.rhythmLateUntil);
  // Preserve the decision, including a no-delay draw, for this pending batch.
  if (state.rhythmLateChecked) return;
  state.rhythmLateChecked = true;
  if (
    status.state === "sleeping" ||
    runtime.random() < rhythm.lateReply.probability
  ) {
    const { minMs, maxMs } = rhythm.lateReply;
    state.rhythmLateUntil =
      now + minMs + Math.round(runtime.random() * (maxMs - minMs));
    state.wakeDueAt = Math.max(state.wakeDueAt ?? now, state.rhythmLateUntil);
  }
}

/** @param {any} runtime @param {any} agent @param {any} ctx */
export function rhythmEnvironment(runtime, agent, ctx) {
  if (!agent.behavior.rhythm?.enabled) return "";
  const status = rhythmStatus(runtime, agent);
  const label =
    status.state === "sleeping" && urgentOwner(agent, ctx.conversation)
      ? "睡觉中被主人叫醒"
      : status.label;
  const woke = ctx.rhythmWake;
  return (
    `当前作息：${label}。` +
    (woke
      ? `你刚起床，下面是睡觉期间收到的消息。睡觉时段：${new Date(woke.start).toISOString()} 至 ${new Date(woke.end).toISOString()}（${woke.timezone}）。`
      : "")
  );
}

/** Restore only the rhythm part; batching and rate-limit deadlines remain authoritative.
 * @param {any} state
 */
export function resetRhythmState(state) {
  if (state.rhythmBaseDueAt !== undefined)
    state.wakeDueAt = state.rhythmBaseDueAt;
  delete state.rhythmBaseDueAt;
  delete state.rhythmDeferredUntil;
  delete state.rhythmSleepPeriod;
  delete state.rhythmLateUntil;
  delete state.rhythmLateChecked;
}

/** Rebuild due indexes immediately on edits, even for wakes scheduled hours ahead.
 * @param {any} runtime @param {any} before @param {any} after
 */
export function refreshRhythm(runtime, before, after) {
  for (const agent of after.agents) {
    const old = before.agents.find((/** @type {any} */ a) => a.id === agent.id);
    const policy = (/** @type {any} */ a) =>
      JSON.stringify([
        a?.behavior.rhythm,
        a?.behavior.proactive.timezone,
        a?.ownerIds,
      ]);
    if (policy(old) === policy(agent)) continue;
    const memory = runtime.memory.bind(agent.id);
    for (const row of memory.db
      .prepare(
        "SELECT conversation,value FROM runtime WHERE agent_id=? AND json_extract(value,'$.pendingWakes[0]') IS NOT NULL",
      )
      .all(agent.id)) {
      const state = memory.state(row.conversation);
      resetRhythmState(state);
      deferForRhythm(runtime, agent, state, row.conversation, {
        exempt: state.pendingWakes.some(
          (/** @type {any} */ wake) => wake.taskRunId || wake.intentId,
        ),
        direct: state.rhythmDirect === true,
      });
      memory.setState(row.conversation, state);
    }
  }
}
