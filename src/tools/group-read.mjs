// @ts-check
import { z } from "zod";
import {
  readCurrentGroupInfo,
  readCurrentGroupMembers,
} from "../core/group-read.mjs";
export const groupReadDefinitions = {
  qq_group_info_read: [
    "只读当前群概况：群名、人数/容量、群主和最多20名管理员摘要。群由当前会话确定，不接受群号。默认关闭；不修改群或授予应用权限，不增加回复额度。空或不完整名册明确标注。",
    z.object({}).strict(),
  ],
  qq_group_members_read: [
    "只读当前群名册，支持owner/admin/member筛选、昵称/群名片/QQ搜索和有限分页；默认20人最多50人。每页独立实时查询并返回snapshotId，不保证跨页冻结一致。不接受群号，不修改群、不授予应用主人或运维权限。",
    z
      .object({
        role: z.enum(["all", "owner", "admin", "member"]).default("all"),
        query: z.string().trim().max(100).default(""),
        offset: z.number().int().min(0).max(10000).default(0),
        limit: z.number().int().min(1).max(50).default(20),
      })
      .strict(),
  ],
};
/** @param {any} runtime @param {any} ctx @param {string} name @param {any} args */
export function groupReadTool(runtime, ctx, name, args) {
  if (name === "qq_group_info_read") return readCurrentGroupInfo(runtime, ctx);
  if (name === "qq_group_members_read")
    return readCurrentGroupMembers(runtime, ctx, args);
  throw Error("UNKNOWN_TOOL");
}
