import {
  HOME_INTENT_TOOLS,
  HOME_READ_TOOLS,
  HOME_TOOLS,
} from "../home/policy.mjs";
import { z } from "zod";
import { toolSpecs } from "./specs.mjs";
import { profileConversation } from "../core/profile.mjs";

export const discoveryInput = z
  .object({
    names: z.array(z.string().min(1).max(100)).min(1).max(8).optional(),
    offset: z.number().int().min(0).default(0),
  })
  .strict();
const context = z
  .string()
  .min(20)
  .describe(
    "Copy the exact value after context= from the CURRENT bridge prompt; not a task explanation. Never reuse an old token or disclose it outside this parameter.",
  );
export const MCP_ENTRY_NAMES = ["bridge_tools", "bridge_call"];
const entries = {
  bridge_tools: [
    "发现当前回合实际允许的工具。省略 names 分页看名称和用途；指定至多8个 names 取得参数 schema。返回短名供 bridge_call 使用。",
    discoveryInput.extend({ context }),
  ],
  bridge_call: [
    "调用已经发现的当前回合工具。context 只放在外层，arguments 严格按该工具 schema 填写。成功以真实回执为准。",
    z
      .object({
        context,
        name: z.string().min(1).max(100),
        arguments: z.record(z.string(), z.unknown()).default({}),
      })
      .strict(),
  ],
};
export function mcpEntrySpecs() {
  return Object.entries(entries).map(([name, [description, schema]]) => {
    const inputSchema = z.toJSONSchema(schema, { target: "draft-7" });
    delete inputSchema.$schema;
    return { name, description, inputSchema };
  });
}
export function parseMcpEntry(name, input) {
  if (!entries[name]) throw Error("UNKNOWN_TOOL");
  return entries[name][1].parse(input);
}
export function scopedCatalog(runtime, ctx, input) {
  const args = discoveryInput.parse(input),
    a = runtime.assertActive(ctx);
  const current = runtime.toolsFor(a, ctx.conversation);
  const allowed = (ctx.allowedTools || current).filter((n) =>
    current.includes(n),
  );
  if (args.names?.some((n) => !allowed.includes(n)))
    throw Error("TOOL_DISABLED");
  const names = args.names || allowed.slice(args.offset, args.offset + 20);
  return {
    network: { autonomous: a.network?.autonomous === true },
    tools: toolSpecs(names).map((s) =>
      args.names ? s : { name: s.name, description: s.description },
    ),
    total: allowed.length,
    nextOffset:
      !args.names && args.offset + 20 < allowed.length
        ? args.offset + 20
        : null,
  };
}

export function toolAvailable(agent, name, conversation) {
  if (HOME_TOOLS.includes(name))
    return (
      agent.home?.enabled === true &&
      (HOME_INTENT_TOOLS.includes(name)
        ? agent.home.intents?.enabled === true &&
          (name !== "room_intent_resolve" || conversation === "@subject")
        : HOME_READ_TOOLS.includes(name) ||
          (conversation === "@subject" &&
            ((name !== "room_publish" && name !== "room_publish_snapshot") ||
              agent.home.publishing === true) &&
            (name !== "room_publish_snapshot" ||
              agent.home.projectSnapshots?.enabled === true)))
    );
  if (name === "qq_react")
    return (
      agent.behavior.actions?.react === true &&
      /^(private|group):/.test(conversation)
    );
  if (name === "qq_group_info_read" || name === "qq_group_members_read")
    return (
      agent.behavior?.actions?.groupRead === true &&
      /^group:[1-9]\d{0,19}$/.test(conversation)
    );
  if (name === "qq_peer_profile_read")
    return (
      agent.behavior?.actions?.peerProfile === true &&
      /^(private|group):/.test(conversation)
    );
  if (name === "qq_profile_read" || name === "qq_profile_update")
    return (
      agent.behavior?.actions?.profile === true &&
      profileConversation(agent, conversation)
    );
  if (name === "qq_peer_qzone_read")
    return (
      agent.behavior?.actions?.peerQzone === true &&
      /^(private|group):[1-9]\d{4,19}$/.test(conversation)
    );
  if (name === "qzone_read" || name === "qzone_post")
    return (
      agent.behavior?.actions?.qzone === true &&
      profileConversation(agent, conversation)
    );
  if (name === "qq_recall")
    return (
      agent.behavior?.actions?.recall === true &&
      /^(private|group):/.test(conversation)
    );
  if (name.startsWith("game_"))
    return (
      agent.games?.enabled === true &&
      !["game_act", "game_view"].includes(name) &&
      /^(private|group):/.test(conversation)
    );
  if (name.startsWith("github_")) return agent.github?.enabled === true;
  // These legacy readers bypass App permissions, budgets and source records.
  if (name.startsWith("social_")) return false;
  if (name.startsWith("qq_schedule_"))
    return (
      agent.scheduler.enabled &&
      agent.ownerIds.some((id) => conversation === `private:${id}`)
    );
  // Protected work never reaches the shared board, whatever the scope list says.
  if (name.startsWith("board_")) return !conversation.startsWith("@work:");
  if (name === "protected_work_submit")
    return conversation.startsWith("@work:");
  if (name.startsWith("ops_"))
    return agent.operations.enabled && conversation.startsWith("@work:");
  if (name.startsWith("app_") || name === "qq_read_share_card")
    return (
      name === "app_capabilities" ||
      (agent.apps.enabled &&
        (!name.startsWith("app_share_") || agent.apps.sharing))
    );
  return true;
}
