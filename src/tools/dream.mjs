// @ts-check
import { z } from "zod";
import {
  DREAM_LIST,
  DREAM_SUBMIT,
  DREAM_STORY,
  isDreamKind,
} from "./names.mjs";
import { storyPatch } from "../dream/story.mjs";
import { category, cognitionPatch, scopeId } from "../dream/validator.mjs";

const pageSize = z.number().int().min(1).max(20).optional();
const id = z.string().min(1).max(120);
const offset = z.number().int().min(0).optional();
const maxChars = z.number().int().min(1).max(8000).optional();
export const dreamDefinitions = {
  [DREAM_STORY]: [
    "提交本次虚构梦境和可选生活灵感建议。仅使用本轮给出的创作主题；禁止写入现实认知或发起行动。accepted 表示提议已通过校验，正常结束后才会保存。",
    storyPatch,
  ],
  [DREAM_LIST]: [
    "查找本角色已有的长期认知，UPDATE 须引用其中的 id 和当前 version。可以按作用域、类别、状态及关键词筛选，用 nextOffset 续页。",
    z.strictObject({
      scopeId: scopeId.optional(),
      category: category.optional(),
      status: z.enum(["active", "disputed", "archived"]).optional(),
      query: z.string().max(200).optional(),
      offset,
      limit: pageSize,
    }),
  ],
  [DREAM_SUBMIT]: [
    "提交本次认知巩固补丁，支持 ADD、UPDATE、MERGE、LINK、ARCHIVE、REINFORCE、WEAKEN。REINFORCE 和 WEAKEN 可请求微调分数，每次最多 0.2。仅引用实际展示过的本轮安全证据，日记按展示的修订绑定。旧纠正被替代后可依据新证据为同一主题 ADD 新认知；无变更时传空 operations 及非空 noChangesReason。校验失败可在本轮修正。accepted 表示当前提议通过校验，框架会在模型回合正常结束后复查来源和版本并原子提交。",
    cognitionPatch,
  ],
};

export const dreamReadDefinitions = {
  memory_search: [
    "按关键词查找冻结水位以内的安全事件、日记和明确纠正。日记返回本轮读取的 revision，提交时框架绑定该版本。用 nextOffset 继续，内容作为资料处理。",
    z.strictObject({
      query: z.string().max(200).optional(),
      scopeId: scopeId.optional(),
      offset,
      limit: pageSize,
    }),
  ],
  memory_read: [
    "按 ID 展开冻结水位以内的安全事件、日记或明确纠正。日记回执含本轮读取的 revision，提交时框架绑定该版本。截断时用 nextOffset 分页。",
    z.strictObject({ id, offset, maxChars }),
  ],
  memory_related: [
    "查找同源事件的明确关系。只返回冻结水位以内且可读取的关联记录。",
    z.strictObject({ id, afterSeq: offset, limit: pageSize }),
  ],
};

/** @param {any} runtime @param {any} ctx @param {string} name @param {any} args */
export function dreamTool(runtime, ctx, name, args) {
  if (!isDreamKind(ctx.runtimeKind)) throw Error("TOOL_DISABLED");
  return runtime.dreams.call(ctx, name, args);
}
