import { z } from "zod";
import { humanInput } from "../core/input-progress.mjs";

const person = z.string().regex(/^\d{5,12}$/);
const pending = z
  .array(
    z
      .object({
        id: z.string().min(1).max(60),
        question: z.string().min(1).max(300),
        options: z.array(z.string().min(1).max(200)).max(8),
      })
      .strict(),
  )
  .max(10);
export const activityFields = {
  shared: z
    .object({
      participants: z.array(person).min(1).max(8).optional(),
      turn: z.union([z.literal("agent"), person]).optional(),
      pending: pending.optional(),
    })
    .strict()
    .optional(),
  participantEventId: z.string().optional(),
  draft: z
    .object({ title: z.string().min(1).max(100), text: z.string().max(32000) })
    .strict()
    .optional(),
};
export const projectReadSchema = z
  .object({
    id: z.string().optional(),
    revision: z.number().int().min(1).optional(),
    offset: z.number().int().min(0).default(0),
    maxChars: z.number().int().min(512).max(16000).default(8000),
    historyOffset: z.number().int().min(0).default(0),
  })
  .strict();
export const activityVisible = (p, conversation) =>
  !p.activity ||
  conversation === "@subject" ||
  p.activity.conversation === conversation;
export function activityBrief(p) {
  return {
    id: p.id,
    title: p.title,
    revision: p.revision,
    status: p.status,
    ...p.activity,
    next: p.next,
    blocker: p.blocker,
    read: { tool: "projects", id: p.id },
  };
}
export function activityForTurn(memory, conversation) {
  return memory.identity
    .projects()
    .filter(
      (p) =>
        p.activity &&
        activityVisible(p, conversation) &&
        ["active", "paused"].includes(p.status),
    )
    .slice(0, 8)
    .map(activityBrief);
}
function version(memory, id, revision) {
  const row = memory.db
    .prepare(
      "SELECT value FROM activity_history WHERE agent_id=? AND project_id=? AND revision=?",
    )
    .get(memory.agentId, id, revision);
  if (!row) throw Error("ACTIVITY_REVISION_NOT_FOUND");
  return JSON.parse(row.value);
}
export function writeActivity(runtime, ctx, args, old) {
  const memory = runtime.memory.bind(ctx.agentId);
  if (
    !/^(group|private):/.test(ctx.conversation) ||
    (old && !activityVisible(old, ctx.conversation))
  )
    throw Error("ACTIVITY_SCOPE_REQUIRED");
  if (old && !old.activity) throw Error("ACTIVITY_CANNOT_CONVERT");
  const source =
    args.participantEventId &&
    humanInput(runtime, ctx, args.participantEventId);
  const participants = old?.activity.participants || args.shared?.participants;
  if (
    !participants?.length ||
    new Set(participants).size !== participants.length
  )
    throw Error("ACTIVITY_PARTICIPANTS_REQUIRED");
  if (
    old &&
    args.shared?.participants &&
    JSON.stringify(args.shared.participants) !== JSON.stringify(participants)
  )
    throw Error("ACTIVITY_PARTICIPANTS_IMMUTABLE");
  if (
    source &&
    (!ctx.requestEvents?.has(source.id) ||
      !participants.includes(source.sender_id))
  )
    throw Error("ACTIVITY_HUMAN_INPUT_REQUIRED");
  if (args.participantEventId && !source)
    throw Error("ACTIVITY_HUMAN_INPUT_REQUIRED");
  if (!old) {
    // Every participant must have actually spoken in this turn. Text semantics
    // (agreeing to join vs mentioning a name) remain the model's responsibility.
    if (
      !source ||
      participants.some(
        (id) =>
          ![...(ctx.requestEvents || [])].some(
            (eventId) => humanInput(runtime, ctx, eventId)?.sender_id === id,
          ),
      )
    )
      throw Error("ACTIVITY_HUMAN_INPUT_REQUIRED");
    const privateId = /^private:(\d+)$/.exec(ctx.conversation)?.[1];
    if (
      privateId &&
      (participants.length !== 1 || participants[0] !== privateId)
    )
      throw Error("ACTIVITY_SCOPE_REQUIRED");
  }
  const previousInput =
    old?.activity.lastHumanEventId &&
    memory.db
      .prepare("SELECT seq FROM events WHERE agent_id=? AND id=?")
      .get(ctx.agentId, old.activity.lastHumanEventId);
  if (source && previousInput && source.seq <= previousInput.seq)
    throw Error("ACTIVITY_INPUT_ALREADY_USED");
  if (
    old?.activity.turn &&
    old.activity.turn !== "agent" &&
    (!source || source.sender_id !== old.activity.turn)
  )
    throw Error("ACTIVITY_WAITING_FOR_PARTICIPANT");
  // Changing an undecided choice list needs an actual participant response.
  if (
    old?.activity.pending.length &&
    args.shared?.pending &&
    JSON.stringify(args.shared.pending) !==
      JSON.stringify(old.activity.pending) &&
    !source
  )
    throw Error("ACTIVITY_DECISION_NEEDS_HUMAN");
  const turn = args.shared?.turn ?? old?.activity.turn ?? "agent";
  if (turn !== "agent" && !participants.includes(turn))
    throw Error("ACTIVITY_INVALID_TURN");
  const choices = args.shared?.pending ?? old?.activity.pending ?? [];
  if (new Set(choices.map((x) => x.id)).size !== choices.length)
    throw Error("ACTIVITY_DUPLICATE_CHOICE");
  if (
    args.draft &&
    old?.activity.draftRevision &&
    !ctx.activityDraftsRead?.has(`${old.id}:${old.activity.draftRevision}`)
  )
    throw Error("ACTIVITY_READ_DRAFT_FIRST");
  return memory.store.transaction(() => {
    const rev = (old?.revision || 0) + 1;
    const activity = {
      participants,
      conversation: old?.activity.conversation || ctx.conversation,
      turn,
      pending: choices,
      lastHumanEventId: source?.id || old?.activity.lastHumanEventId,
      draftRevision: args.draft ? rev : old?.activity.draftRevision || null,
    };
    const saved = memory.identity.saveProject(
      {
        ...args,
        activity,
        evidence: [
          ...new Set([
            ...(args.evidence || []),
            ...(source ? [source.id] : []),
          ]),
        ],
      },
      { writtenIn: ctx.conversation, now: runtime.now() },
    );
    const entry = {
      projectId: saved.id,
      revision: saved.revision,
      at: runtime.now(),
      progress: args.progress || "",
      next: saved.next,
      blocker: saved.blocker,
      status: saved.status,
      activity,
      evidence: [
        ...new Set([...(args.evidence || []), ...(source ? [source.id] : [])]),
      ],
      files: args.files || [],
      ...(args.draft ? { draft: args.draft, draftAuthor: "agent" } : {}),
      ...(source
        ? {
            contribution: {
              eventId: source.id,
              personId: source.sender_id,
              text: source.body,
            },
          }
        : {}),
    };
    memory.db
      .prepare("INSERT INTO activity_history VALUES(?,?,?,?)")
      .run(ctx.agentId, saved.id, saved.revision, JSON.stringify(entry));
    return {
      ...saved,
      read: { tool: "projects", id: saved.id },
      notice:
        "共同活动已保存；原稿与真实来信贡献保留在版本历史中。等待参与者时不代其选择。",
    };
  });
}
export function readProjects(runtime, ctx, args) {
  const memory = runtime.memory.bind(ctx.agentId);
  if (!args.id) {
    const rows = memory.identity
      .projects()
      .filter((p) => activityVisible(p, ctx.conversation));
    return {
      items: rows.slice(args.offset, args.offset + 10).map((p) => ({
        ...p,
        steps: p.steps.slice(0, 5),
        moreSteps: Math.max(0, p.steps.length - 5),
      })),
      total: rows.length,
      nextOffset: args.offset + 10 < rows.length ? args.offset + 10 : null,
    };
  }
  const project = memory.identity.project(args.id);
  if (!project || !activityVisible(project, ctx.conversation))
    throw Error("RECORD_NOT_FOUND");
  if (!project.activity) return project;
  const entry = version(memory, project.id, args.revision || project.revision);
  const draftEntry = entry.activity.draftRevision
    ? version(memory, project.id, entry.activity.draftRevision)
    : null;
  const text = draftEntry?.draft.text;
  const total = memory.db
    .prepare(
      "SELECT count(*) AS n FROM activity_history WHERE agent_id=? AND project_id=?",
    )
    .get(ctx.agentId, project.id).n;
  const rows = memory.db
    .prepare(
      "SELECT value FROM activity_history WHERE agent_id=? AND project_id=? ORDER BY revision DESC LIMIT 10 OFFSET ?",
    )
    .all(ctx.agentId, project.id, args.historyOffset)
    .map((r) => JSON.parse(r.value));
  const end = args.offset + args.maxChars;
  if (text !== undefined) {
    const key = `${project.id}:${entry.activity.draftRevision}`;
    const pages = (ctx.activityDraftPages ??= new Map());
    if (args.offset === 0 || pages.get(key) === args.offset) {
      pages.set(key, Math.min(end, text.length));
      if (end >= text.length) (ctx.activityDraftsRead ??= new Set()).add(key);
    }
  }
  for (const id of [
    ...(entry.evidence || []),
    ...(draftEntry?.evidence || []),
    entry.contribution?.eventId,
  ].filter(Boolean))
    ctx.privateRead?.add(id);
  ctx.persistTaint?.();
  return {
    project,
    version: {
      ...entry,
      draft: undefined,
      ...(entry.contribution
        ? {
            contribution: {
              ...entry.contribution,
              text: entry.contribution.text.slice(0, args.maxChars),
              truncated: entry.contribution.text.length > args.maxChars,
              read: { tool: "memory_read", id: entry.contribution.eventId },
            },
          }
        : {}),
    },
    ...(draftEntry
      ? {
          draft: {
            title: draftEntry.draft.title,
            text: text.slice(args.offset, end),
            revision: entry.activity.draftRevision,
            totalChars: text.length,
            nextOffset: end < text.length ? end : null,
          },
        }
      : {}),
    history: rows.map(({ revision, at, progress, contribution, draft }) => ({
      revision,
      at,
      progress,
      contributor: contribution?.personId,
      hasDraft: !!draft,
      read: { tool: "projects", id: project.id, revision },
    })),
    historyTotal: total,
    nextHistoryOffset:
      args.historyOffset + 10 < total ? args.historyOffset + 10 : null,
    notice:
      "正文必须按 nextOffset 读完才可改写；history 是索引，原始贡献在指定 version 中。",
  };
}
