// Explicit checkpoints let a role finish reading a backlog across bounded
// turns. They never change the draft, choices or whose turn it is.
export function acknowledgeActivity(runtime, ctx, args, old) {
  const read = args.administratorRead;
  if (
    !old?.activity ||
    [
      "title",
      "why",
      "next",
      "blocker",
      "status",
      "draft",
      "shared",
      "participantEventId",
    ].some((key) => args[key] !== undefined) ||
    args.progress ||
    args.outcome ||
    args.files?.length ||
    args.evidence?.length
  )
    throw Error("ACTIVITY_ACKNOWLEDGEMENT_ONLY");
  const pending = old.activity.administratorRevisions || [];
  if (
    new Set(read.revisions).size !== read.revisions.length ||
    read.revisions.some(
      (rev) =>
        !pending.includes(rev) ||
        !ctx.activityAdministratorRead?.has(`${old.id}:${rev}`),
    )
  )
    throw Error("ACTIVITY_READ_ADMINISTRATOR_FIRST");
  const memory = runtime.memory.bind(ctx.agentId),
    now = runtime.now();
  return memory.store.transaction(() => {
    const activity = {
      ...old.activity,
      administratorRevisions: pending.filter(
        (rev) => !read.revisions.includes(rev),
      ),
      administratorAcknowledged: [
        ...(old.activity.administratorAcknowledged || []),
        ...read.revisions.map((revision) => ({
          revision,
          summary: read.summary,
        })),
      ],
    };
    const progress = "已阅读管理员贡献：" + read.summary;
    const saved = memory.identity.saveProject(
      {
        id: old.id,
        expectedRevision: args.expectedRevision,
        activity,
        progress,
      },
      { writtenIn: ctx.conversation, now },
    );
    const entry = {
      projectId: saved.id,
      revision: saved.revision,
      at: now,
      progress,
      next: saved.next,
      blocker: saved.blocker,
      status: saved.status,
      activity,
      evidence: [],
      files: [],
      author: "agent",
      action: "acknowledge",
      administratorContributionsRead: read.revisions,
    };
    memory.db
      .prepare("INSERT INTO activity_history VALUES(?,?,?,?)")
      .run(ctx.agentId, saved.id, saved.revision, JSON.stringify(entry));
    return {
      ...saved,
      read: { tool: "projects", id: saved.id },
      notice:
        "已保存阅读进度与摘要；未改原稿、选项或轮次。剩余贡献可在后续正常回合分批阅读确认。",
    };
  });
}
