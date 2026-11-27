// @ts-check
import { setImmediate } from "node:timers/promises";
import { roleRest, roleTurnBusy } from "../core/role-rest.mjs";
import { rhythmStatus } from "../core/rhythm.mjs";
import { prepared } from "../core/recall-boundary.mjs";
import { checkpoint } from "./store.mjs";
import {
  dreamSources,
  SOURCES,
  SOURCE_PARTITIONS,
  sourceRoleColumn,
} from "./source-filter.mjs";

const tenMinutes = 600000;
const minute = 60000;

/** @param {any} runtime @param {any} role */
export function dreamDaily(runtime, role) {
  const zone =
    role.behavior.rhythm.timezone || role.behavior.proactive.timezone;
  const day = new Intl.DateTimeFormat("en-CA", {
    timeZone: zone,
    year: "numeric",
    month: "numeric",
    day: "numeric",
  });
  const now = runtime.now(),
    today = day.format(now);
  const runs =
    /** @type {{mode:string,run_id:string,trigger:string,status:string,started_at:string,finished_at:string|null}[]} */ (
      prepared(
        runtime.memory.db,
        "SELECT mode,run_id,trigger,status,started_at,finished_at FROM dream_runs WHERE agent_id=? AND started_at>=? ORDER BY finished_at DESC,run_id",
      ).all(role.id, new Date(now - 48 * 60 * minute).toISOString())
    );
  const startedToday = runs.filter(
    (row) => day.format(new Date(row.started_at)) === today,
  );
  const stories = startedToday.filter((row) => row.mode === "imaginative");
  const lastDeep = runs.find(
    (row) =>
      row.mode === "deep" &&
      row.status === "COMMITTED" &&
      row.finished_at &&
      day.format(new Date(row.finished_at)) === today,
  );
  return {
    used: startedToday.length,
    deepCommitted: Boolean(lastDeep),
    lastDeepId: lastDeep?.run_id,
    lastDeepFinishedAt: lastDeep?.finished_at
      ? Date.parse(lastDeep.finished_at)
      : null,
    imaginativeUsed: stories.length,
    imaginativeIdle: stories.some((row) => row.trigger === "idle"),
  };
}

/** @param {any} runtime @param {string} agentId @param {number} [minimum] */
export async function dreamLag(runtime, agentId, minimum = Infinity) {
  const db = runtime.memory.db,
    { starts } = checkpoint(db, agentId);
  const limits = { ...starts };
  for (const partition of SOURCE_PARTITIONS) {
    const { from, cursor } = SOURCES[partition];
    const latest = prepared(
      db,
      `SELECT max(${cursor}) AS last FROM ${from} WHERE ${sourceRoleColumn(partition)}=?`,
    ).get(agentId);
    limits[partition] = Math.max(starts[partition], Number(latest?.last));
  }
  const source = dreamSources(
    runtime,
    { agentId, conversation: "@dream" },
    limits,
  );
  const result = { events: 0, diaries: 0, corrections: 0 };
  for (const partition of SOURCE_PARTITIONS) {
    let after = starts[partition];
    const threshold =
      minimum === Infinity || partition === "events" ? minimum : 1;
    while (after < limits[partition] && result[partition] < threshold) {
      // Complete each SQLite page before yielding; chat can write meanwhile.
      const page = [...source.scan(partition, after, 50)];
      for (const { item } of page) {
        if (!item) continue;
        if (
          partition !== "events" ||
          (item.kind === "message.received" && item.direction === "in") ||
          (item.kind === "message.sent" && item.direction === "out") ||
          item.kind === "action.confirmed" ||
          item.kind === "voice.transcript"
        )
          result[partition]++;
        if (result[partition] >= threshold) break;
      }
      if (page.length < 50 || result[partition] >= threshold) break;
      after = page[page.length - 1].seq;
      await setImmediate();
      if (runtime.closed) return result;
    }
  }
  return result;
}

