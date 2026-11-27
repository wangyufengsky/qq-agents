// @ts-check
import { setImmediate } from "node:timers/promises";
import { randomBytes, randomUUID } from "node:crypto";
import { resolveFunctionalAgent } from "../core/functional-agents.mjs";
import { resolveFunctionalContract } from "../core/functional-contracts.mjs";
import { knownErrorCodes } from "../core/error-codes.mjs";
import { DREAM_LIST, DREAM_SUBMIT } from "../tools/names.mjs";
import {
  SOURCE_PARTITIONS,
  dreamSources,
  visibleSource,
} from "./source-filter.mjs";
import {
  commitDream,
  failDream,
  listCognitions,
  planDreamPatch,
  recoverDreamRuns,
  startDream,
  visibleCognitionEvidence,
} from "./store.mjs";

/** @typedef {import("./store.mjs").Snapshot} Snapshot */
/** @typedef {import("./source-filter.mjs").DreamSource} Source */

export class DreamRunner {
  /** @type {Map<string, object>} */
  #active = new Map();
  /** @type {WeakMap<object, {snapshot:Snapshot,patch?:unknown}>} */
  #invocations = new WeakMap();

  /** @param {any} runtime */
  constructor(runtime) {
    this.runtime = runtime;
    recoverDreamRuns(runtime.memory.db, runtime.now());
  }

  /** @param {string} agentId @param {{signal?:AbortSignal,idempotencyKey?:string}} [options] */
  run(agentId, options) {
    return this.runtime.trackWork(this.execute(agentId, options));
  }

