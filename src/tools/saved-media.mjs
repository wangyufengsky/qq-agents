import { z } from "zod";
import { imageMime } from "./media.mjs";
import { taintMedia } from "./legacy.mjs";

export const savedMediaDefinitions = {
  image_save: [
    "将公开图片链接或自己文件库中的图片保存到专属图片库，返回 mediaId 和 fileId。url/fileId 二选一；不接受本机路径。之后用 sticker_read 预览、qq_send(mediaId) 发图片，或 qq_send_file(fileId) 发原文件。保留来源，不代表已阅读图片。",
    z
      .object({
        url: z.string().url().max(8192).optional(),
        fileId: z
          .string()
          .regex(/^[a-f0-9]{64}$/)
          .optional(),
        title: z.string().min(1).max(200).optional(),
      })
      .strict()
      .refine((x) => !!x.url !== !!x.fileId, "EXACTLY_ONE_SOURCE"),
  ],
  media_list: [
    "分页搜索自己保存的图片、网页/App 截图和生成图，返回可预览、发送的 mediaId。不会重新下载或自动发送。",
    z
      .object({
        query: z.string().max(100).default(""),
        offset: z.number().int().min(0).default(0),
        limit: z.number().int().min(1).max(20).default(10),
      })
      .strict(),
  ],
};
export function saveFileImage(runtime, ctx, fileId, extra = {}) {
  const a = runtime.assertActive(ctx);
  if (!a.files.enabled || !runtime.files)
    throw Error("FILE_PERMISSION_DISABLED");
  const { buffer, meta } = runtime.files.read(a.id, fileId, a.files.maxBytes);
  taintMedia(ctx, meta);
  const saved = runtime.media.put(a.id, buffer, imageMime(buffer), {
    saved: true,
    fileId,
    title: extra.title || meta.name,
    createdAt: meta.createdAt,
    kind: "download",
    sourceType: "saved-file-image",
    conversation: ctx.conversation,
    sources: meta.sources,
    protectedOperations: meta.protectedOperations,
    protectedRepositories: meta.protectedRepositories,
    ...extra,
  });
  return {
    mediaId: saved.id,
    fileId,
    mimeType: saved.mimeType,
    bytes: saved.bytes,
    notice: "已保存，可用 sticker_read 预览；QQ 收到以发送回执为准。",
  };
}
export async function savedMediaTool(runtime, ctx, name, args) {
  runtime.assertActive(ctx);
  if (name === "media_list") {
    const page = runtime.media.saved(ctx.agentId, args);
    for (const meta of page.items) taintMedia(ctx, meta);
    return {
      ...page,
      items: page.items.map((x) => ({
        mediaId: x.id,
        fileId: x.fileId,
        title: x.title || "生成图",
        kind: x.kind || (x.generatedBy ? "generated" : "image"),
        mimeType: x.mimeType,
        bytes: x.bytes,
        createdAt: x.createdAt,
        appRecordId: x.appRecordId,
      })),
    };
  }
  let fileId = args.fileId;
  if (args.url)
    fileId = (await runtime.callTool(ctx, "file_download", { url: args.url }))
      .fileId;
  return saveFileImage(
    runtime,
    ctx,
    fileId,
    args.title ? { title: args.title } : {},
  );
}
