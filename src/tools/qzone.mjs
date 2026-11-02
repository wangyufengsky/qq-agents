// @ts-check
import { z } from "zod";
import { readPeerQzone } from "../core/peer-qzone.mjs";
import { postQzone, readQzone } from "../core/qzone.mjs";

export const qzoneDefinitions = {
  qq_peer_qzone_read: [
    "读取当前私聊对象或当前群一名经网关实时核实的成员最近的 QQ 空间说说。私聊 userId 可省略且不能指定别人，群聊必须填当前成员 userId。默认5条最多10条，仅文字、时间、图片数和评论数，不读评论或图片内容。实验功能默认关闭；好友可见资料不能自动向群或其他聊天披露；群内读取会使本模型会话后续回复持续受披露限制，跨回合仍需管理员批准，不增加回复额度。",
    z
      .object({
        userId: z
          .string()
          .regex(/^[1-9]\d{4,19}$/)
          .optional(),
        limit: z.number().int().min(1).max(10).optional(),
      })
      .strict(),
  ],
  qzone_read: [
    "读取自己 QQ 空间最近的几条说说（文字、时间、评论数和图片数），不读评论内容。实验功能，只在主人私聊或自己的空闲时间可用。",
    z
      .object({
        limit: z.number().int().min(1).max(10).optional(),
      })
      .strict(),
  ],
  qzone_post: [
    "以自己的 QQ 账号发一条所有人可见的纯文字 QQ 空间说说。实验功能：依赖 QQ 空间网页接口，可能失效或触发风控。只在主人私聊的普通回合或自己的空闲时间可用，默认每天最多 2 条；结果未知时说说可能已经发出，不能换 requestId 再发，等管理员核对。",
    z
      .object({
        requestId: z.string().min(1).max(200),
        // Line breaks are fine in a post; other control and bidi-override
        // characters could disguise what is published.
        content: z
          .string()
          .trim()
          .min(1)
          .max(1000)
          .regex(/^(?:[^\p{Cc}‪-‮⁦-⁩]|\n)+$/u),
      })
      .strict(),
  ],
};

/** @param {any} runtime @param {any} ctx @param {string} name @param {any} args */
export function qzoneTool(runtime, ctx, name, args) {
  if (name === "qq_peer_qzone_read") return readPeerQzone(runtime, ctx, args);
  if (name === "qzone_read") return readQzone(runtime, ctx, args);
  if (name === "qzone_post") return postQzone(runtime, ctx, args);
  throw Error("UNKNOWN_TOOL");
}
