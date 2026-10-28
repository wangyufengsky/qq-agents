import { imageMime, MAX_IMAGE_SOURCE_BYTES } from "./media.mjs";
import { imageDownloadError } from "./image-download.mjs";
import { attachmentName } from "../transport/attachments.mjs";

export async function readEventImage(
  runtime,
  ctx,
  event,
  { source, index = 0 },
) {
  const signal = ctx.controller.signal;
  const segments = event.payload?.segments || [];
  source ||= segments.some((s) => s.type === "image") ? "image" : "file";
  if (source === "image")
    return runtime.media.fromMessage(ctx.agentId, event, index, {
      signal,
      assertActive: () => runtime.assertActive(ctx),
    });
  const attachment = segments.filter((s) => s.type === "file")[index]?.data;
  if (!attachment) throw Error("IMAGE_NOT_FOUND");
  if (!/\.(gif|png|jpe?g|webp)$/i.test(attachmentName(attachment)))
    throw Error("IMAGE_ATTACHMENT_REQUIRED");
  if (Number(attachment.file_size || attachment.size) > MAX_IMAGE_SOURCE_BYTES)
    throw Error("IMAGE_TOO_LARGE");
  // Enter through the public tool gate: receive permission, source ownership,
  // connection allowlist, URL refresh and file quotas must all still apply.
  let file;
  try {
    file = await runtime.callTool(ctx, "file_download", {
      eventId: event.id,
      index,
    });
  } catch (error) {
    if (
      /^FILE_(TOO_LARGE|DOWNLOAD_|URL_DENIED|REDIRECT_)/.test(error.message) ||
      error.name === "TimeoutError"
    )
      throw imageDownloadError(error, signal);
    throw error;
  }
  const agent = runtime.assertActive(ctx);
  if (file.bytes > MAX_IMAGE_SOURCE_BYTES) throw Error("IMAGE_TOO_LARGE");
  const { buffer, meta } = runtime.files.read(
    ctx.agentId,
    file.fileId,
    Math.min(agent.files.maxBytes, MAX_IMAGE_SOURCE_BYTES),
  );
  return runtime.media.put(ctx.agentId, buffer, imageMime(buffer), {
    sourceEventId: event.id,
    sourceType: "file",
    sourceIndex: index,
    conversation: event.conversation,
    protectedOperations:
      event.protectedOperations === true || meta.protectedOperations,
    sources: meta.sources,
  });
}
