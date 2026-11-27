// @ts-check
import { z } from "zod";
import { prepared } from "../core/recall-boundary.mjs";
import { dreamAgentProfile } from "../core/functional-agents.mjs";
import { dreamDaily, dreamLag, dreamPaused } from "./scheduler.mjs";
import {
  deleteCognition,
  listCognitions,
  rollbackCognition,
} from "./store.mjs";
import { category, scopeId } from "./validator.mjs";

const roleId = z.string().min(1);
const version = z.number().int().min(1);
const queryOptions = z.strictObject({
  category: category.optional(),
  scopeId: scopeId.optional(),
  status: z.enum(["active", "archived", "disputed"]).optional(),
  query: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});

/** @param {ReturnType<typeof dreamAgentProfile>} profile */
function overviewProfile(profile) {
  return {
    enabled: Boolean(profile),
    backendId: profile?.backend.id ?? null,
    model: profile?.definition.model ?? null,
    dedicated: profile?.backend.functionalAgentOnly === true,
  };
}

const conflicts = new Set([
  "DREAM_DISABLED",
  "DREAM_ALREADY_RUNNING",
  "DREAM_BUDGET_EXCEEDED",
  "DREAM_MODE_MISMATCH",
  "DREAM_VERSION_CONFLICT",
  "DREAM_DUPLICATE_SUBJECT_KEY",
  "DREAM_ROLLBACK_FAILED",
  "ISOLATED_MODE",
  "GLOBAL_PAUSED",
  "AGENT_PAUSED",
]);

/** @param {any} runtime @param {string|undefined} method @param {URL} url @param {(limit:number)=>Promise<unknown>} readBody */
export async function dreamAdmin(runtime, method, url, readBody) {
  const params = Object.fromEntries(url.searchParams),
    path = url.pathname;
  const db = runtime.memory.db;
  const send = (/** @type {unknown} */ result, status = 200) => ({
    result,
    status,
  });
  const agentFromQuery = () => runtime.agent(roleId.parse(params.agentId));
  const revisionPath =
    /^\/api\/dreams\/cognitions\/([a-z0-9-]+)\/(revisions|rollback)$/.exec(
      path,
    );
  const deletePath = /^\/api\/dreams\/cognitions\/([a-z0-9-]+)$/.exec(path);
  try {
    if (method === "GET" && path === "/api/dreams/overview") {
      const agent = agentFromQuery();
      const cognitive = overviewProfile(
        dreamAgentProfile(agent, runtime.config),
      );
      const imaginative = overviewProfile(
        dreamAgentProfile(agent, runtime.config, "dream-imaginative"),
      );
      const daily = dreamDaily(runtime, agent);
      return send({
        ...(cognitive.enabled ? cognitive : imaginative),
        cognitive,
        imaginative: {
          ...imaginative,
          used: daily.imaginativeUsed,
          limit: agent.dream.imaginative.dailyMax,
        },
        paused: dreamPaused(runtime, agent),
        mode: runtime.config.mode,
        globalPaused: runtime.config.globalPaused,
        rolePaused: agent.paused,
        used: daily.used,
        limit: agent.dream.budget.maxRunsPerDay,
        lag: await dreamLag(runtime, agent.id),
        busy: runtime.dreams.busy(agent.id),
      });
    }
    if (method === "GET" && path === "/api/dreams/cognitions") {
      const agent = agentFromQuery();
      const { agentId: _ignored, ...query } = params;
      const filters = queryOptions.parse(query);
      const rows = listCognitions(db, agent.id, {
        ...filters,
        limit: filters.limit + 1,
      });
      return send({
        items: rows.slice(0, filters.limit),
        nextOffset:
          rows.length > filters.limit ? filters.offset + filters.limit : null,
      });
    }
    if (method === "GET" && path === "/api/dreams/correction") {
      const agent = agentFromQuery();
      return send(
        runtime.memory.bind(agent.id).corrections.get(roleId.parse(params.id)),
      );
    }
    if (method === "GET" && path === "/api/dreams/runs") {
      const agent = agentFromQuery();
      return send({
        items: prepared(
          db,
          "SELECT * FROM dream_runs WHERE agent_id=? ORDER BY created_at DESC,rowid DESC LIMIT 20",
        ).all(agent.id),
      });
    }
    if (method === "GET" && path === "/api/dreams/stories") {
      const agent = agentFromQuery();
      return send({
        items: prepared(
          db,
          "SELECT * FROM imaginative_dreams WHERE agent_id=? ORDER BY created_at DESC,dream_id LIMIT 20",
        ).all(agent.id),
      });
    }
    if (method === "GET" && revisionPath?.[2] === "revisions") {
      const agent = agentFromQuery(),
        id = revisionPath[1];
      const cognition = prepared(
        db,
        "SELECT * FROM cognitions WHERE agent_id=? AND id=?",
      ).get(agent.id, id);
      if (!cognition) return send({ error: "RECORD_NOT_FOUND" }, 404);
      const rows = prepared(
        db,
        "SELECT * FROM cognition_revisions WHERE agent_id=? AND cognition_id=? ORDER BY version DESC",
      ).all(agent.id, id);
      const evidence = prepared(
        db,
        "SELECT * FROM cognition_evidence WHERE agent_id=? AND cognition_id=? ORDER BY cognition_version DESC,source_id",
      ).all(agent.id, id);
      const links = prepared(
        db,
        "SELECT * FROM cognition_links WHERE agent_id=? AND (from_id=? OR to_id=?) ORDER BY created_at DESC",
      ).all(agent.id, id, id);
      return send({ cognition, items: rows, evidence, links });
    }
    if (method === "POST" && revisionPath?.[2] === "rollback") {
      const input = z
        .strictObject({ agentId: roleId, version, expectedVersion: version })
        .parse(await readBody(8192));
      return send(
        rollbackCognition(
          runtime,
          runtime.agent(input.agentId).id,
          revisionPath[1],
          input,
        ),
      );
    }
    if (method === "DELETE" && deletePath) {
      const input = z
        .strictObject({ agentId: roleId, expectedVersion: version })
        .parse(await readBody(8192));
      return send(
        deleteCognition(
          runtime,
          runtime.agent(input.agentId).id,
          deletePath[1],
          input.expectedVersion,
        ),
      );
    }
    if (method === "POST" && path === "/api/dreams/pause") {
      const input = z
        .strictObject({ agentId: roleId, paused: z.boolean() })
        .parse(await readBody(8192));
      const memory = runtime.memory.bind(runtime.agent(input.agentId).id);
      memory.setState("@dream", {
        ...memory.state("@dream"),
        paused: input.paused,
      });
      if (input.paused) runtime.dreams.pause(input.agentId);
      return send({ paused: input.paused });
    }
    if (method === "POST" && path === "/api/dreams/trigger") {
      const { agentId, mode } = z
        .strictObject({
          agentId: roleId,
          mode: z.enum(["nap", "deep", "long", "imaginative"]),
        })
        .parse(await readBody(8192));
      return send(runtime.dreams.trigger(agentId, mode), 202);
    }
    return send({ error: "NOT_FOUND" }, 404);
  } catch (error) {
    if (error instanceof Error && conflicts.has(error.message))
      return send({ error: error.message }, 409);
    throw error;
  }
}
