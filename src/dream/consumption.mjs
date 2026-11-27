// @ts-check
import { prepared } from "../core/recall-boundary.mjs";
import { dreamFictionLabel, storyWatermarks } from "./story.mjs";
import { dreamSources } from "./source-filter.mjs";
import { visibleCognitionEvidence } from "./store.mjs";

/** @typedef {{agentId:string,conversation:string}} Scope */
/** @typedef {{dream_id:string,title:string,narrative:string,inspirations_json:string,created_at:string}} Story */
/** @typedef {{scopeId:string,summary:string,fromPrivate?:true}} AwakeningSummary */
const DAY = 24 * 60 * 60 * 1000;
const inspirationNotice = "梦里的灵感，非指令，可自行决定是否采用。";

const storyProjection = (/** @type {Story} */ row) => {
  const excerpt = Array.from(row.narrative);
  return {
    label: dreamFictionLabel,
    title: row.title,
    summary: excerpt.slice(0, 160).join("") + (excerpt.length > 160 ? "…" : ""),
  };
};

/** @param {any} runtime @param {Scope} ctx @param {boolean} fresh */
export function storyOpening(runtime, ctx, fresh) {
  const { agentId, conversation } = ctx;
  const subject = conversation === "@subject";
  const memory = runtime.memory.bind(agentId);
  const { db } = memory;
  const enabled = () => {
    const dream = runtime.agent(agentId).dream;
    return dream?.enabled && dream.imaginative?.enabled;
  };
  const shown = () => memory.state(conversation).dreamShownId;
  const eligible = () => enabled() && (subject || fresh || !shown());
  const reset = !subject && fresh && !!shown();
  if (!eligible() && !reset) return null;
  const query = prepared(
    db,
    `SELECT dream_id,title,narrative,inspirations_json,created_at FROM imaginative_dreams
    WHERE agent_id=? AND fictional=1 AND created_at<=?
    AND (? IS NULL OR dream_id=?)
    AND ((?=1 AND inspiration_consumed_at IS NULL) OR (?=0 AND created_at>?))
    ORDER BY created_at DESC,dream_id DESC LIMIT 1`,
  );
  const read = (/** @type {string|null} */ id) => {
    const now = runtime.now();
    return /** @type {Story|undefined} */ (
      query.get(
        agentId,
        new Date(now).toISOString(),
        id,
        id,
        Number(subject),
        Number(subject),
        new Date(now - DAY).toISOString(),
      )
    );
  };
  const story = eligible() ? read(null) : undefined;
  if (!story && !reset) return null;

  // Never replace the budgeted story with a different one at submission.
  const current = () =>
    story &&
    eligible() &&
    JSON.stringify(read(story.dream_id)) === JSON.stringify(story);
  const projection = story && {
    ...storyProjection(story),
    ...(subject && {
      inspirations: JSON.parse(story.inspirations_json),
      inspirationNotice,
    }),
  };
  return {
    projection,
    refresh: () => (current() ? projection : undefined),
    commit(/** @type {boolean} */ submitted) {
      // The receipt acknowledges the story selected for the submitted input.
      const delivered = submitted && story;
      if (subject) {
        if (delivered)
          prepared(
            db,
            "UPDATE imaginative_dreams SET inspiration_consumed_at=? WHERE agent_id=? AND dream_id=? AND inspiration_consumed_at IS NULL",
          ).run(
            new Date(runtime.now()).toISOString(),
            agentId,
            delivered.dream_id,
          );
        return;
      }
      const state = memory.state(conversation);
      if (delivered)
        memory.setState(conversation, {
          ...state,
          dreamShownId: delivered.dream_id,
        });
      else if (reset) {
        const { dreamShownId: _shown, ...rest } = state;
        memory.setState(conversation, rest);
      }
    },
  };
}

