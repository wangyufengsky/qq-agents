// @ts-check
import { z } from "zod";
import { capturePublicPage } from "./public-screenshot.mjs";
import { saveFileImage } from "./saved-media.mjs";
import { imageMime } from "./media.mjs";
import { appService } from "../apps/tools.mjs";
import { privateGithubSources } from "../github/policy.mjs";

export const screenshotDefinitions = {
  web_screenshot: [
    "保存公开网页的可视区域截图到自己的资料库，返回 mediaId/fileId。使用独立无登录环境，不执行网页脚本，不访问内网或本机地址；脚本内容可能缺失。已授权 App 的登录内容用 app_screenshot。",
    z
      .object({
        url: z.string().url().max(4096),
        requestEventId: z.string().max(100).optional(),
      })
      .strict(),
  ],
  app_screenshot: [
    "截取自己已浏览的已授权 App 内容页可视区域并保存。只接收 recordId，截图时会短暂显示工具专用页面，不截图桌面或其他标签页，不接受本机路径。返回 mediaId/fileId，可预览后发到 QQ。",
    z
      .object({
        recordId: z.string().min(1).max(100),
        requestEventId: z.string().max(100).optional(),
      })
      .strict(),
  ],
};
/** @param {any} runtime @param {any} ctx */
function enabled(runtime, ctx) {
  const a = runtime.assertActive(ctx);
  if (
    !a.files.enabled ||
    !a.files.create ||
    !a.files.download ||
    !runtime.files
  )
    throw Error("FILE_PERMISSION_DISABLED");
  runtime.assertDisclosure(ctx);
  return a;
}
/** @param {any} runtime @param {any} ctx @param {string} name @param {any} args */
export async function screenshotTool(runtime, ctx, name, args) {
  const a = enabled(runtime, ctx);
  return runtime.files.acquire(a.id, async () => {
    let result, record;
    if (name === "app_screenshot") {
      const service = appService(runtime);
      record = service.get(ctx, args.recordId);
      if (!record.ok || !record.url) throw Error("APP_RECORD_NOT_FOUND");
      const auth = runtime.authorizeExternal(
        ctx,
        {
          tool: "app_read",
          args: { platform: record.platform, url: record.url },
        },
        {
          requestEventId: args.requestEventId,
          fixed: record.origin === "app-browser" && !record.source,
        },
      );
      service.active(ctx, record.platform, {
        spend: true,
        requested: auth.requested,
      });
      const resolved = await service.resolve(record.url, {
        signal: ctx.controller.signal,
      });
      if (resolved.platform !== record.platform)
        throw Error("APP_PLATFORM_MISMATCH");
      const shot = await service.adapter.perform(
        {
          platform: record.platform,
          operation: "screenshot",
          url: resolved.url,
          streamId: a.id,
        },
        { signal: ctx.controller.signal },
      );
      service.active(ctx, record.platform);
      if (
        typeof shot.data !== "string" ||
        shot.data.length > 12 * 1024 * 1024 ||
        !/^[A-Za-z0-9+/]+={0,2}$/.test(shot.data)
      )
        throw Error("INVALID_SCREENSHOT");
      result = {
        buffer: Buffer.from(shot.data, "base64"),
        url: resolved.url,
        scope: "app-page-viewport",
        notice: "已授权 App 内容页的可视区域截图；不是全文或视频内容理解。",
      };
    } else {
      runtime.authorizeExternal(
        ctx,
        { tool: "web_fetch", args: { url: args.url } },
        { requestEventId: args.requestEventId },
      );
      result = await (runtime.capturePublicPage || capturePublicPage)(
        args.url,
        { root: runtime.files.dir(a.id), signal: ctx.controller.signal },
      );
    }
    const current = enabled(runtime, ctx);
    if (imageMime(result.buffer) !== "image/png")
      throw Error("INVALID_SCREENSHOT");
    const file = runtime.files.put(
      a.id,
      result.buffer,
      "screenshot.png",
      current.files,
      {
        kind: "screenshot",
        url: result.url,
        conversation: ctx.conversation,
        ...(record ? { recordId: record.recordId } : {}),
      },
      false,
      privateGithubSources(ctx, runtime),
    );
    return {
      ...saveFileImage(runtime, ctx, file.fileId, {
        kind: "screenshot",
        title: record?.title || "网页截图",
        ...(record ? { appRecordId: record.recordId } : {}),
      }),
      scope: result.scope,
      blockedResources: result.blockedResources,
      notice: result.notice,
    };
  });
}
