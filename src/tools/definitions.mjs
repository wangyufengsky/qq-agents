// @ts-check
import { appDefinitions } from "../apps/tools.mjs";
import { githubDefinitions } from "../github/tools.mjs";
import { mindDefinitions } from "./mind.mjs";
import { fileDefinitions } from "./file-tools.mjs";
import { savedMediaDefinitions } from "./saved-media.mjs";
import { screenshotDefinitions } from "./screenshots.mjs";
import { z } from "zod";
import { legacyDefinitions } from "./legacy.mjs";
const str = z.string(),
  limit = z.number().int().min(1).max(50).optional(),
  budget = z
    .number()
    .int()
    .min(512)
    .max(16000)
    .describe(
      "Maximum 16000 characters; omit to use default. Continue with pagination rather than increasing beyond the limit.",
    )
    .optional();
const fields = {
  title: str.max(300),
  body: str.max(32000),
  people: z.array(str).optional(),
  tags: z.array(str).optional(),
  evidence: z.array(str).optional(),
};
const animation = z
  .object({
    mode: z
      .enum(["overview", "frames"])
      .optional()
      .describe(
        "overview按时间抽样；frames按原始帧序号连续分页。默认overview。",
      ),
    limit: z
      .number()
      .int()
      .min(1)
      .max(12)
      .optional()
      .describe("每次最多12帧，默认10帧。"),
    offset: z
      .number()
      .int()
      .min(0)
      .max(1000)
      .optional()
      .describe("仅frames模式使用，从0开始；继续时使用nextFrameOffset。"),
    startMs: z.number().int().min(0).max(120000).optional(),
    endMs: z.number().int().min(1).max(120000).optional(),
  })
  .strict()
  .optional();
export const definitions = {
  ...githubDefinitions,
  ...mindDefinitions,
  ...legacyDefinitions,
  ...fileDefinitions,
  ...savedMediaDefinitions,
  ...screenshotDefinitions,
  ...appDefinitions,
  memory_search: [
    "按中文关键词、人物QQ、来源、时间、记录类型检索自己的跨会话经历/日记。命中附带同一场景的相邻发言和引用；相邻不等于同一话题。自行判断适合表达的回忆，再按ID展开原文。",
    z
      .object({
        query: str.max(200).optional(),
        contextBefore: z.number().int().min(0).max(5).optional(),
        contextAfter: z.number().int().min(0).max(5).optional(),
        contextSeconds: z.number().int().min(1).max(3600).optional(),
        person: str.optional(),
        connectionId: str.optional(),
        conversation: str.optional(),
        type: z.enum(["all", "event", "diary"]).optional(),
        kind: str.optional(),
        from: str.optional(),
        to: str.optional(),
        offset: z.number().int().min(0).optional(),
        diaryOffset: z.number().int().min(0).optional(),
        cursor: z
          .object({
            eventCeiling: z.number().int().min(0).optional(),
            beforeSeq: z.number().int().min(1).optional(),
            diaryCeiling: str.optional(),
            diaryBefore: z.object({ time: str, id: str }).strict().optional(),
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
  memory_related: [
    "读取同一来源里明确引用/撤回关系，可跨越很长时间。更正与同意仍需读原文判断；无关系不代表没有后续。按 nextAfterSeq 继续。",
    z
      .object({
        id: str,
        afterSeq: z.number().int().min(0).optional(),
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
    "按来源读取账本；aroundId按可靠消息时间展开（同时间按UUID），不能用时间邻文更新已读水位。用nextAroundBefore/After作为aroundCursor继续，保持aroundId和contextSeconds；观察/未知时间只返回锚点，明确引用用memory_related。不把有限窗口当完整历史。",
    z
      .object({
        conversation: str.optional(),
        aroundId: str.optional(),
        aroundCursor: z
          .object({
            anchorId: str,
            anchorTime: z.number().int(),
            connectionId: z.string(),
            seconds: z.number().int(),
            ceiling: z.number().int().nonnegative(),
            direction: z.enum(["before", "after"]),
            time_ms: z.number().int(),
            seq: z.number().int().nonnegative(),
          })
          .strict()
          .optional(),
        contextSeconds: z.number().int().min(1).max(3600).optional(),
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
  generated_image_list: [
    "恢复并列出本角色当前聊天的原生生图记录。生图后先调用，取得 mediaId，再用 qq_send 发送；原生界面显示图片不等于 QQ 已投递。按 nextOffset 翻图片，nextSessionOffset 翻待恢复会话。不会重新生图或自动发送。",
    z
      .object({
        offset: z.number().int().min(0).default(0),
        limit: z.number().int().min(1).max(20).default(10),
        sessionOffset: z.number().int().min(0).default(0),
      })
      .strict(),
  ],
  qq_mark_read: [
    "仅提交当前会话已看到的安全消息水位；不能使用跨会话结果的readThroughSeq。conversation_read的markReadEligible必须为true，不能超过已展示水位。",
    z.object({ throughSeq: z.number().int().min(0) }).strict(),
  ],
  qq_set_silence: [
    "让当前会话潜水指定分钟；不解除管理员暂停。",
    z.object({ minutes: z.number().int().min(0).max(10080) }).strict(),
  ],
  qq_image_read: [
    "读取某条经历的图片或图片文件附件。id须是包含附件的经历ID；默认优先image，无image时读file，也可用source指定，index从0开始按该类型计数。file需要file_download工具和文件接收权限。GIF动图自动返回按时间抽取的多帧及时间信息；animation可指定时间段或连续逐帧分页。只有拿到像素后才能描述；complete=false不能声称看完动图。",
    z
      .object({
        id: str,
        index: z.number().int().min(0).optional(),
        source: z.enum(["image", "file"]).optional(),
        animation,
      })
      .strict(),
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
  sticker_read: [
    "查看自己已读取或收藏的图片；动图默认时间抽样，animation.mode=frames按next分页，也可指定时间段。复用原始mediaId，无需重新下载。",
    z.object({ mediaId: str, animation }).strict(),
  ],
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
        source: z.enum(["auto", "native", "index"]).optional(),
        limit: z.number().int().min(1).max(20).optional(),
      })
      .strict(),
  ],
  social_read: [
    "只读平台内容。source=native 可验证已登录的原生读取；公开索引摘要不能当正文。",
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
        source: z.enum(["auto", "native", "index"]).optional(),
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
        requestEventId: str.optional(),
        maxChars: z.number().int().min(100).max(16000).optional(),
      })
      .strict(),
  ],
  voice_synthesize: [
    "使用管理员启用的本机TTS生成语音并登记audioId；这不是ASR识别，不会自动发送。",
    z.object({ text: str.min(1).max(2000) }).strict(),
  ],
  external_tools: [
    "列出管理端白名单中真实可用的外部MCP工具及参数schema；调用前发现名称和参数，不得猜测。未配置服务会明确为空。",
    z
      .object({
        serverId: str.optional(),
        offset: z.number().int().min(0).optional(),
      })
      .strict(),
  ],
  social_status: [
    "查看平台读取后端与最近探测状态；配置存在不等于已登录。",
    z.object({}).strict(),
  ],
  external_tool: [
    "调用管理端明确允许的MCP工具，服务端不接受任意服务器或工具名。图片结果登记为自己的媒体。",
    z
      .object({
        serverId: str,
        tool: str,
        requestEventId: str.optional(),
        arguments: z.record(str, z.unknown()).default({}),
        audioInput: z
          .object({
            audioId: str,
            dataArgument: str.regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/),
            mimeArgument: str.regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/).optional(),
          })
          .strict()
          .optional(),
      })
      .strict(),
  ],
};
