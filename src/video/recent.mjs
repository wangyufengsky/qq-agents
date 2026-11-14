import { humanInput } from "../core/input-progress.mjs";
import { recallBoundary } from "../core/recall-boundary.mjs";
import { inputScope } from "../memory/input-state.mjs";
import { videoLinks } from "./bilibili.mjs";

const windows = new WeakMap();
const lifetime = 30 * 60_000;
const maxScopes = 256;

export function recentQqVideo(runtime, ctx) {
  const videos = windows.get(runtime);
  const scope = inputScope(runtime, ctx);
  const video = videos?.get(scope);
  if (!video || video.expiresAt <= runtime.now()) return null;
  const row = humanInput(runtime, ctx, video.sourceId);
  if (
    !row ||
    row.seq !== video.seq ||
    videoLinks(row)[video.linkIndex] !== video.url ||
    !recallBoundary(runtime, ctx).allowed({
      id: row.id,
      conversation: row.conversation,
      payload: JSON.parse(row.payload),
    })
  )
    return null;
  return video;
}

export function rememberQqVideo(runtime, ctx, row, linkIndex, url, durationMs) {
  const scope = inputScope(runtime, ctx);
  let videos = windows.get(runtime);
  if (!videos) windows.set(runtime, (videos = new Map()));
  if ((videos.get(scope)?.seq ?? 0) > row.seq) return;
  videos.delete(scope);
  videos.set(scope, {
    sourceId: row.id,
    seq: row.seq,
    linkIndex,
    url,
    durationMs,
    expiresAt: runtime.now() + lifetime,
  });
  if (videos.size > maxScopes) videos.delete(videos.keys().next().value);
}

export function recentQqVideoPrompt(runtime, ctx) {
  if (!ctx.allowedTools?.includes("video_read")) return "";
  const video = recentQqVideo(runtime, ctx);
  if (!video) return "";
  const { sourceId, linkIndex, durationMs } = video;
  return `本会话近期已交付的视频概览：${JSON.stringify({ sourceId, linkIndex, durationMs })}。仅在新的人类来信追问该视频时，可带该来信的经历 ID 作为 requestId，用 video_read 按时间回看。若所指视频不明确，先确认。`;
}