/** @param {any} runtime @param {any} role @param {number} now @param {boolean} idle */
function longOpportunity(runtime, role, now, idle) {
  const db = runtime.memory.db;
  const active = prepared(
    db,
    "SELECT count(*) AS total, min(created_at) AS earliest FROM cognitions WHERE agent_id=? AND status='active'",
  ).get(role.id);
  const count = Number(active?.total);
  if (!count) return null;
  const success = prepared(
    db,
    `SELECT snapshot_version,changes_count,finished_at FROM dream_runs
    WHERE agent_id=? AND mode='long' AND status='COMMITTED' ORDER BY finished_at DESC,rowid DESC LIMIT 1`,
  ).get(role.id);
  if (count > role.dream.cognitive.longCognitionThreshold) {
    const { version } = checkpoint(db, role.id);
    const observedVersion =
      success &&
      Number(success.snapshot_version) +
        Number(Number(success.changes_count) > 0);
    if (observedVersion !== version) return /** @type {const} */ ("threshold");
  }
  if (!idle || !role.dream.cognitive.longWeekly) return null;
  const since = Date.parse(String(success?.finished_at ?? active?.earliest));
  if (now - since >= 7 * 24 * 60 * minute) return /** @type {const} */ ("idle");
  return null;
}

/** @param {any} runtime @param {any} role */
export function dreamPaused(runtime, role) {
  return runtime.memory.bind(role.id).state("@dream").paused === true;
}

const quietGates = new Set([
  "DREAM_DISABLED",
  "DREAM_ALREADY_RUNNING",
  "DREAM_BUDGET_EXCEEDED",
  "GLOBAL_PAUSED",
  "AGENT_PAUSED",
  "ISOLATED_MODE",
  "RUNTIME_CLOSING",
  "UPDATE_IN_PROGRESS",
  "RECONFIGURING",
  "BACKEND_UNAVAILABLE",
]);

export class DreamScheduler {
  /** @param {any} runtime */
  constructor(runtime) {
    this.runtime = runtime;
    this.started = runtime.now();
    this.next = this.started;
    this.scanning = false;
    /** @type {Map<string,number>} */
    this.lastActivity = new Map();
  }

  /** @param {string} agentId */
  activity(agentId) {
    this.lastActivity.set(agentId, this.runtime.now());
  }

  /** @param {unknown} error @param {string} [agentId] */
  report(error, agentId) {
    if (error instanceof Error && quietGates.has(error.message)) return;
    this.runtime.diagnostics.report(
      Error("DREAM_INTERRUPTED", { cause: error }),
      { component: "runtime", agentId },
    );
  }

  tick() {
    this.runtime.dreams.drainManual();
    const runtime = this.runtime,
      now = runtime.now();
    if (
      this.scanning ||
      now < this.next ||
      runtime.closed ||
      runtime.config.mode !== "live" ||
      runtime.config.globalPaused
    )
      return;
    this.next = now + minute;
    this.scanning = true;
    return runtime.trackWork(
      this.scan(now)
        .catch((/** @type {unknown} */ error) => this.report(error))
        .finally(() => {
          this.scanning = false;
        }),
    );
  }

  /** @param {any} role */
  available(role) {
    const runtime = this.runtime;
    return (
      role.dream.enabled &&
      (role.dream.cognitive.enabled || role.dream.imaginative.enabled) &&
      !role.paused &&
      !dreamPaused(runtime, role) &&
      !roleTurnBusy(runtime, role.id) &&
      !runtime.dreams.busy(role.id) &&
      ![...runtime.capabilities.values()].some(
        (/** @type {any} */ ctx) =>
          ctx.agentId === role.id && ctx.runtimeKind === "desktop",
      )
    );
  }

