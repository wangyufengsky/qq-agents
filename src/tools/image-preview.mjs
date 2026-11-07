// @ts-check
import { spawn } from "node:child_process";
import { buildChildEnv } from "../core/child-env.mjs";
import { imageMime } from "./media.mjs";
import { hasOtherAnimation } from "./animation.mjs";

/** Decode only verified image bytes through a pipe, never a URL or file path.
 * @param {Buffer} data
 * @param {{maxEdge: number, signal: AbortSignal, command?: string}} options */
export async function imagePreview(
  data,
  { maxEdge, signal, command = process.env.FFMPEG_PATH || "ffmpeg" },
) {
  const mime = imageMime(data);
  if (hasOtherAnimation(data, mime))
    throw Error("ANIMATION_FORMAT_UNSUPPORTED_USE_GIF");
  if (signal.aborted) throw Error("ABORTED");
  const codec = {
    "image/png": "png",
    "image/jpeg": "mjpeg",
    "image/webp": "webp",
    "image/gif": "gif",
  }[mime];
  return new Promise((resolve, reject) => {
    const child = spawn(
      command,
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-nostdin",
        "-threads",
        "1",
        "-filter_threads",
        "1",
        "-protocol_whitelist",
        "pipe",
        "-f",
        "image2pipe",
        "-c:v",
        codec || "png",
        "-max_pixels",
        "16000000",
        "-i",
        "pipe:0",
        "-an",
        "-vf",
        `scale=w='min(${maxEdge},iw)':h='min(${maxEdge},ih)':force_original_aspect_ratio=decrease`,
        "-frames:v",
        "1",
        "-threads",
        "1",
        "-c:v",
        "mjpeg",
        "-q:v",
        "3",
        "-f",
        "image2pipe",
        "pipe:1",
      ],
      {
        stdio: ["pipe", "pipe", "ignore"],
        windowsHide: true,
        env: buildChildEnv("media"),
      },
    );
    /** @type {Buffer[]} */
    const chunks = [];
    let bytes = 0;
    /** @type {Error | undefined} */
    let failure;
    const stop = (code = "IMAGE_PREVIEW_FAILED") => {
      failure ||= Error(code);
      child.kill("SIGKILL");
    };
    const abort = () => stop("ABORTED");
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    const timer = setTimeout(() => stop(), 6000);
    child.stdout.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes > 1024 * 1024) stop("IMAGE_OUTPUT_LIMIT");
      else if (!failure) chunks.push(chunk);
    });
    child.on("error", () => {
      failure ||= Error("IMAGE_PREVIEW_FAILED");
    });
    child.stdin.on("error", (/** @type {NodeJS.ErrnoException} */ error) => {
      if (error.code !== "EPIPE") stop();
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      if (failure) return reject(failure);
      const output = Buffer.concat(chunks);
      if (code !== 0 || output.length < 12)
        return reject(Error("IMAGE_PREVIEW_FAILED"));
      resolve({
        type: "image",
        mimeType: "image/jpeg",
        data: output.toString("base64"),
      });
    });
    child.stdin.end(data);
  });
}
