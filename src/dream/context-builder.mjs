// @ts-check
import { prepared } from "../core/recall-boundary.mjs";
import { visibleCognitionEvidence } from "./store.mjs";
import { dreamSources, sourceScope } from "./source-filter.mjs";
import { storyOpening } from "./consumption.mjs";

/** @typedef {import("./store.mjs").Cognition} Cognition */
/** @typedef {{shown?:Record<string,number>,line:string,evidenceIds:string[],commitDream?:()=>void}} Opening */
/** @typedef {{line:string,refresh:() => Opening}} PreparedOpening */
const watermarks = {
  events: Number.MAX_SAFE_INTEGER,
  diaries: Number.MAX_SAFE_INTEGER,
  corrections: Number.MAX_SAFE_INTEGER,
};

/** @typedef {{id:string,version:number,content?:string,status?:string,fromPrivate?:boolean}} OpeningItem */
/** @typedef {{summary:string,source_refs_json:string,cognition_version:number,scope_id:string}} AwakeningRow */
/** @param {OpeningItem[]} items @param {AwakeningRow[]} caches @param {number} budget */
function cognitionLine(items, caches, budget) {
  const summaries = [];
  let remaining = budget;
  for (const cache of caches) {
    if (!remaining || cache.summary.length > remaining) continue;
    const refs = /** @type {{id:string,version:number}[]} */ (
      JSON.parse(cache.source_refs_json)
    );
    const matching = refs.map((ref) =>
      items.find((item) => item.id === ref.id && item.version === ref.version),
    );
    if (
      !matching.length ||
      matching.some((item) => !item) ||
      matching.map((item) => item?.content).join("\n") !== cache.summary
    )
      continue;
    summaries.push({
      scopeId: cache.scope_id,
      summary: cache.summary,
      ...(matching.some((item) => item?.fromPrivate) && { fromPrivate: true }),
    });
    remaining -= cache.summary.length;
  }

  return items.length
    ? `长期认知（本轮资料。根据认识状态理解，遇到分歧按原文核对。标为 disputed 或 archived 时，停止沿用该 ID 的旧认知。fromPrivate 仅用于调整理解与表达，不要主动提起其他私聊内容）：${JSON.stringify(items)}${summaries.length ? `\n\n醒来摘要（同属本轮参考资料）：${JSON.stringify(summaries)}` : ""}`
    : "";
}
/** @param {any} runtime @param {{agentId:string,conversation:string}} ctx @param {{fresh:boolean,personIds?:string[]}} options @returns {PreparedOpening|null} */
function cognitionOpening(runtime, ctx, { fresh, personIds = [] }) {
  const { agentId, conversation } = ctx;
  const scope = sourceScope(conversation);
  const role = runtime.agent(agentId);
  if (scope === "global") return null;
  const enabled = role.dream?.enabled && role.dream.cognitive.enabled;
  if (!enabled && !fresh) return null;
  const memory = runtime.memory.bind(agentId),
    db = memory.db;
  const previouslyShown = memory.state(conversation).cognitionsShown;
  if (!enabled) {
    const empty = { shown: {}, line: "", evidenceIds: [] };
    return previouslyShown ? { line: "", refresh: () => empty } : null;
  }
  /** @type {Record<string,number>} */
  const shown = fresh ? {} : { ...previouslyShown };
  const people = new Set(personIds);
  const { read } = dreamSources(runtime, ctx, watermarks);
  const candidate = prepared(
    db,
    `SELECT c.* FROM cognitions c WHERE c.agent_id=? AND (
      (c.status='active' AND (c.scope_id=? OR c.scope_id='global' OR EXISTS (
        SELECT 1 FROM json_each(?) p WHERE c.subject_key LIKE 'user:'||p.value||':%'
      ))) OR (c.status IN ('disputed','archived') AND EXISTS (
        SELECT 1 FROM json_each(?) s WHERE s.key=c.id AND s.value<c.version
      ))
    )
    ORDER BY c.status='active',c.importance DESC,c.updated_at DESC,c.id`,
  );
  const rows = /** @type {Iterable<Cognition>} */ (
    candidate.iterate(
      agentId,
      scope,
      JSON.stringify([...people]),
      JSON.stringify(shown),
    )
  );
  let core = role.dream.budget.contextCoreChars,
    scene = role.dream.budget.contextSceneChars;
  /** @type {{item:OpeningItem,fingerprints:Map<string,string>}[]} */
  const candidates = [];
  for (const row of rows) {
    if (core < 1 && scene < 1) break;
    if (row.version <= (shown[row.id] ?? 0)) continue;
    const own = row.scope_id === "global";
    if ((own ? core : scene) < 1) continue;
    /** @type {Map<string,string>} */
    const fingerprints = new Map();
    const evidence = visibleCognitionEvidence(db, row, (id) => {
      const source = read(id);
      if (source) fingerprints.set(id, source.fingerprint);
      return source;
    });
    if (!evidence) continue;
    const sourceScopes = /** @type {string[]} */ (
      JSON.parse(row.source_scopes_json)
    );
    const fromPrivate =
      Boolean(row.from_private) &&
      sourceScopes.some(
        (source) => source.startsWith("private:") && source !== scope,
      );
    const item = {
      id: row.id,
      version: row.version,
      category: row.category,
      ...(row.status === "active"
        ? { content: row.content, epistemicStatus: row.epistemic_status }
        : { status: row.status }),
      ...(fromPrivate && { fromPrivate }),
    };
    const size = JSON.stringify(item).length + 1;
    if (size > (own ? core : scene)) continue;
    if (own) core -= size;
    else scene -= size;
    candidates.push({ item, fingerprints });
  }
  const cacheQuery = prepared(
    db,
    `SELECT summary,source_refs_json,cognition_version,scope_id FROM awakening_contexts
    WHERE agent_id=? AND scope_id IN ('global',?) ORDER BY CASE WHEN scope_id=? THEN 0 ELSE 1 END`,
  );
  const caches = /** @type {AwakeningRow[]} */ (
    cacheQuery.all(agentId, scope, scope)
  );
  const version = new Map(
    caches.map((row) => [row.scope_id, row.cognition_version]),
  );
  const line = cognitionLine(
    candidates.map(({ item }) => item),
    caches,
    role.dream.budget.awakeningSummaryChars,
  );
  return {
    line,
    refresh() {
      // The initial selection accounts for capacity. After backend and image
      // preparation, only unchanged, still-readable items may enter the input.
      const currentRole = runtime.agent(agentId);
      const currentShown = fresh
        ? {}
        : { ...memory.state(conversation).cognitionsShown };
      const currentSources = dreamSources(runtime, ctx, watermarks);
      const currentRow = prepared(
        db,
        "SELECT * FROM cognitions WHERE agent_id=? AND id=? AND version=? AND status=?",
      );
      const items = [],
        evidenceIds = new Set();
      if (currentRole.dream?.enabled && currentRole.dream.cognitive.enabled)
        for (const { item, fingerprints } of candidates) {
          if (item.version <= (currentShown[item.id] ?? 0)) continue;
          if (item.status && !currentShown[item.id]) continue;
          const record = /** @type {Cognition|undefined} */ (
            currentRow.get(
              agentId,
              item.id,
              item.version,
              item.status ?? "active",
            )
          );
          if (!record) continue;
          const evidence = visibleCognitionEvidence(db, record, (id) => {
            const source = currentSources.read(id);
            return source && source.fingerprint === fingerprints.get(id)
              ? source
              : null;
          });
          if (!evidence || evidence.length !== fingerprints.size) continue;
          items.push(item);
          currentShown[item.id] = item.version;
          for (const id of evidence) evidenceIds.add(id);
        }
      return {
        shown: currentShown,
        evidenceIds: [...evidenceIds],
        line: cognitionLine(
          items,
          /** @type {AwakeningRow[]} */ (
            cacheQuery.all(agentId, scope, scope)
          ).filter(
            (row) => version.get(row.scope_id) === row.cognition_version,
          ),
          currentRole.dream.budget.awakeningSummaryChars,
        ),
      };
    },
  };
}

