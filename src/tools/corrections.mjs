import { z } from "zod";
import { humanInput } from "../core/input-progress.mjs";
import { recallBoundary } from "../core/recall-boundary.mjs";
const type = z.enum(["event", "diary", "person", "item", "note", "intent"]);
const text = z.string().trim().min(1).max(600);
export const correctionDefinitions = {
  memory_correct: [
    "保存明确纠正：personId 是被纠正认识涉及的人，sourceId 必须是本轮完整读到的当事人或管理员原始消息。targets 指旧判断所在记录的 type/id；人物卡用 person，日记 diary，相处记录 item，笔记 note，意图 intent，聊天 event。oldBelief 写具体错误判断，current 写新解释，scope 写适用事件/时间，不能扩大为永久结论。后来的解释替代已有纠正时填写 supersedes=旧纠正ID。自动标注旧记录并返回关联检查清单，按原工具更新后用 memory_correction_review 核实；不要只道歉。",
    z
      .object({
        personId: z.string().regex(/^\d{5,12}$/),
        sourceId: z.string(),
        supersedes: z.string().optional(),
        oldBelief: text,
        current: text,
        scope: text,
        kind: z.enum(["mistaken", "outdated"]),
        targets: z
          .array(z.object({ type, id: z.string().min(1) }).strict())
          .min(1)
          .max(10),
      })
      .strict(),
  ],
  memory_corrections: [
    "分页查看纠正及尚待检查的关联记录；id 读取完整一条。读取 targetId 后先检查是否需要更新，不把所有关联记录都判错。",
    z
      .object({
        id: z.string().optional(),
        offset: z.number().int().min(0).default(0),
      })
      .strict(),
  ],
  memory_correction_review: [
    "完成一项关联检查。先用原工具更新记录再 action=updated；无需改动用 unaffected 并给理由（直接纠正目标不能跳过）；日记保留当时感受、用 annotated 保留后续纠正说明。此工具不能改写原文、Self、权限或替代发送决定。",
    z
      .object({
        id: z.string(),
        expectedRevision: z.number().int().min(1),
        targetId: z.string(),
        type,
        action: z.enum(["updated", "unaffected", "annotated"]),
        reason: text,
      })
      .strict(),
  ],
};
export function correctionTool(runtime, ctx, name, args) {
  const memory = runtime.memory.bind(ctx.agentId),
    corrections = memory.corrections;
  const boundary = recallBoundary(runtime, ctx);
  if (name === "memory_correct") {
    const source = humanInput(runtime, ctx, args.sourceId);
    if (
      !source ||
      !ctx.requestEvents?.has(source.id) ||
      (source.sender_id !== args.personId &&
        !runtime.agent(ctx.agentId).ownerIds.includes(source.sender_id))
    )
      throw Error("CORRECTION_SOURCE_REQUIRED");
    boundary.assert({ id: source.id });
    return corrections.create(args, source, boundary, runtime.now());
  }
  if (name === "memory_correction_review")
    return corrections.review(args, boundary, runtime.now());
  if (args.id) return corrections.get(args.id);
  const rows = corrections.list();
  return {
    items: rows.slice(args.offset, args.offset + 5),
    total: rows.length,
    nextOffset: args.offset + 5 < rows.length ? args.offset + 5 : null,
  };
}
