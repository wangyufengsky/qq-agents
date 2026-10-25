import { z } from "zod";
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
    "保存或更新有来源的未完成话题/约定；不是日记或客观事实。完成/更正后更新状态，事件时间从原始来源读取。",
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
    "创建普通聊天意图（不是正式提醒）。主体不能直接发送；目标聊天可暂缓/放弃。主题跨群去重；expiresAt/eligibleAt 为 Unix 毫秒。",
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
  (n) => n !== "self_review",
);
export const SUBJECT_TOOLS = [
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
  "intent_create",
  "intent_list",
  "intent_update",
];
export function mindTool(runtime, ctx, name, args) {
  const a = runtime.agent(ctx.agentId),
    m = runtime.memory.bind(a.id),
    identity = m.identity,
    now = runtime.now();
  // Operations grants authorize a particular disclosure, not unbounded future
  // propagation through shared self/notes/intents. Ordinary cross-chat memories
  // remain agent-judged; only the pre-existing restricted Operations boundary applies.
  if (
    [
      "self_propose",
      "self_review",
      "self_withdraw",
      "work_note",
      "intent_create",
      "intent_update",
      "intent_decide",
    ].includes(name) &&
    [...ctx.privateRead].some((id) =>
      /^(operations|operations-result):/.test(id),
    )
  )
    throw Error("RESTRICTED_CONTEXT_MIND_WRITE_BLOCKED");
  if (name === "self_read")
    return {
      current: identity.withEvidence(identity.current()),
      turnSelfVersion: ctx.selfVersion,
      anchors: identity.anchors(a),
    };
  if (name === "self_history" || name === "self_candidates") {
    const rows =
      name === "self_history"
        ? identity.history()
        : identity.list("self_candidates");
    return {
      items: rows
        .slice(args.offset, args.offset + 10)
        .map((row) => identity.withEvidence(row)),
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
    return identity.saveNote(args, ctx.conversation, now);
  if (name === "work_notes") {
    const rows = identity.notes(ctx.conversation);
    return {
      items: rows.slice(args.offset, args.offset + 8),
      nextOffset: args.offset + 8 < rows.length ? args.offset + 8 : null,
    };
  }
  if (name === "intent_create") return runtime.subject.create(ctx, args);
  if (name === "intent_list") {
    const rows = identity
      .list("intentions")
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
