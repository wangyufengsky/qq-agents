// @ts-check
import { prepared } from "../core/recall-boundary.mjs";
import { visibleCognitionEvidence } from "./store.mjs";
import { dreamSources, sourceScope } from "./source-filter.mjs";

/** @typedef {import("./store.mjs").Cognition} Cognition */
/** @typedef {{shown:Record<string,number>,line:string,evidenceIds:string[]}} Opening */
/** @typedef {{line:string,refresh:() => Opening}} PreparedOpening */
const watermarks = {
  events: Number.MAX_SAFE_INTEGER,
  diaries: Number.MAX_SAFE_INTEGER,
  corrections: Number.MAX_SAFE_INTEGER,
};

/** @param {unknown[]} items */
function cognitionLine(items) {
  return items.length
    ? `长期认知（本轮资料。根据认识状态理解，遇到分歧按原文核对。fromPrivate 仅用于调整理解与表达，不要主动提起其他私聊内容）：${JSON.stringify(items)}`
    : "";
}
/** @param {any} runtime @param {{agentId:string,conversation:string}} ctx @param {{fresh:boolean,personIds?:string[]}} options @returns {PreparedOpening|null} */
export function cognitionContext(runtime, ctx, { fresh, personIds = [] }) {
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
    `SELECT c.* FROM cognitions c WHERE c.agent_id=? AND c.status='active'
    AND (c.scope_id=? OR c.scope_id='global' OR EXISTS (
      SELECT 1 FROM json_each(?) p WHERE c.subject_key LIKE 'user:'||p.value||':%'
    ))
    ORDER BY c.importance DESC,c.updated_at DESC,c.id`,
  );
  const rows = /** @type {Iterable<Cognition>} */ (
    candidate.iterate(agentId, scope, JSON.stringify([...people]))
  );
  let core = role.dream.budget.contextCoreChars,
    scene = role.dream.budget.contextSceneChars;
  /** @type {{item:{id:string,version:number},fingerprints:Map<string,string>}[]} */
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
      content: row.content,
      epistemicStatus: row.epistemic_status,
      ...(fromPrivate && { fromPrivate }),
    };
    const size = JSON.stringify(item).length + 1;
    if (size > (own ? core : scene)) continue;
    if (own) core -= size;
    else scene -= size;
    candidates.push({ item, fingerprints });
  }
  const line = cognitionLine(candidates.map(({ item }) => item));
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
        "SELECT * FROM cognitions WHERE agent_id=? AND id=? AND version=? AND status='active'",
      );
      const items = [],
        evidenceIds = new Set();
      if (currentRole.dream?.enabled && currentRole.dream.cognitive.enabled)
        for (const { item, fingerprints } of candidates) {
          if (item.version <= (currentShown[item.id] ?? 0)) continue;
          const record = /** @type {Cognition|undefined} */ (
            currentRow.get(agentId, item.id, item.version)
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
        line: cognitionLine(items),
      };
    },
  };
}

/** @param {any} memory @param {{conversation:string,turnId:string,privateRead:Set<string>,persistTaint?:()=>void}} ctx @param {Opening|null} opening */
export function commitCognitionContext(memory, ctx, opening) {
  if (!opening) return;
  const state = memory.state(ctx.conversation);
  if (state.lastTurnId !== ctx.turnId) return;
  memory.setState(ctx.conversation, {
    ...state,
    cognitionsShown: opening.shown,
  });
  for (const id of opening.evidenceIds) ctx.privateRead.add(id);
  if (opening.evidenceIds.length) ctx.persistTaint?.();
}