  /** @param {number} now */
  async scan(now) {
    const runtime = this.runtime;
    const opportunities = [];
    const longs = [];
    for (const role of runtime.config.agents) {
      if (!this.available(role)) continue;
      const daily = dreamDaily(runtime, role);
      if (daily.used >= role.dream.budget.maxRunsPerDay) continue;
      const lastActivity = this.lastActivity.get(role.id) ?? this.started;
      const idle = now - lastActivity >= role.dream.cognitive.napIdleMs;
      const rest = roleRest(runtime, role),
        rhythm = rhythmStatus(runtime, role);
      const sleeping =
        rhythm.state === "sleeping" && now - Number(rhythm.start) >= tenMinutes;
      const cognitive = role.dream.cognitive.enabled;
      const deep =
        cognitive &&
        role.dream.cognitive.deepDaily &&
        !daily.deepCommitted &&
        (sleeping ||
          (rhythm.state === "disabled" &&
            now - lastActivity >=
              Math.max(tenMinutes, role.dream.cognitive.napIdleMs)));
      const lag =
        cognitive && (idle || deep)
          ? await dreamLag(runtime, role.id, role.dream.cognitive.napMinEvents)
          : null;
      if (
        runtime.closed ||
        runtime.agent(role.id) !== role ||
        !this.available(role) ||
        (this.lastActivity.get(role.id) ?? this.started) !== lastActivity
      )
        continue;
      const asleep = rhythmStatus(runtime, role);
      const stillSleeping =
        asleep.state === "sleeping" && asleep.start === rhythm.start;
      if (
        deep &&
        (!sleeping || stillSleeping) &&
        lag &&
        (lag.events || lag.diaries || lag.corrections)
      ) {
        void runtime.dreams
          .run(role.id, {
            mode: "deep",
            trigger: sleeping ? (rest ? "rest" : "rhythm-sleep") : "idle",
          })
          .catch((/** @type {unknown} */ error) => this.report(error, role.id));
      } else if (
        idle &&
        lag &&
        (lag.events >= role.dream.cognitive.napMinEvents || lag.corrections)
      ) {
        void runtime.dreams
          .run(role.id, { mode: "nap", trigger: "idle" })
          .catch((/** @type {unknown} */ error) => this.report(error, role.id));
      } else {
        const trigger = cognitive
          ? longOpportunity(runtime, role, now, idle)
          : null;
        if (trigger) longs.push({ role, trigger });
        else if (role.dream.imaginative.enabled && (idle || daily.lastDeepId))
          opportunities.push({ role, idle, lastActivity });
      }
    }

    // Small and deep cognitive batches have priority over long consolidation.
    for (const { role, trigger } of longs) {
      if (
        !runtime.dreams.backgroundSlot ||
        runtime.closed ||
        runtime.maintenance.active ||
        !runtime.config.agents.includes(role) ||
        !this.available(role)
      )
        continue;
      void runtime.dreams
        .run(role.id, { mode: "long", trigger })
        .catch((/** @type {unknown} */ error) => this.report(error, role.id));
    }

    // Reserve cognitive work first across roles, regardless of configuration order.
    for (const { role, idle, lastActivity } of opportunities) {
      if (
        !runtime.dreams.backgroundSlot ||
        runtime.closed ||
        runtime.maintenance.active ||
        runtime.config.globalPaused ||
        runtime.config.mode !== "live" ||
        runtime.config.agents.find(
          (/** @type {{id:string}} */ agent) => agent.id === role.id,
        ) !== role ||
        !this.available(role) ||
        (this.lastActivity.get(role.id) ?? this.started) !== lastActivity
      )
        continue;
      const daily = dreamDaily(runtime, role);
      if (
        daily.used >= role.dream.budget.maxRunsPerDay ||
        daily.imaginativeUsed >= role.dream.imaginative.dailyMax
      )
        continue;
      const memory = runtime.memory.bind(role.id),
        state = memory.state("@dream");
      let trigger = /** @type {"threshold"|"idle"} */ ("idle");
      if (daily.lastDeepId && state.storyDeepRunId !== daily.lastDeepId) {
        memory.setState("@dream", {
          ...state,
          storyDeepRunId: daily.lastDeepId,
        });
        if (runtime.random() >= role.dream.imaginative.probability) continue;
        trigger = "threshold";
      } else {
        const rhythm = rhythmStatus(runtime, role);
        if (
          !idle ||
          daily.imaginativeIdle ||
          rhythm.state === "sleeping" ||
          rhythm.state === "rest-pending" ||
          (daily.lastDeepFinishedAt !== null &&
            lastActivity <= daily.lastDeepFinishedAt)
        )
          continue;
      }
      void runtime.dreams
        .run(role.id, { mode: "imaginative", trigger })
        .catch((/** @type {unknown} */ error) => this.report(error, role.id));
    }
  }
}
