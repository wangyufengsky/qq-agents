import fs from "node:fs";
import path from "node:path";
import { appService } from "../../src/apps/tools.mjs";
// Opt-in real models + real read adapters; writes terminate at the caller's loopback QQ gateway.
export async function appSharingAcceptance({
  runtime,
  memory,
  id,
  gateway,
  calls,
  root,
}) {
  // Give independent backend success cases separate synthetic recipients; peer dedupe is tested separately.
  const target = id.includes("codex") ? "private:30001" : "private:30000",
    recipient = target.slice(8);
  runtime.agent(id);
  const m = memory.bind(id),
    started = Date.now(),
    before = gateway.sent.length,
    callStart = calls.length;
  await runtime.changeAppPermissions(
    id,
    {
      enabled: true,
      sharing: true,
      platforms: ["bilibili", "zhihu", "xiaohongshu", "tieba", "heybox"],
      hours: { start: "00:00", end: "00:00", timezone: "UTC" },
      maxReadsPerTurn: 12,
      maxReadsPerDay: 100,
    },
    runtime.configStore.revision,
  );
  const a = runtime.agent(id);
  a.subject.enabled = true;
  a.allow.users = [...new Set([...a.allow.users, recipient])];
  a.subject.users = [recipient];
  a.subject.intervalMs = 86400000;
  a.subject.contactCooldownMs = 60000;
  a.behavior.preSleepWaitMs = 0;
  const observation = m.append({
    connectionId: a.connectionId,
    conversation: target,
    senderId: recipient,
    direction: "in",
    kind: "message.received",
    body: "这是本机合成验收聊天。我现在有空，可以看看你实际读到的一条科技、游戏或生活资料，简短说明你为何觉得相关，带原链接就好。",
    dedupe: "app-acceptance:" + started,
  });
  const state = m.state(target);
  m.setState(target, { ...state, lastReceivedSeq: observation.seq });
  await runtime.wake(id, "@subject", {
    reasons: [
      {
        reason: "app-acceptance",
        instruction: `这是隔离验收，QQ 只接本机测试网关。先用 app_capabilities 看真实能力，自选一个感兴趣平台入口，app_browse 取少量真实内容，再用 app_read 读其中一个记录（如果不可读可换记录）。按实际阅读范围形成一个 app_share_propose，target=${target}，说明内容与对象兴趣的具体关系；目标对象刚表示愿意看一条资料。不要发 QQ，不要等待/睡眠。不得把摘要或视频简介称为看过全文/视频。提出后结束，由目标聊天决定。`,
      },
    ],
  });
  const intent = m.identity
    .list("intentions")
    .find((i) => i.createdAt >= started && i.appShare);
  if (!intent) throw Error("APP_REAL_SUBJECT_INTENT_MISSING");
  runtime.subject.tick();
  const deadline = Date.now() + 180000;
  while (Date.now() < deadline) {
    await Promise.allSettled([...runtime.jobs]);
    const i = m.identity.get("intentions", intent.id);
    if (
      ["completed", "cancelled", "deferred", "unknown", "failed"].includes(
        i.status,
      )
    )
      break;
    await new Promise((r) => setTimeout(r, 100));
  }
  const final = m.identity.get("intentions", intent.id),
    source = appService(runtime).get(
      { agentId: id, conversation: "@subject", privateRead: new Set() },
      intent.appShare.recordId,
    ),
    used = calls.slice(callStart).filter((x) => x.agentId === id);
  const result = {
    agentId: id,
    status: final.status,
    source: {
      platform: source.platform,
      operation: source.operation,
      readingScope: source.readingScope,
      sourceMayBeTruncated: source.sourceMayBeTruncated,
    },
    toolCalls: used.map((x) => ({
      name: x.name,
      status: x.status,
      error: x.error,
    })),
    intentDecision: used.some(
      (x) => x.name === "intent_decide" && x.status === "ok",
    ),
    delivery: m.delivery("intent:" + intent.id)?.status,
    sends: gateway.sent.length - before,
    modelTurns: m.identity
      .list("model_turns")
      .filter((x) => x.startedAt >= started)
      .map((x) => ({
        status: x.status,
        conversation: x.conversation,
        usage: x.usage,
        cost: x.cost,
      })),
    elapsedMs: Date.now() - started,
  };
  fs.writeFileSync(
    path.join(root, id + "-app-sharing.json"),
    JSON.stringify(result, null, 2),
    { mode: 0o600 },
  );
  if (
    final.status !== "completed" ||
    result.delivery !== "sent" ||
    result.sends !== 1
  )
    throw Error("APP_REAL_TARGET_DELIVERY_INCOMPLETE");
  if (
    !used.some((x) => x.name === "app_read" && x.status === "ok") ||
    !used.some((x) => x.name === "app_share_send" && x.status === "ok")
  )
    throw Error("APP_REAL_TOOL_CHAIN_INCOMPLETE");
  return result;
}