/** @param {any} runtime @param {{agentId:string,conversation:string}} ctx @param {{fresh:boolean,personIds?:string[]}} options @returns {PreparedOpening|null} */
export function cognitionContext(runtime, ctx, options) {
  const cognition = cognitionOpening(runtime, ctx, options);
  const story =
    sourceScope(ctx.conversation) === "global"
      ? null
      : storyOpening(runtime, ctx, options.fresh);
  if (!story) return cognition;
  const line = (
    /** @type {string|undefined} */ cognitive,
    /** @type {typeof story.projection} */ fictional,
  ) =>
    [
      cognitive,
      fictional &&
        `${fictional.label} ${JSON.stringify({ title: fictional.title, summary: fictional.summary })}`,
    ]
      .filter(Boolean)
      .join("\n\n");
  return {
    line: line(cognition?.line, story.projection),
    refresh() {
      const refreshed = cognition?.refresh();
      const fictional = story.refresh();
      return {
        ...refreshed,
        line: line(refreshed?.line, fictional),
        evidenceIds: refreshed?.evidenceIds ?? [],
        commitDream: () => story.commit(!!fictional),
      };
    },
  };
}

/** @param {any} memory @param {{conversation:string,turnId:string,privateRead:Set<string>,persistTaint?:()=>void}} ctx @param {Opening|null} opening */
export function commitCognitionContext(memory, ctx, opening) {
  if (!opening) return;
  const state = memory.state(ctx.conversation);
  if (state.lastTurnId !== ctx.turnId) return;
  if (opening.shown)
    memory.setState(ctx.conversation, {
      ...state,
      cognitionsShown: opening.shown,
    });
  opening.commitDream?.();
  for (const id of opening.evidenceIds) ctx.privateRead.add(id);
  if (opening.evidenceIds.length) ctx.persistTaint?.();
}
