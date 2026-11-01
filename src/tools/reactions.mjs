// @ts-check
import { z } from "zod";
import { react } from "../core/reactions.mjs";

export const reactionDefinitions = {
  qq_react: [
    "给当前会话的一条已知消息贴一个标准 QQ 表情，可代替一条文字回复。messageRef 用当前会话记录 ID 或消息号；faceId 必须为已登记的标准 QQ 表情编号。成功只是动作确认，不增加文字回复额度；未知投递不能换 requestId 重试。",
    z
      .object({
        requestId: z.string().min(1).max(200),
        messageRef: z.string().min(1).max(200),
        faceId: z.string().regex(/^\d{1,6}$/),
      })
      .strict(),
  ],
};

/** @param {any} runtime @param {any} ctx @param {string} name @param {any} args */
export function reactionTool(runtime, ctx, name, args) {
  if (name !== "qq_react") throw Error("UNKNOWN_TOOL");
  return react(runtime, ctx, args);
}
