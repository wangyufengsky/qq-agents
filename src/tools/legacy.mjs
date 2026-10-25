import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { setTimeout as delay } from "node:timers/promises";
import { ownedEvent, readForward, forwardPayload } from "./forward.mjs";
import { mdToPlain } from "../../vendor/dsh-qq/md-to-plain.js";
import { safeFetchBuffer } from "../../vendor/social-reader/safe-fetch.js";
import { modelScheduleSchema } from "./schedule-schema.mjs";

const str = z.string(),
  id = str.min(1).max(200),
  object = (s) => z.object(s).strict();
const taskFields = {
  name: str.min(1).max(100),
  kind: z.enum(["text", "ai"]),
  text: str.max(2000).optional(),
  instruction: str.max(1000).optional(),
  targets: z
    .array(str.regex(/^(group|private):\d+$/))
    .min(1)
    .max(10)
    .optional(),
  schedule: modelScheduleSchema,
  timezone: str.optional(),
  maxRuns: z.number().int().min(1).max(100000).nullable().optional(),
  jitterMin: z.number().int().min(0).max(30).optional(),
  missedPolicy: z.enum(["skip", "grace"]).optional(),
  enabled: z.boolean().optional(),
};
export const legacyDefinitions = {
  qq_wait_for_messages: [
    "等待当前会话的新消息并观察安静窗口，暂停会立即中断；不发催话。",
    object({
      timeoutMs: z.number().int().min(1).max(600000).optional(),
      quietMs: z.number().int().min(0).max(60000).optional(),
      afterSeq: z.number().int().min(0).optional(),
    }),
  ],
  qq_set_wake_config: [
    "完成睡前观察后设置本会话睡眠及条件唤醒；不解除暂停或静默。",
    object({
      sleepMs: z.number().int().min(1000).max(31536000000).optional(),
      infinite: z.boolean().optional(),
      mode: z.enum(["active", "diving"]).optional(),
      triggers: object({
        mentions: z.boolean().optional(),
        names: z.boolean().optional(),
        private: z.boolean().optional(),
        questions: z.boolean().optional(),
        poke: z.boolean().optional(),
        participation: z.number().min(0).max(1).optional(),
        keywords: z.array(str.min(1).max(80)).max(50).optional(),
        speakerIds: z.array(str.regex(/^\d+$/)).max(50).optional(),
      }).optional(),
    }),
  ],
  qq_send_burst: [
    "按顺序发送多条文字；每条独立回执，未知结果停止，不自动重发。",
    object({
      requestId: id,
      messages: z.array(str.min(1).max(2000)).min(1).max(10),
      gapMs: z.number().int().min(0).max(30000).optional(),
    }),
  ],
  qq_list_voices: [
    "查看自己的语音库，可按名称检索和分页。",
    object({
      query: str.max(100).optional(),
      offset: z.number().int().min(0).optional(),
      limit: z.number().int().min(1).max(50).optional(),
    }),
  ],
  qq_voice_read: [
    "读取已登记语音或某条经历的语音附件；音频不等于已获得转录。",
    object({
      audioId: id.optional(),
      eventId: id.optional(),
      index: z.number().int().min(0).max(20).optional(),
    }).refine((x) => !!x.audioId !== !!x.eventId, "EXACTLY_ONE_SOURCE"),
  ],
  qq_send_voice: [
    "向绑定会话发送自己的语音，可调音量或响度；只能用库内 audioId。",
    object({
      requestId: id,
      audioId: id,
      volume: z.number().min(0.1).max(4).optional(),
      normalize: z.boolean().optional(),
      loudness: z
        .union([
          z.enum(["quiet", "normal", "loud"]),
          z.number().min(-40).max(-5),
        ])
        .optional(),
    }),
  ],
  qq_forward_read: [
    "展开已观察转发或 qq_forward_send 返回的 eventId，按预算分页；source 标明网关、内嵌内容或已确认发送来源，warnings 保留网关回查失败。节点 ID 可继续读原文或附件。",
    object({
      eventId: id,
      resourceId: str.min(1).max(256).optional(),
      offset: z.number().int().min(0).optional(),
      limit: z.number().int().min(1).max(100).optional(),
      maxChars: z
        .number()
        .int()
        .min(512)
        .max(16000)
        .describe(
          "Maximum 16000 characters; omit for default and use pagination for more content.",
        )
        .optional(),
      maxDepth: z.number().int().min(0).max(5).optional(),
    }),
  ],
  qq_forward_send: [
    "将自己的已观察记录作为合并转发发送；返回 eventId 可继续展开。保留来源署名，跨会话内容由你结合场景判断是否适合发送。",
    object({ requestId: id, eventIds: z.array(id).min(1).max(50) }),
  ],
  qq_send_poke: [
    "拍一拍当前私聊对象或当前群的成员；成功是动作回执，不伪造消息 ID。",
    object({ requestId: id, userId: str.regex(/^[1-9]\d*$/).optional() }),
  ],
  qq_schedule_create: [
    "仅管理员私聊登记结构化定时任务，登记成功后才可承诺；其他目标必须管理员批准。",
    object(taskFields),
  ],
  qq_schedule_list: ["仅管理员私聊列出该私聊创建的任务。", object({})],
  qq_schedule_update: [
    "仅管理员私聊修改自己创建的任务；跨目标修改重新等待批准。",
    object({
      id: z.number().int().min(1),
      patch: z.object(taskFields).partial().strict(),
    }),
  ],
  qq_schedule_delete: [
    "仅管理员私聊删除自己创建的任务。",
    object({ id: z.number().int().min(1) }),
  ],
  qq_cross_group_query: [
    "查询管理员明确授权的有向群链接，仅返回成员关系或消息统计，不返回原文。",
    object({
      groupId: str.regex(/^\d+$/),
      capability: z.enum(["presence", "activity"]),
      userId: str.regex(/^\d+$/).optional(),
    }),
  ],
  qq_official_stickers: [
    "读取本账号官方收藏表情，网关不支持时明确失败。",
    object({
      offset: z.number().int().min(0).optional(),
      limit: z.number().int().min(1).max(50).optional(),
    }),
  ],
  qq_official_sticker_read: [
    "将先前列出的官方收藏表情登记到自己的媒体库。",
    object({ id }),
  ],
  qq_official_sticker_collect: [
    "将已登记图片收藏到 QQ 官方表情库，走同一暂停与动作回执规则。",
    object({ requestId: id, mediaId: id }),
  ],
  qq_official_sticker_remark: [
    "修改先前列出表情的官方备注；工具需管理员单独启用。",
    object({ requestId: id, id, remark: str.max(50) }),
  ],
  slang_query: [
    "检索本会话的黑话候选与人工确认状态。",
    object({ query: str.max(100).optional() }),
  ],
  slang_submit: [
    "从本会话证据提交黑话候选，AI 不能将其标成已确认事实。",
    object({
      term: str.min(1).max(50),
      meaning: str.max(1000).optional(),
      evidenceIds: z.array(id).min(1).max(30),
    }),
  ],
  slang_research: [
    "使用管理员指定的只读检索 MCP 研究候选词；仅发送该词，不发送聊天证据。",
    object({ id }),
  ],
  ops_request_level: [
    "仅管理员私聊申请 L1/L2/L3，桥接等待独立确认；模型不能批准自己。",
    object({ level: z.enum(["L0", "L1", "L2", "L3"]) }),
  ],
  ops_read: [
    "L1 起读取管理员设置的工作区普通文件；敏感路径拒绝，内容受披露限制。",
    object({
      file: str.min(1).max(300),
      offset: z.number().int().min(0).optional(),
      maxChars: z.number().int().min(100).max(16000).optional(),
    }),
  ],
  ops_propose: [
    "提议写文件或运行允许的命令，均需管理员逐项确认；调用本身不执行。",
    z.discriminatedUnion("type", [
      object({
        type: z.literal("write"),
        file: str.min(1).max(300),
        text: str.max(100000),
      }),
      object({
        type: z.literal("run"),
        command: str.min(1).max(300),
        args: z.array(str.max(4000)).max(50).default([]),
      }),
    ]),
  ],
  ops_result: ["仅原管理员私聊读取已确认请求的结果。", object({ id })],
};
export function taintMedia(ctx, meta) {
  if (meta?.protectedOperations)
    ctx.privateRead.add("operations:media:" + meta.id);
  const sources = meta?.sources || [meta].filter(Boolean);
  for (const source of sources)
    if (source.conversation && source.conversation !== ctx.conversation)
      ctx.privateRead.add(source.eventId || source.sourceEventId || meta.id);
  ctx.persistTaint?.();
}
function disclose(runtime, ctx) {
  runtime.assertDisclosure(ctx);
}
export async function legacyTool(runtime, ctx, name, args) {
  const a = runtime.assertActive(ctx),
    mem = runtime.memory.bind(a.id);
  if (name === "qq_wait_for_messages")
    return runtime.conversations.wait(ctx, args);
  if (name === "qq_set_wake_config")
    return runtime.conversations.setWake(ctx, args);
  if (name === "qq_send_burst") {
    if (args.messages.length > a.behavior.burstMax) throw Error("BURST_LIMIT");
    const receipts = [];
    for (let i = 0; i < args.messages.length; i++) {
      if (i) {
        const gap =
          args.gapMs ??
          (runtime.random() < a.behavior.longGapProbability
            ? a.behavior.longGapMs
            : a.behavior.burstMinMs +
              Math.round(
                runtime.random() *
                  (a.behavior.burstMaxMs - a.behavior.burstMinMs),
              ));
        await delay(gap, undefined, { signal: ctx.controller.signal });
        runtime.assertActive(ctx);
      }
      try {
        receipts.push(
          await runtime.send(ctx, {
            requestId: args.requestId + ":" + i,
            text: args.messages[i],
          }),
        );
      } catch (e) {
        return {
          status: "stopped",
          receipts,
          failedIndex: i,
          error: e.message,
          doNotReplay: true,
        };
      }
    }
    return { status: "sent", receipts };
  }
  if (name === "qq_list_voices") {
    const r = runtime.voices.list(a.id, args);
    r.items.forEach((m) => taintMedia(ctx, m));
    return r;
  }
  if (name === "qq_voice_read") {
    const m = args.audioId
      ? runtime.voices.metadata(a.id, args.audioId)
      : await runtime.voices.fromMessage(
          a.id,
          ownedEvent(runtime, ctx, args.eventId),
          args.index || 0,
          a.voice,
          (params) =>
            runtime.transports.get(a.connectionId).call("get_record", params),
        );
    taintMedia(ctx, m);
    return {
      content: [
        { type: "text", text: JSON.stringify({ ...m, transcript: null }) },
        runtime.voices.read(a.id, m.id),
      ],
    };
  }
  if (name === "qq_send_voice") {
    const m = runtime.voices.metadata(a.id, args.audioId);
    taintMedia(ctx, m);
    disclose(runtime, ctx);
    return runtime.deliver(ctx, {
      requestId: args.requestId,
      intent: { kind: "voice", ...args },
      body: `[语音:${m.title}]`,
      metadata: { audioId: m.id, duration: m.duration },
      send: async (transport) => {
        const segment = await runtime.voices.segment(a.id, m.id, a.voice, args);
        runtime.assertActive(ctx);
        return transport.send(ctx.conversation, [segment]);
      },
    });
  }
  if (name === "qq_forward_read") return readForward(runtime, ctx, args);
  if (name === "qq_forward_send") {
    const events = args.eventIds.map((id) => ownedEvent(runtime, ctx, id));
    disclose(runtime, ctx);
    const memory = runtime.memory.bind(a.id),
      connection = runtime.connection(a.connectionId);
    for (const e of events)
      if (e.type === "message.received" && e.messageId) {
        if (e.connectionId !== a.connectionId)
          throw Error("FORWARD_CONNECTION_MISMATCH");
        const row = memory.db
          .prepare("SELECT * FROM events WHERE id=? AND agent_id=?")
          .get(e.id, a.id);
        e.gatewayMessageId = gatewayMessageId(
          memory.db,
          {
            agentId: a.id,
            connectionId: e.connectionId,
            conversation: e.conversation,
          },
          row,
          connection.messageIdNamespace || "onebot",
          connection.accountId,
        );
      }
    const { nodes, snapshot } = forwardPayload(
      events,
      a,
      runtime.connection(a.connectionId),
    );
    const receipt = await runtime.deliver(ctx, {
      requestId: args.requestId,
      intent: { kind: "forward", eventIds: args.eventIds },
      body: "[合并转发] " + events.length + " 条记录",
      metadata: { eventIds: args.eventIds, forwardSnapshot: snapshot },
      send: (t) => t.sendForward(ctx.conversation, nodes),
    });
    const saved = runtime.memory
      .bind(a.id)
      .db.prepare(
        "SELECT id FROM events WHERE agent_id=? AND dedupe=? AND kind='message.sent' AND status='confirmed'",
      )
      .get(a.id, "send:" + args.requestId + ":sent");
    return { ...receipt, eventId: saved?.id };
  }
  if (name === "qq_send_poke") {
    const group = ctx.conversation.startsWith("group:"),
      userId = group ? args.userId : ctx.conversation.split(":")[1];
    if (!userId) throw Error("POKE_TARGET_REQUIRED");
    if (!group && args.userId && args.userId !== userId)
      throw Error("POKE_WRONG_TARGET");
    return runtime.deliver(ctx, {
      requestId: args.requestId,
      intent: { kind: "poke", userId },
      body: `[拍一拍:${userId}]`,
      action: true,
      send: async (t) => {
        if (group) {
          const member = await t.call("get_group_member_info", {
            group_id: Number(ctx.conversation.split(":")[1]),
            user_id: Number(userId),
          });
          if (String(member?.user_id) !== userId)
            throw Error("POKE_MEMBER_NOT_FOUND");
        }
        runtime.assertActive(ctx);
        await t.call(group ? "group_poke" : "send_poke", {
          user_id: Number(userId),
          ...(group
            ? { group_id: Number(ctx.conversation.split(":")[1]) }
            : {}),
        });
        return { confirmed: true };
      },
    });
  }
  if (name === "qq_schedule_create")
    return runtime.scheduler.create(a.id, args, ctx);
  if (name === "qq_schedule_list") return runtime.scheduler.list(a.id, ctx);
  if (name === "qq_schedule_update")
    return runtime.scheduler.update(a.id, args.id, args.patch, ctx);
  if (name === "qq_schedule_delete")
    return runtime.scheduler.remove(a.id, args.id, ctx);
  if (name === "qq_cross_group_query") {
    const from = ctx.conversation.split(":")[1],
      cfg = a.crossGroup;
    if (
      !ctx.conversation.startsWith("group:") ||
      !cfg.enabled ||
      !a.allow.groups.includes(args.groupId) ||
      !cfg.links.some(
        (l) =>
          l.from === from &&
          l.to === args.groupId &&
          l.allow.includes(args.capability),
      )
    )
      throw Error("CROSS_GROUP_NOT_ALLOWED");
    const source = "group:" + args.groupId;
    mem.append({
      dedupe: "cross-group:" + randomUUID(),
      conversation: ctx.conversation,
      kind: "cross-group.query",
      direction: "internal",
      body: "跨群汇总查询",
      payload: { target: source, capability: args.capability },
    });
    if (args.capability === "activity") {
      const cutoff = new Date(runtime.now() - 86400000).toISOString(),
        hour = new Date(runtime.now() - 3600000).toISOString();
      const r = mem.db
        .prepare(
          "SELECT COUNT(*) AS messagesLast24h, SUM(CASE WHEN occurred_at>=? THEN 1 ELSE 0 END) AS messagesLastHour,COUNT(DISTINCT CASE WHEN occurred_at>=? THEN sender_id END) AS activeSpeakersLastHour,MAX(occurred_at) AS last FROM events WHERE agent_id=? AND conversation=? AND kind='message.received' AND direction='in' AND occurred_at>=?",
        )
        .get(hour, hour, a.id, source, cutoff);
      return {
        ...r,
        last: undefined,
        minutesSinceLastMessage: r.last
          ? Math.round((runtime.now() - Date.parse(r.last)) / 60000)
          : null,
      };
    }
    if (
      !args.userId ||
      !mem.db
        .prepare("SELECT 1 FROM people WHERE agent_id=? AND qq=?")
        .get(a.id, args.userId)
    )
      return { known: false, member: "unknown" };
    const t = runtime.transports.get(a.connectionId);
    if (!t?.connected) throw Error("QQ_NOT_CONNECTED");
    try {
      const r = await t.call("get_group_member_info", {
        group_id: Number(args.groupId),
        user_id: Number(args.userId),
      });
      return {
        known: true,
        member: String(r?.user_id) === args.userId ? "yes" : "unknown",
        observedAt: new Date().toISOString(),
      };
    } catch {
      return { known: true, member: "unknown" };
    }
  }
  if (name.startsWith("qq_official_sticker")) {
    const t = runtime.transports.get(a.connectionId);
    if (!t?.connected) throw Error("QQ_NOT_CONNECTED");
    if (name === "qq_official_stickers") {
      const result = await t.call("fetch_custom_face", {});
      runtime.assertActive(ctx);
      const entries = (
        Array.isArray(result) ? result : result?.faces || result?.list || []
      )
        .slice(0, 1000)
        .map((x) =>
          typeof x === "string"
            ? {
                id: "official-" + createHash("sha256").update(x).digest("hex"),
                url: x,
              }
            : {
                id: String(x.emoji_id || x.id),
                url: x.url || x.emoji_url || x.path,
                remark: x.desc || "",
              },
        );
      mem.setState("@official-stickers", { entries });
      const offset = args.offset || 0,
        limit = args.limit || 30;
      return {
        items: entries.slice(offset, offset + limit),
        total: entries.length,
        nextOffset: offset + limit < entries.length ? offset + limit : null,
      };
    }
    const entry = mem
      .state("@official-stickers")
      .entries?.find((x) => x.id === args.id);
    if (name === "qq_official_sticker_read") {
      if (!entry?.url) throw Error("STICKER_NOT_LISTED");
      const r = await safeFetchBuffer(entry.url, 8 * 1024 * 1024),
        b = Buffer.isBuffer(r) ? r : r.buffer;
      const mime =
        b[0] === 137
          ? "image/png"
          : b[0] === 255
            ? "image/jpeg"
            : b.toString("ascii", 0, 3) === "GIF"
              ? "image/gif"
              : "image/webp";
      runtime.assertActive(ctx);
      const m = runtime.media.put(a.id, b, mime, {
        title: entry.remark,
        officialId: entry.id,
        conversation: ctx.conversation,
      });
      return { ...m, content: [runtime.media.read(a.id, m.id)] };
    }
    if (name === "qq_official_sticker_collect") {
      const meta = runtime.media.metadata(a.id, args.mediaId);
      if (!meta) throw Error("MEDIA_NOT_FOUND");
      taintMedia(ctx, meta);
      disclose(runtime, ctx);
      return runtime.deliver(ctx, {
        requestId: args.requestId,
        intent: { kind: "official-collect", mediaId: args.mediaId },
        body: "[收藏官方表情]",
        action: true,
        send: async (transport) => {
          const result = await transport.call("add_custom_face", {
            file: runtime.media.segment(a.id, args.mediaId).data.file,
          });
          return { confirmed: true, emojiId: result?.emoji_id };
        },
      });
    }
    if (!entry) throw Error("STICKER_NOT_LISTED");
    if (entry.id.startsWith("official-"))
      throw Error("GATEWAY_DID_NOT_PROVIDE_EDITABLE_STICKER_ID");
    return runtime.deliver(ctx, {
      requestId: args.requestId,
      intent: { kind: "official-remark", ...args },
      body: "[修改表情备注] " + args.remark,
      action: true,
      send: async (transport) => {
        await transport.call("modify_custom_face", {
          emoji_id: entry.id,
          desc: args.remark,
        });
        return { confirmed: true };
      },
    });
  }
  if (name === "slang_query") return runtime.learner.list(ctx, args.query);
  if (name === "slang_submit") return runtime.learner.submit(ctx, args);
  if (name === "slang_research") return runtime.learner.research(ctx, args);
  if (name === "ops_request_level")
    return runtime.operations.request(ctx, args);
  if (name === "ops_read") return runtime.operations.read(ctx, args);
  if (name === "ops_propose") return runtime.operations.propose(ctx, args);
  if (name === "ops_result") return runtime.operations.result(ctx, args.id);
  throw Error("UNKNOWN_LEGACY_TOOL");
}
import { gatewayMessageId } from "../memory/message-ids.mjs";
