import { z } from "zod";
import { legacyDefinitions, legacyTool, taintMedia } from "./legacy.mjs";
import { SocialReader } from "../../vendor/social-reader/reader.mjs";
import { safeFetch } from "../../vendor/social-reader/safe-fetch.js";

const str = z.string(),
  limit = z.number().int().min(1).max(50).optional(),
  budget = z.number().int().min(512).max(16000).optional();
const fields = {
  title: str.max(300),
  body: str.max(32000),
  people: z.array(str).optional(),
  tags: z.array(str).optional(),
  evidence: z.array(str).optional(),
};
const definitions = {
  ...legacyDefinitions,
  memory_search: [
    "按中文关键词、人物QQ、来源、时间、记录类型检索自己的跨会话经历/日记。命中附带同一场景的相邻发言和引用；相邻不等于同一话题。自行判断适合表达的回忆，再按ID展开原文。",
    z
      .object({
        query: str.max(200).optional(),
        contextBefore: z.number().int().min(0).max(5).optional(),
        contextAfter: z.number().int().min(0).max(5).optional(),
        contextSeconds: z.number().int().min(1).max(3600).optional(),
        person: str.optional(),
        conversation: str.optional(),
        type: z.enum(["all", "event", "diary"]).optional(),
        kind: str.optional(),
        from: str.optional(),
        to: str.optional(),
        offset: z.number().int().min(0).optional(),
        diaryOffset: z.number().int().min(0).optional(),
        cursor: z
          .object({
            eventOffset: z.number().int().min(0),
            diaryOffset: z.number().int().min(0),
            eventsDone: z.boolean(),
            diariesDone: z.boolean(),
          })
          .strict()
          .optional(),
        limit,
        maxChars: budget,
      })
      .strict(),
  ],
  memory_read: [
    "按ID分页展开自己的记录，可读日记历史版本。",
    z
      .object({
        id: str,
        offset: z.number().int().min(0).optional(),
        maxChars: budget,
        revision: z.number().int().min(1).optional(),
      })
      .strict(),
  ],
  conversation_read: [
    "按来源读取消息或指定记录前后文；不把有限窗口当完整历史。",
    z
      .object({
        conversation: str.optional(),
        aroundId: str.optional(),
        connectionId: str.optional(),
        afterSeq: z.number().int().min(0).optional(),
        beforeSeq: z.number().int().min(1).optional(),
        limit,
        maxChars: budget,
      })
      .strict(),
  ],
  diary_write: [
    "自由写个人日记。标题和正文必填，不强制频率，不自动重写人格。",
    z.object(fields).strict(),
  ],
  diary_revise: [
    "修订个人日记，必须传当前版本，旧版本保留。",
    z
      .object({ id: str, expectedRevision: z.number().int().min(1), ...fields })
      .strict(),
  ],
  qq_send: [
    "向服务端绑定的当前会话发送文字或已登记图片。requestId唯一，超时未知绝不换ID重发。",
    z
      .object({
        requestId: str.min(1).max(200),
        text: str.max(8000).optional(),
        replyTo: str.optional(),
        atUserId: str.optional(),
        mediaId: str.optional(),
      })
      .strict(),
  ],
  qq_mark_read: [
    "提交已看到的安全消息水位；不能超过工具返回的 readThroughSeq。",
    z.object({ throughSeq: z.number().int().min(0) }).strict(),
  ],
  qq_set_silence: [
    "让当前会话潜水指定分钟；不解除管理员暂停。",
    z.object({ minutes: z.number().int().min(0).max(10080) }).strict(),
  ],
  qq_image_read: [
    "读取某条经历里的图片像素。只有成功拿到图片后才能描述内容。",
    z.object({ id: str, index: z.number().int().min(0).optional() }).strict(),
  ],
  sticker_list: [
    "搜索自己的表情收藏。",
    z.object({ query: str.max(100).optional() }).strict(),
  ],
  sticker_collect: [
    "收藏已经读取或生成的图片，备注与标签可选。",
    z
      .object({
        mediaId: str,
        title: str.max(300),
        tags: z.array(str.max(80)).optional(),
      })
      .strict(),
  ],
  sticker_read: ["查看收藏的表情像素。", z.object({ mediaId: str }).strict()],
  social_search: [
    "只读平台搜索；使用已配置的浏览器登录与并发锁。",
    z
      .object({
        platform: z.enum([
          "zhihu",
          "xiaohongshu",
          "bilibili",
          "weibo",
          "twitter",
          "threads",
        ]),
        query: str.max(200),
        limit: z.number().int().min(1).max(20).optional(),
      })
      .strict(),
  ],
  social_read: [
    "只读平台内容。",
    z
      .object({
        platform: z.enum([
          "zhihu",
          "xiaohongshu",
          "bilibili",
          "weibo",
          "twitter",
          "threads",
        ]),
        url: str,
      })
      .strict(),
  ],
  social_comments: [
    "只读平台评论。",
    z
      .object({
        platform: z.enum([
          "zhihu",
          "xiaohongshu",
          "bilibili",
          "weibo",
          "twitter",
        ]),
        url: str,
        limit: z.number().int().min(1).max(20).optional(),
      })
      .strict(),
  ],
  web_fetch: [
    "读取公开网页文本，阻止内网地址与危险重定向。",
    z
      .object({
        url: str,
        maxChars: z.number().int().min(100).max(16000).optional(),
      })
      .strict(),
  ],
  external_tool: [
    "调用管理端明确允许的MCP工具，服务端不接受任意服务器或工具名。图片结果登记为自己的媒体。",
    z
      .object({
        serverId: str,
        tool: str,
        arguments: z.record(str, z.unknown()).default({}),
      })
      .strict(),
  ],
};
export const TOOL_NAMES = Object.keys(definitions);
export function toolSpecs(enabled = TOOL_NAMES, { context = false } = {}) {
  return enabled
    .filter((n) => definitions[n])
    .map((name) => {
      const [description, schema] = definitions[name];
      const inputSchema = z.toJSONSchema(schema, { target: "draft-7" });
      inputSchema.type = "object";
      if (context) {
        const add = (s) => {
          if (s.properties) {
            s.properties.context = {
              type: "string",
              minLength: 20,
              description:
                "Opaque authorization token: copy the exact value after context= from the CURRENT bridge prompt. This is not a task explanation or conversation summary. Never invent it, reuse a previous turn's token, or disclose it outside this tool parameter.",
            };
            s.required = [...(s.required || []), "context"];
          }
          for (const key of ["anyOf", "oneOf"]) if (s[key]) s[key].forEach(add);
        };
        add(inputSchema);
      }
      delete inputSchema.$schema;
      return { name, description, inputSchema };
    });
}
function track(ctx, items) {
  for (const row of items) {
    if (row.protectedOperations)
      ctx.privateRead.add("operations:diary:" + row.id);
    if (
      [
        "agent-judged-recollection",
        "agent-judged-diary",
        "private-recollection-do-not-disclose",
      ].includes(row.disclosure)
    ) {
      ctx.privateRead.add(row.id);
      for (const m of [
        ...(row.scene?.messages || []),
        ...(row.scene?.quoted || []),
      ])
        ctx.privateRead.add(m.id);
    }
  }
  ctx.persistTaint?.();
}
function protect(ctx, value) {
  if (JSON.stringify(value).includes(ctx.token))
    throw Error("CAPABILITY_EXFILTRATION_BLOCKED");
}
export async function dispatchTool(runtime, ctx, name, input) {
  const definition = definitions[name];
  if (!definition) throw Error("UNKNOWN_TOOL");
  const args = definition[1].parse(input),
    mem = runtime.memory.bind(ctx.agentId);
  protect(ctx, args);
  if (legacyDefinitions[name]) return legacyTool(runtime, ctx, name, args);
  if (name === "memory_search") {
    const r = mem.search(args, ctx.conversation);
    track(ctx, [...r.items, ...r.diaries]);
    return r;
  }
  if (name === "memory_read") {
    const r = mem.read(args, ctx.conversation);
    track(ctx, [r]);
    return r;
  }
  if (name === "conversation_read") {
    const r = mem.conversation(
      { conversation: ctx.conversation, ...args },
      ctx.conversation,
    );
    track(ctx, r.items);
    if (r.items.every((x) => x.conversation === ctx.conversation))
      ctx.shownSeq = Math.max(ctx.shownSeq, r.readThroughSeq);
    return r;
  }
  if (name === "diary_write" || name === "diary_revise") {
    const protectedOperations = [...ctx.privateRead].some((id) =>
      /^(operations|operations-result):/.test(id),
    );
    return name === "diary_write"
      ? mem.diaryWrite(
          args,
          "ai-diary",
          {
            conversation: ctx.conversation,
            connectionId: runtime.agent(ctx.agentId).connectionId,
          },
          protectedOperations,
        )
      : mem.diaryRevise(args, protectedOperations);
  }
  if (name === "qq_send") return runtime.send(ctx, args);
  if (name === "qq_mark_read") {
    if (args.throughSeq > ctx.shownSeq) throw Error("UNSEEN_WATERMARK");
    const state = mem.state(ctx.conversation);
    state.readThroughSeq = Math.max(state.readThroughSeq || 0, args.throughSeq);
    mem.setState(ctx.conversation, state);
    return { readThroughSeq: state.readThroughSeq };
  }
  if (name === "qq_set_silence") {
    const state = mem.state(ctx.conversation);
    state.silenceUntil = runtime.now() + args.minutes * 60000;
    mem.setState(ctx.conversation, state);
    return { silenceUntil: state.silenceUntil };
  }
  if (name === "qq_image_read") {
    const row = mem.db
      .prepare("SELECT * FROM events WHERE id=? AND agent_id=?")
      .get(args.id, ctx.agentId);
    if (!row) throw Error("RECORD_NOT_FOUND");
    const event = mem.event(row, ctx.conversation);
    track(ctx, [event]);
    const media = await runtime.media.fromMessage(
      ctx.agentId,
      event,
      args.index || 0,
    );
    return {
      content: [
        { type: "text", text: JSON.stringify(media) },
        runtime.media.read(ctx.agentId, media.id),
      ],
    };
  }
  if (name === "sticker_list") {
    const rows = runtime.media.list(ctx.agentId, args.query || "");
    rows.forEach((m) => taintMedia(ctx, m));
    return rows;
  }
  if (name === "sticker_collect")
    return runtime.media.collect(ctx.agentId, args.mediaId, args);
  if (name === "sticker_read") {
    const meta = runtime.media.metadata(ctx.agentId, args.mediaId);
    if (meta?.conversation && meta.conversation !== ctx.conversation)
      ctx.privateRead.add(meta.sourceEventId || args.mediaId);
    ctx.persistTaint?.();
    return { content: [runtime.media.read(ctx.agentId, args.mediaId)] };
  }
  if (
    name === "web_fetch" ||
    name.startsWith("social_") ||
    name === "external_tool"
  ) {
    // External queries can also disclose remembered private content.
    runtime.assertDisclosure(ctx, { external: true });
    if (name === "web_fetch")
      return safeFetch(args.url, args.maxChars || 12000);
    runtime.social ??= new SocialReader();
    if (name === "social_search") return runtime.social.perform("search", args);
    if (name === "social_read") return runtime.social.perform("read", args);
    if (name === "social_comments")
      return runtime.social.perform("comments", args);
    const backend = runtime.backends.get(ctx.agentId);
    if (!backend?.external) throw Error("EXTERNAL_TOOLS_UNAVAILABLE");
    const result = await backend.external.call(
      args.serverId,
      args.tool,
      args.arguments,
    );
    runtime.assertActive(ctx);
    const content = [];
    for (const item of result.content || []) {
      if (item.type === "image") {
        const media = runtime.media.put(
          ctx.agentId,
          Buffer.from(item.data, "base64"),
          item.mimeType,
          {
            generatedBy: args.serverId + ":" + args.tool,
            conversation: ctx.conversation,
          },
        );
        content.push(
          { type: "text", text: JSON.stringify({ generatedMedia: media }) },
          item,
        );
      } else if (item.type === "audio") {
        const a = runtime.agent(ctx.agentId),
          audio = await runtime.voices.put(
            ctx.agentId,
            Buffer.from(item.data, "base64"),
            a.voice,
            { conversation: ctx.conversation, title: "生成语音" },
          );
        content.push(
          { type: "text", text: JSON.stringify({ generatedAudio: audio }) },
          runtime.voices.read(ctx.agentId, audio.id),
        );
      } else if (item.type === "text")
        content.push({ type: "text", text: item.text.slice(0, 16000) });
    }
    return { content, isError: !!result.isError };
  }
  throw Error("UNKNOWN_TOOL");
}
export function mcpResult(value) {
  return value?.content
    ? value
    : { content: [{ type: "text", text: JSON.stringify(value) }] };
}