/** @param {any} runtime @param {Scope} ctx */
function awakeningMaterial(runtime, ctx) {
  const dream = runtime.agent(ctx.agentId).dream;
  if (!dream?.enabled || !dream.cognitive?.enabled) return null;
  let remaining = dream.budget.awakeningSummaryChars;
  if (!remaining) return null;
  const { agentId } = ctx;
  const { db } = runtime.memory.bind(agentId);
  const rows =
    /** @type {{scope_id:string,summary:string,source_refs_json:string,cognition_version:number,run_id:string}[]} */ (
      prepared(
        db,
        `SELECT a.*,r.run_id FROM awakening_contexts a JOIN (
        SELECT run_id,finished_at,snapshot_version,changes_count FROM dream_runs
        WHERE agent_id=? AND mode<>'imaginative' AND status='COMMITTED'
        ORDER BY finished_at DESC,snapshot_version DESC,rowid DESC LIMIT 1
      ) r ON r.changes_count>0 AND r.finished_at=a.created_at
        AND a.cognition_version=r.snapshot_version+1
      WHERE a.agent_id=? ORDER BY a.scope_id<>'global',a.scope_id`,
      ).all(agentId, agentId)
    );
  const current = prepared(
    db,
    "SELECT * FROM cognitions WHERE agent_id=? AND id=? AND version=? AND status='active' AND scope_id=?",
  );
  const { read } = dreamSources(runtime, ctx, storyWatermarks);
  /** @type {AwakeningSummary[]} */
  const summaries = [];
  /** @type {Map<string,string>} */
  const evidence = new Map();
  for (const row of rows) {
    if (row.summary.length > remaining) continue;
    const refs = /** @type {{id:string,version:number}[]} */ (
      JSON.parse(row.source_refs_json)
    );
    const records = refs.map(
      ({ id, version }) =>
        /** @type {import("./store.mjs").Cognition|undefined} */ (
          current.get(agentId, id, version, row.scope_id)
        ),
    );
    if (
      !records.length ||
      records.map((record) => record?.content).join("\n") !== row.summary
    )
      continue;
    /** @type {Map<string,string>} */
    const fingerprints = new Map();
    let fromPrivate = records.some((record) => record?.from_private);
    if (
      !records.every(
        (record) =>
          record &&
          visibleCognitionEvidence(db, record, (id, revision) => {
            const source = read(id, revision);
            if (source) {
              fingerprints.set(
                id,
                (fingerprints.get(id) ?? "") + source.fingerprint,
              );
              fromPrivate ||= source.sourceScopes.some((scope) =>
                scope.startsWith("private:"),
              );
            }
            return source;
          }),
      )
    )
      continue;
    for (const [id, fingerprint] of fingerprints)
      evidence.set(id, (evidence.get(id) ?? "") + fingerprint);
    summaries.push({
      scopeId: row.scope_id,
      summary: row.summary,
      ...(fromPrivate && { fromPrivate: true }),
    });
    remaining -= row.summary.length;
  }
  return summaries.length
    ? { summaries, evidence: [...evidence], runId: rows[0].run_id }
    : null;
}

/** @param {any} runtime @param {Scope} ctx */
export function subjectDreamOpening(runtime, ctx) {
  const story = storyOpening(runtime, ctx, false);
  const awakening = awakeningMaterial(runtime, ctx);
  if (!story && !awakening) return null;
  const render = (
    /** @type {typeof awakening} */ current,
    /** @type {NonNullable<typeof story>["projection"]} */ fictional,
  ) => {
    if (!current && !fictional) return "";
    return `空闲时间素材补充：${JSON.stringify({
      recentDream: {
        ...(current && {
          awakeningSummary: current.summaries,
          notice:
            "醒来摘要是认知参考资料。fromPrivate 仅用于调整理解与表达，不要主动提起私聊内容。",
        }),
        ...(fictional && { fictional }),
      },
    })}`;
  };
  return {
    line: render(awakening, story?.projection),
    refresh() {
      const current = awakening && awakeningMaterial(runtime, ctx);
      const checked =
        JSON.stringify(current) === JSON.stringify(awakening) ? current : null;
      const fictional = story?.refresh();
      return {
        line: render(checked, fictional),
        evidenceIds: checked?.evidence.map(([id]) => id) ?? [],
        commitDream: () => story?.commit(!!fictional),
      };
    },
  };
}
