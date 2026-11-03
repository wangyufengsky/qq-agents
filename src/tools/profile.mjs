// @ts-check
import { z } from "zod";
import { readPeerProfile } from "../core/peer-profile.mjs";
import { readProfile, updateProfile } from "../core/profile.mjs";

// Single line, no control characters: these fields are shown next to the account.
const line = (/** @type {number} */ max) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .regex(/^[^\p{Cc}\p{Cf}]+$/u);

export const profileDefinitions = {
  qq_peer_profile_read: [
    "只读当前聊天对象的 QQ 基本资料：私聊读当前对方（省略 userId 即可，不能指定别人）；群聊必须填当前群成员的 userId。空闲时间不可用，不能查询任意 QQ 号或其他聊天的人。只返回昵称、签名、群名片和群内身份等基本字段，不修改资料。",
    z
      .object({
        userId: z
          .string()
          .regex(/^[1-9][0-9]{4,19}$/)
          .optional(),
      })
      .strict(),
  ],
  qq_profile_read: [
    "读取自己 QQ 账号当前的昵称和个性签名。只在主人私聊或自己的空闲时间可用，不修改任何资料。查看当前聊天对象的资料请用 qq_peer_profile_read。",
    z.object({}).strict(),
  ],
  qq_profile_update: [
    "修改自己 QQ 账号的昵称、个性签名或头像，每次只改一项。资料所有人可见，只在主人私聊的普通回合或自己的空闲时间可用，用到别处聊天的内容或图片需要管理员授权；头像用自己图片库里的 mediaId（PNG/JPEG/WebP）。默认每天最多 3 次；结果未知时不能换 requestId 重试同一项，等管理员核对。",
    z
      .object({
        requestId: z.string().min(1).max(200),
        nickname: line(24).optional(),
        signature: line(80).optional(),
        mediaId: z
          .string()
          .regex(/^[a-f0-9]{64}$/)
          .optional(),
      })
      .strict()
      .refine(
        (x) =>
          [x.nickname, x.signature, x.mediaId].filter((v) => v !== undefined)
            .length === 1,
        "EXACTLY_ONE_FIELD",
      ),
  ],
};

/** @param {any} runtime @param {any} ctx @param {string} name @param {any} args */
export function profileTool(runtime, ctx, name, args) {
  if (name === "qq_peer_profile_read")
    return readPeerProfile(runtime, ctx, args);
  if (name === "qq_profile_read") return readProfile(runtime, ctx);
  if (name === "qq_profile_update") return updateProfile(runtime, ctx, args);
  throw Error("UNKNOWN_TOOL");
}
