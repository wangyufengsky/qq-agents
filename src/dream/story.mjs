// @ts-check
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { prepared } from "../core/recall-boundary.mjs";
import {
  dreamSources,
  SOURCES,
  SOURCE_PARTITIONS,
  sourceRoleColumn,
} from "./source-filter.mjs";

const text = (/** @type {number} */ max) => z.string().trim().min(1).max(max);
export const storyPatch = z.strictObject({
  schemaVersion: z.literal(1),
  title: text(60),
  narrative: text(1200),
  reflection: text(300),
  themes: z.array(z.string().trim().min(1)).max(5),
  inspirations: z
    .array(
      z.strictObject({
        kind: z.enum([
          "home_decor",
          "garden",
          "diary",
          "project",
          "chat_topic",
          "other",
        ]),
        content: text(160),
      }),
    )
    .max(3),
});
export const storyWatermarks = {
  events: Number.MAX_SAFE_INTEGER,
  diaries: Number.MAX_SAFE_INTEGER,
  corrections: Number.MAX_SAFE_INTEGER,
};
export const dreamFictionLabel = "[虚构梦境 · 非现实事件]";

/** @param {any} runtime @param {{agentId:string,conversation:string}} ctx */
export function sampleStoryMaterial(runtime, ctx) {
  const { read } = dreamSources(runtime, ctx, storyWatermarks);
  /** @type {import("./source-filter.mjs").DreamSource[]} */
  const items = [];
  for (const partition of SOURCE_PARTITIONS) {
    const { from, cursor } = SOURCES[partition];
    const candidates = /** @type {{id:string}[]} */ (
      prepared(
        runtime.memory.db,
        `SELECT r.id FROM ${from} WHERE ${sourceRoleColumn(partition)}=? ORDER BY ${cursor} DESC LIMIT 12`,
      ).all(ctx.agentId)
    );
    for (const { id } of candidates) {
      const item = read(id);
      if (
        item &&
        item.sourceScopes.length &&
        item.sourceScopes.every(
          (scope) => scope === "desktop" || scope.startsWith("group:"),
        )
      )
        items.push(item);
    }
  }
  return items;
}

/** @param {ReturnType<typeof sampleStoryMaterial>} items */
export function storyMaterial(items) {
  const events = items.some(({ type }) => type === "event");
  const companions = items.some(({ sourceScopes }) =>
    sourceScopes.includes("desktop"),
  );
  const diaries = items.some(({ type }) => type === "diary");
  const corrections = items.some(({ type }) => type === "correction");
  // Supply only broad themes. Memories, identifiers and the source scopes
  // never become creative material from which another transcript can be made.
  return [
    ...(events ? ["相遇与交谈"] : []),
    ...(companions ? ["桌边相伴"] : []),
    ...(diaries ? ["整理心情"] : []),
    ...(corrections ? ["换个角度理解"] : []),
  ];
}

/** @typedef {z.infer<typeof storyPatch>} StoryPatch */
/** @param {any} runtime @param {import("./store.mjs").Snapshot} snapshot @param {StoryPatch} patch */
export function commitStory(runtime, snapshot, patch) {
  return runtime.memory.transaction(() => {
    const { db } = runtime.memory,
      { runId, agentId } = snapshot;
    const time = new Date(runtime.now()).toISOString();
    const { read } = dreamSources(
      runtime,
      { agentId, conversation: "@dream" },
      storyWatermarks,
    );
    if (
      snapshot.items.some(
        (item) => read(item.id)?.fingerprint !== item.fingerprint,
      )
    )
      throw Error("RECALL_SOURCE_NOT_ALLOWED");
    const result = prepared(
      db,
      `UPDATE dream_runs SET status='COMMITTED',changes_count=1,finished_at=?
      WHERE run_id=? AND agent_id=? AND mode='imaginative' AND status='RUNNING'`,
    ).run(time, runId, agentId);
    if (result.changes !== 1) throw Error("DREAM_INTERRUPTED");
    const { title, narrative, reflection, themes, inspirations } = patch;
    const dreamId = randomUUID();
    prepared(
      db,
      `INSERT INTO imaginative_dreams(dream_id,agent_id,run_id,fictional,title,narrative,reflection,themes_json,inspirations_json,created_at)
      VALUES(?,?,?,1,?,?,?,?,?,?)`,
    ).run(
      dreamId,
      agentId,
      runId,
      title,
      narrative,
      reflection,
      JSON.stringify(themes),
      JSON.stringify(inspirations),
      time,
    );
    return { status: "COMMITTED", runId, dreamId, changesCount: 1 };
  });
}