  /** @param {string} agentId @param {{signal?:AbortSignal,idempotencyKey?:string}} [options] */
  async execute(agentId, { signal, idempotencyKey } = {}) {
    const runtime = this.runtime;
    const role = runtime.agent(agentId);
    const profile = resolveFunctionalAgent(
      role,
      "@dream",
      "dream-cognitive",
      runtime.config,
    );
    if (profile?.kind !== "dream-cognitive") throw Error("DREAM_DISABLED");
    const config = runtime.config;
    const { definition, backend } = profile;
    const controller = new AbortController();
    const deadline = Date.now() + definition.timeoutMs;
    const current = () => {
      controller.signal.throwIfAborted();
      if (Date.now() >= deadline) throw Error("DREAM_INTERRUPTED");
      if (config !== runtime.config) throw Error("DREAM_INTERRUPTED");
      const blockers = runtime.blockers(role, "@dream", ctx);
      if (blockers.length) throw Error(blockers[0]);
    };
    const ctx = {
      runtimeKind: "dream-cognitive",
      agentId,
      conversation: "@dream",
      functionalAgent: profile,
      controller,
      expires: deadline,
      assertCurrent: current,
      token: randomBytes(32).toString("base64url"),
      inputEpoch: randomUUID(),
      allowedTools: definition.tools,
      privateRead: new Set(),
      fingerprints: new Map(),
      maxOps: role.dream.cognitive.maxOpsPerRun,
      requiresInputSubmission: true,
      grants: new Set(),
    };
    signal?.throwIfAborted();
    current();
    if (this.#active.has(agentId)) throw Error("DREAM_ALREADY_RUNNING");
    const { previous, snapshot } = startDream(runtime, agentId, {
      backendId: definition.backendId,
      model: definition.model,
      batchSize: role.dream.cognitive.maxEventsPerBatch,
      idempotencyKey,
    });
    if (previous) return { status: previous.status, runId: previous.run_id };
    const invocation = { snapshot, patch: /** @type {unknown} */ (undefined) };
    this.#active.set(agentId, invocation);
    this.#invocations.set(ctx, invocation);
    runtime.capabilities.set(ctx.token, ctx);
    const abort = () => controller.abort(Error("DREAM_INTERRUPTED"));
    signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(abort, definition.timeoutMs);
    const stopped = new Promise((_, reject) => {
      controller.signal.addEventListener(
        "abort",
        () => reject(Error("DREAM_INTERRUPTED")),
        { once: true },
      );
    });
    const execute = async () => {
      const lease = backend.functionalAgentOnly
        ? runtime.backendConnections.acquireFunctionalBackend(role, definition)
        : null;
      const adapter =
        lease?.backend ??
        runtime.backendFactory(
          {
            ...backend,
            model: definition.model,
            effort: definition.effort,
            toolServers: [],
          },
          role,
        );
      if (!lease && backend.type === "dsh")
        adapter.reservedEndpoint = (/** @type {string} */ url) =>
          runtime.backendConnections.reservedEndpoint(url);
      try {
        const contract = resolveFunctionalContract(profile);
        await adapter.run({
          ...contract.createExchange(runtime, ctx, { profile, snapshot }),
          signal: controller.signal,
          ...(lease && { modelSelection: lease.modelSelection }),
        });
      } finally {
        if (lease) await lease.release();
        else await adapter.close?.();
      }
    };
    const native = runtime
      .trackWork(execute())
      .finally(() => this.#active.delete(agentId));
    try {
      await Promise.race([native, stopped]);
      current();
      if (!invocation.patch) throw Error("DREAM_INVALID_PATCH");
      return commitDream(runtime, snapshot, invocation.patch, ctx);
    } catch (error) {
      const code =
        error instanceof Error && knownErrorCodes.has(error.message)
          ? error.message
          : "DREAM_INTERRUPTED";
      const status = signal?.aborted ? "CANCELLED" : "FAILED";
      failDream(runtime.memory.db, snapshot.runId, status, code, runtime.now());
      return { status, runId: snapshot.runId, errorCode: code };
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      abort();
      this.#invocations.delete(ctx);
      runtime.closeFunctionalContext(ctx);
    }
  }

  /** @param {any} ctx @param {string} name @param {any} args */
  async call(ctx, name, args) {
    const runtime = this.runtime;
    runtime.assertActive(ctx);
    const invocation = this.#invocations.get(ctx);
    if (!invocation) throw Error("FUNCTIONAL_AGENT_STALE");
    if (ctx.backendInputEpoch !== ctx.inputEpoch)
      throw Error("BACKEND_INPUT_NOT_SUBMITTED");
    const { snapshot } = invocation;
    const sources = dreamSources(runtime, ctx, snapshot.cursorEnd);
    if (name === DREAM_SUBMIT) {
      if (invocation.patch)
        throw Error("FUNCTIONAL_AGENT_RESULT_ALREADY_SUBMITTED");
      planDreamPatch(runtime, snapshot, args, ctx);
      invocation.patch = args;
      return { status: "accepted" };
    }
    if (name === DREAM_LIST) {
      const limit = args.limit ?? 10;
      const db = runtime.memory.db;
      const rows = listCognitions(db, snapshot.agentId, {
        ...args,
        limit: limit + 1,
      });
      const selected = rows
        .slice(0, limit)
        .filter((row) => visibleCognitionEvidence(db, row, sources.read));
      const result = {
        items: selected.map((row) => ({
          id: row.id,
          version: row.version,
          scopeId: row.scope_id,
          category: row.category,
          subjectKey: row.subject_key,
          content: row.content,
          epistemicStatus: row.epistemic_status,
          status: row.status,
          fromPrivate: !!row.from_private,
        })),
        nextOffset: rows.length > limit ? (args.offset ?? 0) + limit : null,
      };
      runtime.stageToolOutput(ctx, result, [
        {
          value: result,
          expected: result,
          current: () => {
            runtime.assertActive(ctx);
            return selected.every((row) =>
              visibleCognitionEvidence(db, row, sources.read),
            );
          },
        },
      ]);
      return result;
    }

    /** @param {Source[]} records @param {object} result */
    const present = (records, result) => {
      /** @param {Source} item */
      const current = (item) =>
        item.fingerprint === sources.read(item.id)?.fingerprint;
      runtime.stageToolOutput(ctx, result, [
        {
          value: result,
          expected: JSON.parse(JSON.stringify(result)),
          current: () => {
            runtime.assertActive(ctx);
            return records.every(current);
          },
          commit: () => recordDreamSources(ctx, records),
        },
      ]);
      return result;
    };
    /** @param {string} id */
    const read = (id) => {
      const item = sources.read(id);
      if (!item)
        throw Error(
          item === null
            ? "RECALL_SOURCE_NOT_ALLOWED"
            : "DREAM_EVIDENCE_NOT_FOUND",
        );
      return item;
    };
    if (name === "memory_read") {
      const item = read(args.id);
      const offset = args.offset ?? 0,
        end = offset + (args.maxChars ?? 1600);
      return present(end > offset && offset < item.text.length ? [item] : [], {
        ...visibleSource(item, 0),
        text: item.text.slice(offset, end),
        offset,
        truncated: end < item.text.length,
        nextOffset: end < item.text.length ? end : null,
      });
    }
    if (name === "memory_related") {
      const source = read(args.id);
      if (source.type !== "event") return { anchorId: source.id, items: [] };
      const related = runtime.memory
        .bind(snapshot.agentId)
        .related(args, "@dream");
      const pairs = related.items.flatMap(
        (
          /** @type {{record:{id:string},links?:{toId:string|null,relation:string}[]}} */ item,
        ) => {
          const record = sources.read(item.record.id);
          if (!record) return [];
          const links = (item.links || [])
            .filter(({ toId }) => toId && sources.read(toId))
            .map(({ toId, relation }) => ({ toId, relation }));
          return [
            { record, visible: { ...visibleSource(record, 400), links } },
          ];
        },
      );
      return present(
        pairs.map((/** @type {{record:Source}} */ item) => item.record),
        {
          anchorId: source.id,
          items: pairs.map(
            (/** @type {{visible:object}} */ item) => item.visible,
          ),
          nextAfterSeq:
            related.nextAfterSeq <= snapshot.cursorEnd.events
              ? related.nextAfterSeq
              : null,
        },
      );
    }
    if (name !== "memory_search") throw Error("TOOL_DISABLED");
    const needle = (args.query ?? "").toLowerCase();
    const limit = args.limit ?? 10,
      offset = args.offset ?? 0;
    /** @type {Source[]} */
    const matches = [];
    let seen = 0;
    for (const partition of SOURCE_PARTITIONS) {
      let after = 0;
      const batchSize = 50;
      for (;;) {
        let count = 0;
        for (const { item, seq } of sources.scan(
          partition,
          after,
          batchSize,
          needle,
        )) {
          count++;
          after = seq;
          if (
            !item ||
            (args.scopeId &&
              !item.sourceScopes.includes(args.scopeId) &&
              item.scopeId !== args.scopeId)
          )
            continue;
          if (seen++ < offset) continue;
          matches.push(item);
          if (matches.length > limit) break;
        }
        if (matches.length > limit || count < batchSize) break;
        await setImmediate(undefined, { signal: ctx.controller.signal });
        runtime.assertActive(ctx);
      }
      if (matches.length > limit) break;
    }
    const shown = matches.slice(0, limit);
    return present(shown, {
      items: shown.map((item) => visibleSource(item, 400)),
      nextOffset: matches.length > limit ? offset + limit : null,
    });
  }
}

/** @param {{privateRead:Set<string>,fingerprints:Map<string,string>}} ctx @param {Source[]} records */
export function recordDreamSources(ctx, records) {
  for (const item of records) {
    ctx.privateRead.add(item.id);
    ctx.fingerprints.set(item.id, item.fingerprint);
  }
}
