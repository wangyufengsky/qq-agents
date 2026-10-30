import { createHash } from "node:crypto";
import { z } from "zod";
import { loadFileText } from "../tools/file-text.mjs";
import { recallBoundary } from "./recall-boundary.mjs";

const common = {
  id: z.string().min(1).max(200),
  expectedRevision: z.number().int().min(1),
  submissionId: z.string().uuid(),
};
export const participationSchema = z.discriminatedUnion("action", [
  z
    .object({
      ...common,
      action: z.literal("join"),
      sourceFileId: z
        .string()
        .regex(/^[a-f0-9]{64}$/)
        .optional(),
    })
    .strict(),
  z
    .object({
      ...common,
      action: z.literal("comment"),
      text: z
        .string()
        .min(1)
        .max(4000)
        .refine((value) => !!value.trim()),
    })
    .strict(),
  z
    .object({
      ...common,
      action: z.literal("decision"),
      choiceId: z.string().min(1).max(60),
      text: z
        .string()
        .min(1)
        .max(2000)
        .refine((value) => !!value.trim()),
    })
    .strict(),
  z
    .object({
      ...common,
      action: z.literal("draft"),
      title: z.string().trim().min(1).max(100),
      text: z.string().max(32000),
    })
    .strict(),
]);

// Console actions are durable contributions, never synthetic QQ events or
// fresh-message credentials. Reading a work does not call this function.
export function participateInProject(runtime, agentId, input) {
  const args = participationSchema.parse(input),
    memory = runtime.memory.bind(agentId);
  const digest = createHash("sha256")
    .update(JSON.stringify(args))
    .digest("hex");
  return memory.store.transaction(() => {
    const old = memory.identity.project(args.id);
    if (!old) throw Error("RECORD_NOT_FOUND");
    const previous = memory.db
      .prepare(
        "SELECT value FROM activity_history WHERE agent_id=? AND project_id=? AND json_extract(value,'$.submission.id')=?",
      )
      .get(agentId, old.id, args.submissionId);
    if (previous) {
      const entry = JSON.parse(previous.value);
      if (entry.submission.digest !== digest)
        throw Error("ACTIVITY_SUBMISSION_CONFLICT");
      return { project: old, savedRevision: entry.revision, duplicate: true };
    }
    if (old.revision !== args.expectedRevision)
      throw Error("REVISION_CONFLICT");
    if (["done", "dropped"].includes(old.status)) throw Error("PROJECT_CLOSED");
    if (
      args.action === "join" &&
      old.activity?.participants.includes("administrator")
    )
      throw Error("ACTIVITY_ALREADY_JOINED");
    if (
      args.action !== "join" &&
      !old.activity?.participants.includes("administrator")
    )
      throw Error("ACTIVITY_JOIN_REQUIRED");
    if (
      (old.activity?.administratorRevisions || []).length +
        (old.activity?.administratorAcknowledged || []).length >=
      20
    )
      throw Error("ACTIVITY_CONTRIBUTIONS_PENDING");
    const revision = old.revision + 1,
      now = runtime.now();
    const activity = old.activity
      ? structuredClone(old.activity)
      : {
          mode: "console",
          conversation: "@subject",
          participants: [],
          turn: "agent",
          pending: [],
          draftRevision: null,
        };
    let draft, draftAuthor, draftSourceFileId, decision;
    let contributionText;
    const summaries = {
      join: "管理员加入共同活动",
      comment: "管理员提交建议",
      decision: "管理员回应待定事项",
      draft: "管理员修改原稿",
    };
    if (args.action === "join") {
      activity.participants.push("administrator");
      contributionText = "管理员通过管理台明确加入此项目。";
      if (args.sourceFileId) {
        if (old.activity || !old.files.includes(args.sourceFileId))
          throw Error("ACTIVITY_SOURCE_FILE_INVALID");
        const meta = runtime.files.metadata(agentId, args.sourceFileId);
        recallBoundary(
          runtime,
          { agentId, conversation: "@subject" },
          { publicOnly: true },
        ).assert(meta);
        if (
          meta.protectionUnknown ||
          meta.sources.some((s) => s.conversation?.startsWith("@work:"))
        )
          throw Error("RECALL_SOURCE_NOT_ALLOWED");
        const source = loadFileText(
          runtime.files,
          agentId,
          args.sourceFileId,
          2 * 1024 * 1024,
        );
        if (source.text.length > 32000) throw Error("ACTIVITY_DRAFT_TOO_LONG");
        draft = { title: meta.name.slice(0, 100), text: source.text };
        draftAuthor = "source-file";
        draftSourceFileId = args.sourceFileId;
        activity.draftRevision = revision;
      }
    } else {
      if (
        ["decision", "draft"].includes(args.action) &&
        !["agent", "administrator"].includes(activity.turn)
      )
        throw Error("ACTIVITY_WAITING_FOR_PARTICIPANT");
      if (args.action === "comment") contributionText = args.text;
      if (args.action === "decision") {
        const choice = activity.pending.find((c) => c.id === args.choiceId);
        if (!choice) throw Error("ACTIVITY_CHOICE_NOT_FOUND");
        decision = { ...choice, answer: args.text };
        contributionText = args.text;
        activity.pending = activity.pending.filter(
          (c) => c.id !== args.choiceId,
        );
        activity.turn = "agent";
      }
      if (args.action === "draft") {
        draft = { title: args.title, text: args.text };
        draftAuthor = "administrator";
        contributionText = "管理员保存了一份新原稿；完整正文见本修订的 draft。";
        activity.draftRevision = revision;
        activity.turn = "agent";
      }
    }
    activity.administratorRevisions = [
      ...(activity.administratorRevisions || []),
      revision,
    ];
    const saved = memory.identity.saveProject(
      {
        id: old.id,
        expectedRevision: old.revision,
        activity,
        progress: summaries[args.action],
      },
      { writtenIn: "@administrator", now },
    );
    const entry = {
      projectId: saved.id,
      revision,
      at: now,
      progress: summaries[args.action],
      next: saved.next,
      blocker: saved.blocker,
      status: saved.status,
      activity,
      evidence: [],
      files: [],
      author: "administrator",
      action: args.action,
      submission: { id: args.submissionId, digest },
      contribution: {
        kind: "administrator",
        personId: "administrator",
        text: contributionText,
      },
      ...(decision ? { decision } : {}),
      ...(draft
        ? {
            draft,
            draftAuthor,
            ...(draftSourceFileId ? { draftSourceFileId } : {}),
          }
        : {}),
      ...(args.action === "join" && !old.activity
        ? { previousProject: old }
        : {}),
    };
    memory.db
      .prepare("INSERT INTO activity_history VALUES(?,?,?,?)")
      .run(agentId, saved.id, revision, JSON.stringify(entry));
    return { project: saved, savedRevision: revision, duplicate: false };
  });
}
