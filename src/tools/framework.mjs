import { z } from "zod";
import { createHash } from "node:crypto";
import {
  FrameworkKnowledge,
  FRAMEWORK_REPOSITORY,
} from "../core/framework-knowledge.mjs";
import { backendCapabilities } from "../backends/capabilities.mjs";
import { classifyError } from "../core/diagnostics.mjs";
import { connectionError } from "../core/backend-connections.mjs";

export const frameworkDefinitions = {
  framework_read: [
    "读 QQ Agents 框架文档/源码。无 path 列目录；path 只能用目录条目。默认本机启动快照，official 只读官方仓库固定路径，ref=installed 或 main；按 nextOffset 续读。",
    z
      .object({
        path: z.string().max(240).optional(),
        source: z.enum(["installed", "official"]).default("installed"),
        ref: z.enum(["installed", "main"]).default("installed"),
        offset: z.number().int().min(0).default(0),
        maxChars: z.number().int().min(512).max(16000).default(8000),
      })
      .strict(),
  ],
  deployment_info: [
    "查看自己的框架版本、实际后端与允许的工具；不含凭据、本机路径或其他角色信息。",
    z.object({}).strict(),
  ],
  diagnostics_read: [
    "查看自己当前聊天的只读运行诊断与排障建议。快照不是主动探测，不执行命令或重启。",
    z.object({}).strict(),
  ],
};
const safeCode = (code) => (code ? classifyError(Error(code)).code : null);
const scope = (agentId, conversation = "") =>
  createHash("sha256")
    .update(agentId + "|" + conversation)
    .digest("hex")
    .slice(0, 16);
export function frameworkTool(runtime, ctx, name, args) {
  if (ctx.conversation.startsWith("@work:"))
    throw Error("FRAMEWORK_CONTEXT_DENIED");
  const agent = runtime.agent(ctx.agentId);
  const backend = runtime.config.backends.find((b) => b.id === agent.backendId);
  if (name === "framework_read" || name === "deployment_info")
    runtime.framework ??= new FrameworkKnowledge();
  if (name === "framework_read") return runtime.framework.read(ctx, args);
  if (name === "deployment_info")
    return {
      framework: "QQ Agents",
      repository: FRAMEWORK_REPOSITORY,
      version: runtime.framework.version,
      environment: { platform: process.platform, node: process.version },
      pipeline: [
        "QQ",
        "NapCat / OneBot",
        "QQ Agents bridge",
        backend.type,
        "tool policy and delivery ledger",
        "QQ",
      ],
      backend: {
        type: backend.type,
        capabilities: backendCapabilities(backend.type),
      },
      mode: runtime.config.mode,
      tools: runtime
        .toolsFor(agent, ctx.conversation)
        .filter((n) => !ctx.allowedTools || ctx.allowedTools.includes(n)),
      read: { tool: "framework_read", path: "docs/AGENT-FRAMEWORK.md" },
      notice:
        "仅描述本进程可验证的部署信息；未探测容器、服务管理器或宿主目录，不能据此编造安装方式。框架知识不属于人格 Self。",
    };
  const backendState = runtime.backendConnections.state(agent.backendId);
  const state =
    backendState.agents.find((a) => a.id === agent.id) || backendState;
  const errors = runtime.diagnostics
    .snapshot()
    .filter((e) =>
      [scope(agent.id), scope(agent.id, ctx.conversation)].includes(e.scope),
    )
    .slice(0, 8)
    .map(({ at, code, count, component }) => ({
      at,
      code: safeCode(code),
      count,
      component,
    }));
  const blockers = runtime.blockers(agent, ctx.conversation, ctx);
  const connected = !!runtime.transports.get(agent.connectionId)?.connected;
  const unknownDeliveries = runtime.memory.db
    .prepare(
      "SELECT count(*) AS n FROM deliveries WHERE agent_id=? AND conversation=? AND status='unknown'",
    )
    .get(agent.id, ctx.conversation).n;
  return {
    sampledAt: new Date(runtime.now()).toISOString(),
    scope: "own-role/current-conversation",
    mode: runtime.config.mode,
    connection: {
      connected,
      error: safeCode(runtime.faults.get(agent.connectionId)),
    },
    backend: {
      type: backend.type,
      state: state.state,
      error: state.error ? connectionError(Error(state.error)) : null,
      checkedAt: backendState.checkedAt,
    },
    blockers,
    error: safeCode(runtime.faults.get(agent.id)),
    recentErrors: errors,
    unknownDeliveries,
    advice: [
      ...(!connected
        ? ["QQ 未连接：请主人在管理台查看连接与 NapCat 登录状态。"]
        : []),
      ...(state.state !== "ready"
        ? [
            "后端未确认就绪：请主人在管理台检查后端连接、登录及模型；不要根据未知状态推断具体原因。",
          ]
        : []),
      ...(blockers.length
        ? ["当前存在运行限制；请主人核对暂停、静默和目标权限设置，不自行解除。"]
        : []),
      ...(unknownDeliveries
        ? ["存在结果未知的投递；先核对 QQ 实际收到情况，不换 requestId 重放。"]
        : []),
      "需要深入排障时先读 docs/TROUBLESHOOTING.md；桥接或模型离线时由主人使用管理台或独立 npm run doctor。",
    ],
    notice:
      "仅从已有状态取样，backend.checkedAt 是上次后端检查时间；不保证外部服务此刻可用，不暴露日志正文或执行修复。",
  };
}
