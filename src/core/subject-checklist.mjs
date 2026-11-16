import { liveInput } from "./live-input.mjs";
import { contextProtection } from "./protected-mind.mjs";
import { recallBoundary } from "./recall-boundary.mjs";

const DAY = 86400000;

export function createSubjectChecklist(reasons) {
  const opportunity = reasons.find(
    ({ reason }) => reason === "subject-opportunity",
  );
  if (!opportunity && !reasons.some(({ reason }) => reason === "subject-inbox"))
    return undefined;
  return {
    opportunity: !!opportunity,
    activityIds: new Set((opportunity?.activities || []).map(({ id }) => id)),
    candidateIds: new Set(opportunity?.candidateIds || []),
    pendingTools: 0,
    contacts: new Set(),
    updatedContacts: new Set(),
    reviewedCandidates: new Set(),
    continuedProjects: new Set(),
    writes: new Set(),
  };
}

export function noteChecklistRead(runtime, ctx, items) {
  const checklist = ctx.subjectChecklist;
  if (!checklist?.activityIds.size) return;
  for (const item of items) {
    if (
      !checklist.activityIds.has(item.id) ||
      item.type !== "message.received" ||
      !/^\d{5,12}$/.test(item.senderId || "") ||
      runtime.config.connections.some((c) => c.accountId === item.senderId) ||
      !liveInput(runtime, ctx.agentId, item.conversation, item.id)
    )
      continue;
    checklist.contacts.add(item.senderId);
  }
}

export function noteChecklistTool(ctx, name, args, result) {
  const checklist = ctx.subjectChecklist;
  if (!checklist) return;
  checklist.writes.add(name);
  if (["person_note", "person_item"].includes(name))
    checklist.updatedContacts.add(result.personId);
  if (name === "self_review") checklist.reviewedCandidates.add(result.id);
  if (name === "subject_log") checklist.logHasNext = !!args.next?.trim();
  if (name === "project") {
    if (
      args.progress?.trim() ||
      (result.status === "done" && args.outcome?.trim())
    )
      checklist.projectProgress = true;
    if (result.status === "active" && result.next)
      checklist.continuedProjects.add(result.id);
    else checklist.continuedProjects.delete(result.id);
  }
}

export function subjectChecklistItems(runtime, ctx) {
  const checklist = ctx.subjectChecklist;
  if (!checklist || (!checklist.opportunity && !checklist.reviewedReminder))
    return [];
  const { writes } = checklist;
  const a = runtime.agent(ctx.agentId);
  const m = runtime.memory.bind(a.id);
  const now = runtime.now();
  const remaining = ctx.subjectToolBudget - (ctx.subjectToolReservations || 0);
  const canUse = (name) => ctx.allowedTools.includes(name) && remaining > 0;
  const canWrite = runtime.subject.canAutoDisclose(
    a,
    contextProtection(runtime, ctx),
  );
  const items = [];
  if (canWrite && checklist.contacts.size) {
    const [mood] = m.identity.moodHistory(1);
    if (
      canUse("mood_set") &&
      !writes.has("mood_set") &&
      mood &&
      now - mood.writtenAt >= DAY
    )
      items.push(
        "心情（mood_set）：距上次记录已超过一天，结合本轮来信，整体心情确实有变化才记。",
      );
    const personTools = ["person_note", "person_item"].filter(canUse);
    if (
      personTools.length &&
      [...checklist.contacts].some((id) => !checklist.updatedContacts.has(id))
    )
      items.push(
        `人物卡或相处事项（${personTools.join("、")}）：刚读的来信里若有新称呼、关系变化、重要约定或边界，按已有证据记录。`,
      );
  }
  if (
    !["diary_write", "diary_revise", "subject_log"].some((name) =>
      writes.has(name),
    ) &&
    (checklist.projectProgress ||
      writes.has("file_create") ||
      writes.has("file_revise"))
  ) {
    const logTools = ["subject_log", "diary_write"].filter((name) =>
      name === "subject_log" ? ctx.allowedTools.includes(name) : canUse(name),
    );
    if (logTools.length)
      items.push(
        `记录进展（${logTools.join("、")}）：有值得留给未来回看的成果，再简记发生了什么。`,
      );
  }
  if (
    canWrite &&
    canUse("self_review") &&
    checklist.candidateIds.size &&
    m.identity
      .list("self_candidates")
      .some(
        (candidate) =>
          checklist.candidateIds.has(candidate.id) &&
          !checklist.reviewedCandidates.has(candidate.id) &&
          ["pending", "observing"].includes(candidate.status) &&
          candidate.reviewAfter <= now &&
          candidate.createdAt < ctx.turnStartedAt &&
          recallBoundary(runtime, ctx).allowed(candidate),
      )
  )
    items.push(
      "Self（self_review）：有已经到期且本轮未审阅的候选，有足够证据再审阅。",
    );
  if (
    canWrite &&
    (checklist.continuedProjects.size ||
      checklist.logHasNext ||
      checklist.reviewedReminder) &&
    !writes.has("subject_next_wake") &&
    !writes.has("subject_rest") &&
    !m.state(ctx.conversation).nextCheckNote
  ) {
    const wakeTools = ["subject_next_wake", "subject_rest"].filter(canUse);
    if (wakeTools.length)
      items.push(
        `下次唤醒或休息（${wakeTools.join("、")}）：确实想继续自己的事项或休息时再安排。已批准的 QQ 提醒会自行调度。`,
      );
  }
  return items;
}
