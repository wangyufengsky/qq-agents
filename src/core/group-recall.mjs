import { liveInput } from "./live-input.mjs";
import { quotedMessage, references } from "./person-cards.mjs";
import { prepared, recallBoundary } from "./recall-boundary.mjs";

const TALK = new Set(["message.received", "message.sent"]);
const JOINT =
  /你(?:们俩|俩|们两(?:个|位)|们).{0,24}(?:分工|分一下|分头|各自负责|商量谁)/u;
const ASSIGNMENT = /接活|接手|分工|负责|认领|接任务|接单/u;
const MAX_OPTIONAL = 2;
const REQUIRED_CHARS = 2400;

export function groupRecall(runtime, ctx, history, focus, accountId) {
  const agent = runtime.agent(ctx.agentId);
  if (
    !ctx.conversation.startsWith("group:") ||
    !agent.behavior.relationshipRecallGroups.includes(ctx.conversation.slice(6))
  )
    return null;
  const memory = runtime.memory.bind(ctx.agentId);
  const boundary = recallBoundary(runtime, ctx);
  const read = prepared(
    memory.db,
    "SELECT * FROM events WHERE agent_id=? AND id=? AND connection_id=? AND conversation=?",
  );
  const get = (id) =>
    typeof id === "string"
      ? read.get(ctx.agentId, id, agent.connectionId, ctx.conversation)
      : undefined;
  const live = (id) => liveInput(runtime, ctx.agentId, ctx.conversation, id);
  const visible = (row) =>
    row && boundary.allowed(memory.event(row, ctx.conversation, true));
  const available = (row) =>
    visible(row) &&
    TALK.has(row.kind) &&
    (row.direction === "in"
      ? live(row.id)
      : !memory.recallAnnotation(row.id).recalled);

  const correctionAllowed = ({ sourceId }) => Boolean(available(get(sourceId)));
  const annotation = (type, id, revision) => {
    const entries =
      memory.corrections.annotation(type, id, revision).corrections || [];
    const publicEntries = entries.filter(correctionAllowed);
    return {
      ...(publicEntries.length
        ? {
            corrections: publicEntries.map(({ current, scope, sourceId }) => ({
              current,
              scope,
              sourceId,
            })),
          }
        : {}),
      ...(entries.length ? { needsReview: true } : {}),
    };
  };
  const result = {
    correctionAllowed,
    required: [],
    optional: [],
  };
  const require = (entry) => {
    if (JSON.stringify([...result.required, entry]).length <= REQUIRED_CHARS)
      result.required.push(entry);
    else result.moreRequired = (result.moreRequired || 0) + 1;
  };
  const current = focus
    ? live(focus.id)
    : history.items
        .filter((item) => item.direction === "in")
        .map((item) => live(item.id))
        .filter(Boolean)
        .at(-1);
  if (!visible(current)) return result;

  const { mentions, replies } = references(current);
  const targets = replies.map((id) => quotedMessage(memory.db, current, id));
  const addressed = new Set([
    ...mentions.filter((id) => id !== "all"),
    ...targets
      .filter(Boolean)
      .map((row) => (row.direction === "out" ? accountId : row.sender_id))
      .filter(Boolean),
  ]);
  if (addressed.size && !addressed.has(accountId)) return result;

  const peers = new Set(
    runtime.config.agents
      .filter((peer) => peer.id !== ctx.agentId)
      .map((peer) => runtime.connection(peer.connectionId).accountId),
  );
  const people = new Set([current.sender_id, ...addressed]);
  people.delete(accountId);
  // A joint request without explicit targets can name a peer only when exactly
  // one other configured role spoke recently in this same source.
  if (!addressed.size && JOINT.test(current.body)) {
    const recent = prepared(
      memory.db,
      `SELECT id,sender_id,observed_at FROM events
       WHERE agent_id=? AND connection_id=? AND conversation=? AND seq<?
       AND kind='message.received' ORDER BY seq DESC LIMIT 12`,
    ).all(ctx.agentId, agent.connectionId, ctx.conversation, current.seq);
    const participants = new Set(
      recent
        .filter(
          (row) =>
            peers.has(row.sender_id) &&
            Date.parse(current.observed_at) - Date.parse(row.observed_at) <=
              300000 &&
            visible(live(row.id)),
        )
        .map((row) => row.sender_id),
    );
    if (participants.size === 1) people.add([...participants][0]);
  }

  const currentIds = new Set(history.items.map(({ id }) => id));
  if (focus) currentIds.add(focus.id);
  const cited = new Set();
  for (const row of targets) {
    if (!available(row)) {
      result.quoteNeedsReview = true;
      continue;
    }
    if (cited.has(row.id)) continue;
    cited.add(row.id);
    if (result.optional.length >= MAX_OPTIONAL || currentIds.has(row.id))
      continue;
    result.optional.push({
      id: row.id,
      quotedBy: current.id,
      senderId: row.direction === "out" ? accountId : row.sender_id,
      occurredAt: row.occurred_at,
      ...(row.body.length <= 500
        ? { body: row.body }
        : { continuation: { tool: "memory_read", id: row.id, offset: 0 } }),
      ...annotation("event", row.id),
    });
  }

  for (const personId of people) {
    const card = memory.identity.personCard(personId);
    if (
      card?.call &&
      card.evidence?.length &&
      card.evidence.every((id) => available(get(id))) &&
      boundary.allowed(card) &&
      !annotation("person", card.id, card.revision).needsReview
    )
      require({
        personId,
        id: card.id,
        call: card.call,
        sourceIds: card.evidence,
      });
    for (const item of memory.identity.personItems(personId)) {
      if (
        item.createdIn !== ctx.conversation ||
        item.writtenIn !== ctx.conversation ||
        !item.evidence?.length ||
        !boundary.allowed(item)
      )
        continue;
      const known = item.evidence.map(get);
      if (!known.every(visible)) continue;
      const subject = {
        personId,
        id: item.id,
        revision: item.revision,
        sourceIds: item.evidence,
      };
      const review = annotation("item", item.id, item.revision);
      if (item.kind === "boundary") {
        if (
          personId !== current.sender_id &&
          !addressed.has(personId) &&
          !ASSIGNMENT.test(item.body)
        )
          continue;
        if (!known.some((row) => row.sender_id === personId)) continue;
        require({
          ...subject,
          ...(item.status !== "open"
            ? { status: item.status, needsReview: true }
            : review.needsReview || !known.every(available)
              ? { ...review, needsReview: true }
              : { boundary: item.body }),
        });
      } else if (
        [item, ...(item.history || [])].some(
          (entry) =>
            entry.writtenIn === ctx.conversation &&
            entry.evidence?.some((id) => cited.has(id)),
        )
      ) {
        if (review.needsReview || !known.every(available)) {
          require({ ...subject, ...review, needsReview: true });
          continue;
        }
        const related = {
          ...subject,
          kind: item.kind,
          status: item.status,
          body: item.body,
          ...(item.outcome ? { outcome: item.outcome } : {}),
        };
        if (item.status !== "open") require(related);
        else if (result.optional.length < MAX_OPTIONAL)
          result.optional.push(related);
      }
    }
  }
  return result;
}

export function groupRecallMaterial(recall) {
  if (!recall) return undefined;
  const { required, optional, quoteNeedsReview, moreRequired } = recall;
  return {
    required,
    optional,
    ...(quoteNeedsReview
      ? { quoteNeedsReview: "引用原文已撤回、缺失或无法核对。" }
      : {}),
    ...(moreRequired
      ? {
          moreRequired,
          continuation: { tool: "person_items" },
        }
      : {}),
  };
}

export function trackGroupRecall(ctx, material) {
  if (!material) return;
  for (const item of [...material.required, ...material.optional]) {
    if (item.id) ctx.privateRead.add(item.id);
    for (const sourceId of item.sourceIds || []) ctx.privateRead.add(sourceId);
    for (const correction of item.corrections || [])
      ctx.privateRead.add(correction.sourceId);
  }
}

export function groupRecallLine(ctx, material) {
  if (
    !material ||
    (!material.required.length &&
      !material.optional.length &&
      !material.quoteNeedsReview)
  )
    return "";
  trackGroupRecall(ctx, material);
  return `本轮相关相处与原话（历史资料。称呼和边界只用于调整做法。needsReview 表示旧判断需核对，以当前纠正和来信为准）：${JSON.stringify(material)}`;
}
