import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { sourceClass } from "../core/outbound-policy.mjs";
import { containsCredential } from "../core/secrets.mjs";
import { recallBoundary } from "../core/recall-boundary.mjs";
import { activityVersion } from "../tools/activities.mjs";

const lifetime = 5 * 60_000;

function evidenceIds(record) {
  return [
    ...(record?.evidence || []),
    ...(record?.metadata?.evidence || []),
    ...(record?.counterEvidence || []),
    ...(record?.evidenceSnapshot?.references || []).map((ref) => ref.id),
    ...(record?.counterEvidenceSnapshot?.references || []).map((ref) => ref.id),
    ...(record?.sources || []).flatMap((source) => [
      source.eventId,
      source.sourceEventId,
      source.recordId,
    ]),
  ].filter((id) => typeof id === "string");
}

function safeSources(runtime, ctx, record) {
  const pending = evidenceIds(record);
  const checked = new Set();
  const memory = runtime.memory.bind(ctx.agentId);
  while (pending.length) {
    const id = pending.pop();
    if (checked.has(id)) continue;
    checked.add(id);
    if (checked.size > 100) return false;
    const kind = sourceClass(runtime, ctx, id);
    if (kind === "public-platform") continue;
    if (kind === "internal") {
      if (id.startsWith("context:")) {
        if (id !== "context:@subject") return false;
        continue;
      }
      const source = memory.db
        .prepare("SELECT payload FROM events WHERE agent_id=? AND id=?")
        .get(ctx.agentId, id);
      if (!source) return false;
      pending.push(...evidenceIds(JSON.parse(source.payload)));
    } else if (kind === "personal-diary") {
      // The idle prompt already lists its own diary titles. Keep that useful
      // while preserving the diary's origin and inherited evidence boundary.
      const diary = memory.readRecord({ id }, "@subject");
      if (diary.metadata?.writtenIn?.conversation !== "@subject") return false;
      pending.push(...evidenceIds(diary));
    } else if (kind === "personal-mind-record") {
      const note = memory.db
        .prepare(
          "SELECT value FROM work_notes WHERE agent_id=? AND id=? AND conversation='@subject'",
        )
        .get(ctx.agentId, id);
      if (!note) return false;
      pending.push(...evidenceIds(JSON.parse(note.value)));
    } else return false;
  }
  return true;
}

