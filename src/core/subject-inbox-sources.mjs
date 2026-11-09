import { allowed } from "./config.mjs";

const chat = /^(group|private):\d+$/;
const open = new Set(["waiting", "deferred"]);

export function needsSubjectReview(item) {
  return (
    chat.test(item.createdIn) &&
    open.has(item.status) &&
    (item.subjectReview
      ? !item.subjectReview.decided
      : !item.history?.some((step) => step.status === "handedoff"))
  );
}

export function contactItems(runtime, agent, now, source) {
  const memory = runtime.memory.bind(agent.id);
  const rows = memory.db
    .prepare(
      source
        ? "SELECT value FROM intentions WHERE agent_id=? AND json_extract(value,'$.createdIn')=? AND json_extract(value,'$.subjectReview.at') IS NOT NULL ORDER BY json_extract(value,'$.subjectReview.at') DESC LIMIT 64"
        : "SELECT value FROM intentions WHERE agent_id=? AND json_extract(value,'$.status') IN ('waiting','deferred') AND json_extract(value,'$.expiresAt')>?",
    )
    .all(agent.id, source ?? now);
  return rows
    .map((row) => JSON.parse(row.value))
    .filter(
      (item) =>
        runtime.subject.canAutoDisclose(agent, item) &&
        allowed(agent, item.createdIn, runtime.config) &&
        (source || needsSubjectReview(item)),
    )
    .map((item) => ({
      id: `contact:${item.id}`,
      revision: item.revision,
      source: item.createdIn,
      status: item.subjectReview?.decided || "pending",
      createdAt: item.createdAt,
      reviewAt:
        item.subjectReview?.reviewAt ??
        (item.subjectReview?.shown ? null : item.createdAt),
      usefulUntil: item.expiresAt,
      decidedAt: item.subjectReview?.at,
      decision: item.subjectReview?.action,
      proposal: {
        kind: "outbound-contact",
        target: item.target,
        topic: item.topic,
        reason: item.reason,
      },
    }));
}

export function roomItems(runtime, agent, state, now, source) {
  if (!agent.home?.enabled || !agent.home.intents?.enabled) return [];
  return runtime.home.rooms.intents
    .inboxRows(agent.id, now, source)
    .filter((row) => allowed(agent, row.source_session, runtime.config))
    .map((row) => {
      const review = state.roomReview?.[row.id];
      const deferred =
        review?.status === row.state && review.at >= (row.resolved_at ?? 0);
      return {
        id: `room:${row.id}`,
        revision:
          row.state === "pending" ? 1 : row.state === "accepted" ? 2 : 3,
        source: row.source_session,
        status: row.state,
        createdAt: row.created_at,
        reviewAt:
          deferred && !review.shown
            ? review.reviewAt
            : row.state === "pending" && !row.last_viewed_at
              ? row.created_at
              : null,
        usefulUntil: row.expires_at,
        decidedAt: deferred ? review.at : row.resolved_at,
        decision: deferred ? "defer" : undefined,
        proposal: {
          kind: "room",
          ...(row.proposal && !source
            ? { roomKind: JSON.parse(row.proposal).kind }
            : {}),
        },
      };
    });
}

export function sourceFeedback(item) {
  return {
    id: item.id,
    kind: item.proposal.kind,
    status: item.status,
    decidedAt: item.decidedAt,
    ...(item.decision ? { decision: item.decision } : {}),
    ...(item.decision === "defer" && item.reviewAt
      ? { reviewAt: item.reviewAt }
      : {}),
  };
}
