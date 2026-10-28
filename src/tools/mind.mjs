import { SUBJECT_APP_TOOLS } from "../apps/policy.mjs";
import { identityAnchors } from "../core/prompts.mjs";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { privateGithubSources } from "../github/policy.mjs";
import { recallBoundary } from "../core/recall-boundary.mjs";
import {
  contextProtection,
  trackMindRecords,
} from "../core/protected-mind.mjs";
const text = z.string().min(1),
  ids = z.array(text).max(30),
  version = z.number().int().min(1);
export const mindDefinitions = {
  self_read: [
    "读取当前正式 self、身份锚点与本回合固定版本；数据库最新版不改变当前回合。",
    z.object({}).strict(),
  ],
  self_history: [
    "分页查看 self 版本历史、理由与证据。初始化模板只作历史；恢复旧版由管理端生成新版本。",
    z.object({ offset: z.number().int().min(0).default(0) }).strict(),
  ],
  self_candidates: [
    "分页读取独立候选和回顾状态；候选不是已生效人格。",
    z.object({ offset: z.number().int().min(0).default(0) }).strict(),
  ],
  self_propose: [
    "提出 self 候选，不能直接改写正式 self。提供原始经历、反例和原因；当前版本冲突应重读后重新考虑。",
    z
      .object({
        body: text.max(16000),
        reason: text.max(2000),
        evidence: ids,
        counterEvidence: ids.default([]),
        scope: z.enum(["interest", "habit", "relationship"]),
        expectedVersion: version,
      })
      .strict(),
  ],
  self_review: [
    "仅主体可延后回顾候选：采纳/修订/继续观察/拒绝。重复引用、同场争论不构成独立证据；固定账号和权限不能改。",
    z
      .object({
        id: text,
        expectedRevision: version,
        expectedVersion: version,
        action: z.enum(["accept", "revise", "observe", "reject"]),
        reason: text.max(2000),
        body: text.max(16000).optional(),
      })
      .strict(),
  ],
  self_withdraw: [
    "撤回自己会话提出的候选。",
    z.object({ id: text, expectedRevision: version }).strict(),
  ],
  work_note: [
    "保存或更新有来源的未完成话题/约定；不是日记或客观事实。允许保存受保护内容，自动继承且保留上下文及来源的保护标记；保存不授予对外披露权限。完成/更正后更新状态，事件时间从原始来源读取。",
    z
      .object({
        id: text.optional(),
        body: text.max(2000),
        evidence: ids,
        uncertainty: text.max(1000),
        status: z.enum(["open", "completed", "corrected"]).default("open"),
      })
      .strict(),
  ],
  work_notes: [
    "分页读当前会话未完成工作笔记及来源可用性。",
    z.object({ offset: z.number().int().min(0).default(0) }).strict(),
  ],
  intent_create: [
    "创建普通聊天意图（不是正式提醒），允许带保护标记保存。主体不能直接发送；目标聊天可暂缓/放弃，受保护资料不向未经授权的目标自动交接或发送。主题跨群去重；expiresAt/eligibleAt 为 Unix 毫秒。",
    z
      .object({
        topic: text.max(300),
        target: text.regex(/^(group|private):\d+$/),
        reason: text.max(2000),
        background: z.string().max(3000).default(""),
        evidence: ids.default([]),
        eligibleAt: z.number().int().optional(),
        expiresAt: z.number().int(),
        expectsResponse: z.boolean().default(false),
      })
      .strict(),
  ],
  intent_list: [
    "读取主体意图状态和发送结果；可按目标和有效状态分页。已交接不能重复交接。",
    z
      .object({
        offset: z.number().int().min(0).default(0),
        target: text.regex(/^(group|private):\d+$/).optional(),
        activeOnly: z.boolean().default(false),
      })
      .strict(),
  ],
  intent_update: [
    "取消或暂缓有效意图；需要 revision，不能修改已发送内容。",
    z
      .object({
        id: text,
        expectedRevision: version,
        action: z.enum(["cancel", "defer"]),
        reason: text.max(2000),
        eligibleAt: z.number().int().optional(),
      })
      .strict(),
  ],
  subject_log: [
    "空闲时间结束前记一笔：做了什么、发现了什么、下次想接着做什么。下次空闲时间会先看到最近几条，管理员也能看到。选择休息也要记录原因。found 可附上浏览/读取工具返回的 sourceRecordId。",
    z
      .object({
        did: z.enum([
          "browsed",
          "searched",
          "read",
          "wrote",
          "reviewed",
          "reached-out",
          "rested",
        ]),
        summary: text.max(200),
        found: z
          .array(
            z
              .object({
                title: text.max(120),
                sourceRecordId: text.max(80).optional(),
              })
              .strict(),
          )
          .max(3)
          .default([]),
        next: z.string().max(100).default(""),
        restReason: z
          .enum(["recent", "no-interest", "budget", "quiet"])
          .optional(),
      })
      .strict(),
  ],
  intent_decide: [
    "仅目标聊天结合现场决定 send/defer/cancel/complete。send 后使用启用 QQ 工具发一次；无关来信不能 complete，完成需提供相关新来信证据。",
    z
      .object({
        id: text,
        expectedRevision: version,
        action: z.enum(["send", "defer", "cancel", "complete"]),
        reason: text.max(2000),
        evidence: ids.optional(),
      })
      .strict(),
  ],
};
export const CHAT_MIND_TOOLS = Object.keys(mindDefinitions).filter(
  (n) => n !== "self_review" && n !== "subject_log",
);
export const SUBJECT_TOOLS = [
  "github_capabilities",
  "github_search",
  "github_read",
  ...SUBJECT_APP_TOOLS,
  "memory_search",
  "memory_related",
  "memory_read",
  "conversation_read",
  "diary_write",
  "diary_revise",
  "self_read",
  "self_history",
  "self_candidates",
  "self_review",
  "self_propose",
  "self_withdraw",
  "work_note",
  "work_notes",
  "file_list",
  "file_create",
  "intent_create",
  "intent_list",
  "intent_update",
  "subject_log",
];
function executeMindTool(runtime, ctx, name, args) {
  const a = runtime.agent(ctx.agentId),
    m = runtime.memory.bind(a.id),
    identity = m.identity,
    now = runtime.now();
  // Shared self cannot carry restricted material. Scoped notes and intentions
  // instead retain protection on storage, reads, handoff and actual delivery.
  if (
    ["self_propose", "self_review", "self_withdraw"].includes(name) &&
    (privateGithubSources(ctx, runtime).length > 0 ||
      [...ctx.privateRead].some((id) =>
        /^(operations|operations-result|github-private):/.test(id),
      ))
  )
    throw Error("RESTRICTED_CONTEXT_MIND_WRITE_BLOCKED");
  if (name === "self_read")
    return {
      current: (() => {
        const current = identity.withEvidence(identity.current());
        recallBoundary(runtime, ctx).assert(current);
        return current;
      })(),
      turnSelfVersion: ctx.selfVersion,
      anchors: identity.anchors(a),
      identity: identityAnchors(runtime.config, a),
    };
  if (name === "self_history" || name === "self_candidates") {
    const rows =
      name === "self_history"
        ? identity.history()
        : identity.list("self_candidates");
    return {
      items: recallBoundary(runtime, ctx).rows(
        rows
          .slice(args.offset, args.offset + 10)
          .map((row) => identity.withEvidence(row)),
      ),
      nextOffset: args.offset + 10 < rows.length ? args.offset + 10 : null,
    };
  }
  if (name === "self_propose")
    return identity.propose(args, ctx, a.selfPolicy, now);
  if (name === "self_review")
    return identity.review(args, ctx, a.selfPolicy, now);
  if (name === "self_withdraw")
    return identity.withdraw(args.id, args.expectedRevision, ctx, now);
  if (name === "work_note")
    return identity.saveNote(
      args,
      ctx.conversation,
      now,
      contextProtection(runtime, ctx),
    );
  if (name === "work_notes") {
    const rows = recallBoundary(runtime, ctx).rows(
      identity.notes(ctx.conversation),
    );
    return {
      items: rows.slice(args.offset, args.offset + 8),
      nextOffset: args.offset + 8 < rows.length ? args.offset + 8 : null,
    };
  }
  if (name === "subject_log") {
    if (ctx.conversation !== "@subject") throw Error("TOOL_DISABLED");
    if (args.did === "rested" && !args.restReason)
      throw Error("SUBJECT_LOG_REQUIRES_REASON");
    const record = m.append({
      dedupe: "subject-log:" + ctx.turnId + ":" + randomUUID(),
      conversation: "@subject",
      kind: "subject.log",
      direction: "internal",
      status: "observed",
      body: [args.summary, args.next && "下次：" + args.next]
        .filter(Boolean)
        .join("\n"),
      payload: {
        ...args,
        turnId: ctx.turnId,
        // Inherit what this turn read, like work notes do.
        ...contextProtection(runtime, ctx),
      },
    });
    ctx.subjectLogged = true;
    return { id: record.id, recorded: true };
  }
  if (name === "intent_create") return runtime.subject.create(ctx, args);
  if (name === "intent_list") {
    const rows = recallBoundary(runtime, ctx)
      .rows(identity.list("intentions"))
      .filter(
        (i) =>
          (!args.target || i.target === args.target) &&
          (!args.activeOnly ||
            ![
              "cancelled",
              "completed",
              "expired",
              "failed",
              "unknown",
            ].includes(i.status)),
      );
    return {
      items: rows.slice(args.offset, args.offset + 20),
      total: rows.length,
      nextOffset: args.offset + 20 < rows.length ? args.offset + 20 : null,
    };
  }
  if (name === "intent_update") return runtime.subject.update(ctx, args);
  if (name === "intent_decide") return runtime.subject.decide(ctx, args);
  throw Error("UNKNOWN_TOOL");
}

// Frozen excerpts retain the same disclosure boundary as ordinary memory reads,
// including when the live record has subsequently disappeared.
export function mindTool(runtime, ctx, name, args) {
  const result = executeMindTool(runtime, ctx, name, args);
  if (name === "work_note" || name === "work_notes")
    trackMindRecords(
      runtime,
      ctx,
      name === "work_note" ? [result] : result.items,
    );
  if (name.startsWith("intent_"))
    trackMindRecords(
      runtime,
      ctx,
      name === "intent_list" ? result.items : [result],
      "intent",
    );
  for (const row of [result, result?.current, ...(result?.items || [])]) {
    for (const proof of [row?.evidenceSnapshot, row?.counterEvidenceSnapshot]) {
      for (const ref of proof?.references || []) {
        if (
          ref.type === "diary" ||
          (ref.metadata?.conversation !== ctx.conversation &&
            !(
              ref.metadata?.kind === "app.observation" &&
              ref.metadata?.origin === "app-browser"
            ))
        )
          ctx.privateRead.add(ref.id);
      }
    }
  }
  ctx.persistTaint?.();
  return result;
}
