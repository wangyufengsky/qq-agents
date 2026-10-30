import { z } from "zod";
import { activityVersion } from "../tools/activities.mjs";
import { loadFileText } from "../tools/file-text.mjs";

export const projectListQuery = z
  .object({
    kind: z.enum(["all", "personal", "shared"]).default("all"),
    status: z
      .enum(["all", "active", "paused", "done", "dropped"])
      .default("all"),
    query: z.string().max(100).default(""),
    offset: z.coerce.number().int().min(0).default(0),
  })
  .strict();

export function listConsoleProjects(memory, input) {
  const args = projectListQuery.parse(input);
  const all = memory.identity.projects();
  const matched = all.filter(
    (p) =>
      (args.kind === "all" || !!p.activity === (args.kind === "shared")) &&
      (args.status === "all" || p.status === args.status) &&
      (!args.query ||
        `${p.title}\n${p.why}`
          .toLocaleLowerCase()
          .includes(args.query.toLocaleLowerCase())),
  );
  return {
    counts: {
      all: all.length,
      personal: all.filter((p) => !p.activity).length,
      shared: all.filter((p) => p.activity).length,
    },
    items: matched.slice(args.offset, args.offset + 20).map((p) => ({
      id: p.id,
      title: p.title,
      why: p.why,
      status: p.status,
      revision: p.revision,
      updatedAt: p.updatedAt,
      activity: p.activity && {
        ...p.activity,
        administratorAcknowledged: undefined,
        administratorAcknowledgedCount: (
          p.activity.administratorAcknowledged || []
        ).length,
      },
      latest: p.steps[0]?.did || "",
      fileCount: p.files.length,
      next: p.next,
      blocker: p.blocker,
    })),
    total: matched.length,
    nextOffset: args.offset + 20 < matched.length ? args.offset + 20 : null,
  };
}

// One replacement span preserves the entire difference without pretending to
// be a minimal edit script. Bound only the displayed excerpt, never equality.
export function compareProjectText(before, after) {
  let start = 0;
  while (
    start < before.length &&
    start < after.length &&
    before[start] === after[start]
  )
    start++;
  let oldEnd = before.length,
    newEnd = after.length;
  while (
    oldEnd > start &&
    newEnd > start &&
    before[oldEnd - 1] === after[newEnd - 1]
  ) {
    oldEnd--;
    newEnd--;
  }
  const boundaries = (text) =>
    new Intl.Segmenter("und", { granularity: "grapheme" }).segment(text);
  const oldParts = boundaries(before),
    newParts = boundaries(after);
  start = Math.min(
    oldParts.containing(start)?.index ?? start,
    newParts.containing(start)?.index ?? start,
  );
  const excerpt = (text, end, parts) => {
    const last = parts.containing(end - 1);
    if (last) end = last.index + last.segment.length;
    let limit = Math.min(end, start + 16000);
    if (limit < end) limit = parts.containing(limit).index;
    return {
      text: text.slice(start, limit),
      start,
      end,
      totalChars: text.length,
      truncated: end > limit,
    };
  };
  return {
    identical: before === after,
    before: excerpt(before, oldEnd, oldParts),
    after: excerpt(after, newEnd, newParts),
  };
}

const comparisonQuery = z
  .object({
    id: z.string().min(1).max(200),
    before: z.string().regex(/^(file:[a-f0-9]{64}|draft:[1-9]\d{0,8})$/),
    after: z.string().regex(/^(file:[a-f0-9]{64}|draft:[1-9]\d{0,8})$/),
  })
  .strict();
export function compareConsoleProjects(runtime, agentId, input) {
  const args = comparisonQuery.parse(input),
    memory = runtime.memory.bind(agentId);
  const p = memory.identity.project(args.id);
  if (!p) throw Error("RECORD_NOT_FOUND");
  const version = (revision) => activityVersion(memory, p.id, revision);
  const text = (ref) => {
    const [kind, key] = ref.split(":");
    if (kind === "file") {
      if (!p.files.includes(key)) throw Error("FILE_NOT_FOUND");
      return loadFileText(runtime.files, agentId, key, 2 * 1024 * 1024).text;
    }
    if (!p.activity) throw Error("ACTIVITY_REVISION_NOT_FOUND");
    const entry = version(Number(key));
    return entry.activity.draftRevision
      ? version(entry.activity.draftRevision).draft.text
      : "";
  };
  return compareProjectText(text(args.before), text(args.after));
}
