// @ts-check
import { randomUUID } from "node:crypto";
const json = (/** @type {string} */ s) => JSON.parse(s || "{}");
/** Atomic per-inference reservations; unknown attempts retain the full charge. */
export class SocialResources {
  /** @param {any} runtime @param {any} ctx */
  constructor(runtime, ctx) {
    this.runtime = runtime;
    this.ctx = ctx;
  }
  get store() {
    return this.runtime.homeSocial.store;
  }
  get db() {
    return this.store.db;
  }
  /** @param {any} args */
  async reserveInference(args) {
    return this.store.transaction((/** @type {number} */ now) => {
      this.runtime.socialRuntime.assertContext(this.ctx);
      const b = this.ctx.socialBinding,
        turn = this.db
          .prepare("SELECT * FROM home_social_turns WHERE id=?")
          .get(b.turnId);
      if (
        args.runId !== b.runId ||
        !Number.isSafeInteger(args.inputUpperBound) ||
        !Number.isSafeInteger(args.outputCap)
      )
        throw Error("SOCIAL_BUDGET_INVALID");
      const c = this.runtime.socialRuntime.limits(this.ctx),
        budget = c.resourceBudget,
        total = args.inputUpperBound + args.outputCap;
      if (!budget) throw Error("SOCIAL_BUDGET_INVALID");
      if (
        args.inputUpperBound <= 0 ||
        args.outputCap <= 0 ||
        args.inputUpperBound > budget.maxInputTokensPerInference ||
        args.outputCap > budget.maxOutputTokensPerInference
      )
        throw Error("SOCIAL_BUDGET_INVALID");
      const prior = this.db
        .prepare(
          "SELECT id FROM home_social_inference_reservations WHERE run_id=? AND request_id=?",
        )
        .get(b.runId, args.requestId);
      if (prior) return { reservationId: prior.id, claimed: false };
      const count = this.db
        .prepare(
          "SELECT count(*) AS n FROM home_social_inference_reservations WHERE run_id=?",
        )
        .get(b.runId).n;
      const day = new Date(now).toISOString().slice(0, 10);
      const usage = this.db
        .prepare(
          "SELECT * FROM home_social_usage WHERE actor_generation=? AND day=? AND scope='social' AND kind='tokens'",
        )
        .get(b.actorIdentity.generation, day);
      if (
        count >= budget.maxInferencesPerTurn ||
        (json(turn.resources_used).tokens || 0) +
          (json(turn.resources_reserved).tokens || 0) +
          total >
          budget.maxTokensPerTurn ||
        (usage?.used || 0) + (usage?.reserved || 0) + total >
          budget.maxTokensPerDay
      )
        throw Error("SOCIAL_RESOURCE_LIMIT");
      if (b.windowId) {
        const w = this.db
          .prepare("SELECT * FROM home_social_windows WHERE id=?")
          .get(b.windowId);
        if (
          (json(w.resources_used).tokens || 0) +
            (json(w.resources_reserved).tokens || 0) +
            total >
          budget.maxTokensPerWindow
        )
          throw Error("SOCIAL_RESOURCE_LIMIT");
      }
      const id = randomUUID();
      this.db
        .prepare(
          "INSERT INTO home_social_inference_reservations(id,run_id,request_id,turn_id,actor_generation,mode,status,reserved,created_at) VALUES(?,?,?,?,?,?,'reserved',?,?)",
        )
        .run(
          id,
          b.runId,
          args.requestId,
          b.turnId,
          b.actorIdentity.generation,
          b.runMode,
          JSON.stringify({
            tokens: total,
            day,
            inputTokens: args.inputUpperBound,
            outputTokens: args.outputCap,
          }),
          now,
        );
      this.delta(turn, day, total, 0);
      return { reservationId: id, claimed: true };
    });
  }
  /** @param {any} turn @param {string} day @param {number} reserved @param {number} used */
  delta(turn, day, reserved, used) {
    const u = json(turn.resources_used),
      r = json(turn.resources_reserved);
    this.db
      .prepare(
        "UPDATE home_social_turns SET resources_used=?,resources_reserved=? WHERE id=?",
      )
      .run(
        JSON.stringify({ tokens: (u.tokens || 0) + used }),
        JSON.stringify({ tokens: (r.tokens || 0) + reserved }),
        turn.id,
      );
    this.db
      .prepare(
        "INSERT OR IGNORE INTO home_social_usage(actor_generation,day,scope,kind,used,reserved) VALUES(?,?,'social','tokens',0,0)",
      )
      .run(turn.actor_generation, day);
    this.db
      .prepare(
        "UPDATE home_social_usage SET used=used+?,reserved=reserved+? WHERE actor_generation=? AND day=? AND scope='social' AND kind='tokens'",
      )
      .run(used, reserved, turn.actor_generation, day);
    if (turn.window_id) {
      const w = this.db
        .prepare("SELECT * FROM home_social_windows WHERE id=?")
        .get(turn.window_id);
      this.db
        .prepare(
          "UPDATE home_social_windows SET resources_used=?,resources_reserved=? WHERE id=?",
        )
        .run(
          JSON.stringify({
            tokens: (json(w.resources_used).tokens || 0) + used,
          }),
          JSON.stringify({
            tokens: (json(w.resources_reserved).tokens || 0) + reserved,
          }),
          w.id,
        );
    }
  }
  /** @param {any} args */
  async settleInference(args) {
    return this.store.transaction((/** @type {number} */ now) => {
      const row = this.db
          .prepare(
            "SELECT * FROM home_social_inference_reservations WHERE id=?",
          )
          .get(args.reservationId),
        b = this.ctx.socialBinding;
      if (!row || row.run_id !== b.runId) throw Error("IDENTITY_DENIED");
      if (row.status !== "reserved")
        return { status: row.status, historicalReplay: true };
      const r = json(row.reserved),
        turn = this.db
          .prepare("SELECT * FROM home_social_turns WHERE id=?")
          .get(b.turnId);
      let status = args.status,
        actual = 0;
      if (!["completed", "not_started", "unknown"].includes(status))
        throw Error("SOCIAL_BUDGET_INVALID");
      if (status === "completed") {
        const u = args.usage;
        if (
          !u ||
          !Number.isSafeInteger(u.inputTokens) ||
          !Number.isSafeInteger(u.outputTokens) ||
          u.inputTokens < 0 ||
          u.outputTokens < 0 ||
          u.inputTokens > r.inputTokens ||
          u.outputTokens > r.outputTokens
        )
          status = "unknown";
        else actual = u.inputTokens + u.outputTokens;
      }
      this.db
        .prepare(
          "UPDATE home_social_inference_reservations SET status=?,actual=?,settled_at=? WHERE id=?",
        )
        .run(
          status,
          status === "completed" ? JSON.stringify({ tokens: actual }) : null,
          now,
          row.id,
        );
      if (status !== "unknown") this.delta(turn, r.day, -r.tokens, actual);
      return { status };
    });
  }
}