function fingerprint(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function safeContent(result) {
  return result && !containsCredential(JSON.stringify(result))
    ? result
    : undefined;
}
const inputSchema = z.strictObject({
  client: z.string().uuid(),
  roomEpoch: z.string().uuid(),
  agentId: z.string().min(1).max(64),
  visitId: z.string().uuid(),
  ref: z.string().uuid(),
});

export class DesktopStatusCards {
  constructor(host) {
    this.host = host;
    this.cards = new Map();
  }

  capture(ctx, name) {
    if (
      ctx.conversation !== "@subject" ||
      ctx.runtimeKind ||
      !["diary_write", "diary_revise", "project", "work_note"].includes(name)
    )
      return;
    const host = this.host,
      live = host.live,
      visit = live?.visits.get(ctx.agentId);
    if (!visit || !host.connected()) return;
    return (result) => {
      try {
        if (
          host.live !== live ||
          live.visits.get(ctx.agentId) !== visit ||
          !host.connected() ||
          ctx.controller.signal.aborted ||
          !result?.id ||
          (name !== "work_note" && !Number.isInteger(result.revision))
        )
          return;
        // A new successful write supersedes the previous activity, even if it cannot be shown.
        this.cards.delete(ctx.agentId);
        host.notify();
        const card = {
          ref: randomUUID(),
          agentId: ctx.agentId,
          visit,
          live,
          id: result.id,
          revision: result.revision,
          fingerprint: name === "work_note" ? fingerprint(result) : undefined,
          tool: name,
          evidence: [...ctx.privateRead],
          expiresAt: host.runtime.now() + lifetime,
        };
        this.cards.set(ctx.agentId, card);
        if (!this.read(card)) this.cards.delete(ctx.agentId);
        host.notify();
      } catch {
        this.cards.delete(ctx.agentId);
      }
    };
  }

  read(card) {
    const { host } = this,
      { runtime } = host;
    const agent = runtime.agent(card.agentId);
    if (
      !host.connected() ||
      host.live !== card.live ||
      host.live.visits.get(card.agentId) !== card.visit ||
      runtime.now() >= card.expiresAt ||
      runtime.blockers(agent, "@subject").length ||
      !runtime.toolsFor(agent, "@subject").includes(card.tool)
    )
      return;
    const memory = runtime.memory.bind(card.agentId);
    const ctx = {
      agentId: card.agentId,
      conversation: "@subject",
      privateRead: new Set(),
    };
    const boundary = recallBoundary(runtime, ctx, { publicOnly: true });
    // Context inherited by the saved text can be restricted after the write.
    const inherited = { evidence: card.evidence };
    if (!boundary.allowed(inherited) || !safeSources(runtime, ctx, inherited))
      return;
    if (card.tool.startsWith("diary_")) {
      const diary = memory.readRecord({ id: card.id }, "@subject");
      if (
        diary.type !== "diary" ||
        diary.revision !== card.revision ||
        diary.metadata?.writtenIn?.conversation !== "@subject" ||
        !boundary.allowed(diary) ||
        !safeSources(runtime, ctx, diary)
      )
        return;
      return safeContent({
        kind: "diary",
        title: diary.title,
        text: diary.body,
      });
    }
    if (card.tool === "work_note") {
      const row = memory.db
        .prepare(
          "SELECT value FROM work_notes WHERE agent_id=? AND id=? AND conversation='@subject'",
        )
        .get(card.agentId, card.id);
      if (!row) return;
      const note = JSON.parse(row.value);
      if (
        fingerprint(note) !== card.fingerprint ||
        note.status !== "open" ||
        !boundary.allowed(note) ||
        !safeSources(runtime, ctx, note)
      )
        return;
      return safeContent({
        kind: "work-note",
        title: "工作笔记",
        text: [note.body, note.uncertainty].filter(Boolean).join("\n"),
      });
    }
    const project = memory.identity.project(card.id);
    if (
      !project ||
      project.revision !== card.revision ||
      project.createdIn !== "@subject" ||
      project.status !== "active" ||
      !boundary.allowed(project) ||
      !safeSources(runtime, ctx, project) ||
      (project.steps || []).some(
        (step) =>
          ![
            "@subject",
            ...(project.activity?.mode === "console" ? ["@administrator"] : []),
          ].includes(step.writtenIn) ||
          !boundary.allowed(step) ||
          !safeSources(runtime, ctx, step),
      ) ||
      project.files?.length
    )
      return;
    if (project.activity) {
      if (
        project.activity.mode !== "console" ||
        project.activity.conversation !== "@subject" ||
        !project.activity.draftRevision
      )
        return;
      const entry = activityVersion(
        memory,
        project.id,
        project.activity.draftRevision,
      );
      if (
        !entry.draft ||
        !boundary.allowed(entry) ||
        !safeSources(runtime, ctx, entry) ||
        entry.files?.length
      )
        return;
      return safeContent({
        kind: "shared-draft",
        title: entry.draft.title,
        text: entry.draft.text,
      });
    }
    return safeContent({
      kind: "project",
      title: project.title,
      text: [project.why, project.steps?.[0]?.did, project.next]
        .filter(Boolean)
        .join("\n"),
    });
  }

  snapshot(agentId, visit) {
    const card = this.cards.get(agentId);
    if (!card || card.visit !== visit) return;
    try {
      const result = this.read(card);
      if (result)
        return { kind: result.kind, title: result.title, ref: card.ref };
    } catch {
      /* Missing or revoked resources are not projected. */
    }
    this.cards.delete(agentId);
  }

  open(input) {
    const parsed = inputSchema.safeParse(input);
    if (!parsed.success) throw Error("INVALID_REQUEST");
    const { client, roomEpoch, agentId, visitId, ref } = parsed.data;
    const { host } = this,
      card = this.cards.get(agentId);
    if (
      !host.refresh() ||
      host.client?.id !== client ||
      host.live?.room.epoch !== roomEpoch ||
      !card ||
      card.ref !== ref ||
      host.body.visitId(card.visit) !== visitId
    )
      throw Error("DESKTOP_VISIT_UNAVAILABLE");
    let result;
    try {
      result = this.read(card);
    } catch {
      /* Treat missing resources as unavailable. */
    }
    if (!result) throw Error("DESKTOP_VISIT_UNAVAILABLE");
    return { status: "ok", ...result };
  }
}
