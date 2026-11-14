import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { buildChildEnv } from "../core/child-env.mjs";

export const MAX_DESKTOP_VIDEO_BYTES = 256 * 1024 * 1024;
export const MAX_VIDEO_SECONDS = 72 * 60;
export const VIDEO_EXTENSIONS = ["mp4", "mov", "webm", "mkv"];
const demuxers = "mov,matroska,webm";
const execute = promisify(execFile);
const read = async (command, args, signal, maxBuffer = 2 * 1024 * 1024) => {
  signal.throwIfAborted();
  try {
    const { stdout } = await execute(command, args, {
      signal,
      maxBuffer,
      encoding: "buffer",
      env: buildChildEnv("media"),
      windowsHide: true,
      killSignal: "SIGKILL",
    });
    signal.throwIfAborted();
    return stdout;
  } catch (error) {
    signal.throwIfAborted();
    throw Error(
      error.code === "ENOENT"
        ? "VIDEO_DECODER_UNAVAILABLE"
        : "VIDEO_DECODE_FAILED",
      { cause: error },
    );
  }
};

export async function probeVideo(file, signal) {
  const result = await read(
    process.env.FFPROBE_PATH || "ffprobe",
    [
      "-v",
      "error",
      "-protocol_whitelist",
      "file",
      "-format_whitelist",
      demuxers,
      "-select_streams",
      "V:0",
      "-show_entries",
      "stream=width,height:format=duration",
      "-of",
      "json",
      file,
    ],
    signal,
    32 * 1024,
  );
  const { format, streams } = JSON.parse(result.toString());
  const seconds = Number(format?.duration);
  const { width, height } = streams?.[0] ?? {};
  if (
    !Number.isFinite(seconds) ||
    seconds < 0.25 ||
    seconds > MAX_VIDEO_SECONDS ||
    !(width > 0 && height > 0 && width * height <= 9_000_000)
  )
    throw Error("VIDEO_LIMIT");
  return Math.floor(seconds * 1000);
}

const ffmpeg = (args, signal) =>
  read(
    process.env.FFMPEG_PATH || "ffmpeg",
    [
      "-nostdin",
      "-v",
      "error",
      "-filter_threads",
      "1",
      ...args,
      "-threads",
      "1",
      "-c:v",
      "mjpeg",
      "-q:v",
      "4",
      "-f",
      "image2pipe",
      "pipe:1",
    ],
    signal,
  );
const fit = (w, h) =>
  `scale=${w}:${h}:force_original_aspect_ratio=decrease:force_divisible_by=2,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2,setsar=1`;

const image = (bytes) => {
  if (bytes.length < 12 || bytes[0] !== 255 || bytes[1] !== 216)
    throw Error("VIDEO_DECODE_FAILED");
  return {
    type: "image",
    mimeType: "image/jpeg",
    data: bytes.toString("base64"),
  };
};

export function videoTime(ms) {
  const whole = Math.floor(ms / 1000);
  return [Math.floor(whole / 60), whole % 60]
    .map((n) => String(n).padStart(2, "0"))
    .join(":");
}

function samples(start, end, count) {
  return Array.from({ length: count }, (_, i) =>
    Math.floor(start + ((i + 0.5) * (end - start)) / count),
  );
}

function input(file, at) {
  return [
    "-threads",
    "1",
    "-max_pixels",
    "9000000",
    "-protocol_whitelist",
    "file",
    "-format_whitelist",
    demuxers,
    "-ss",
    (at / 1000).toFixed(3),
    "-i",
    file,
  ];
}

async function sheet(file, times, maxEdge, signal) {
  const cols = Math.min(4, times.length);
  const rows = Math.ceil(times.length / cols);
  const width = Math.floor(Math.min(1280, maxEdge) / cols / 2) * 2;
  const height = Math.floor((width * 9) / 16 / 2) * 2;
  const selectors = times
    .map((_, i) => `[${i}:V:0]${fit(width, height)}[v${i}]`)
    .join(";");
  const tracks = times.map((_, i) => `[v${i}]`).join("");
  const grid = times
    .map((_, i) => `${(i % cols) * width}_${Math.floor(i / cols) * height}`)
    .join("|");
  const args = times.flatMap((at) => input(file, at));
  const filter =
    times.length === 1
      ? "[0:V:0]" + fit(width, height) + "[grid]"
      : `${selectors};${tracks}xstack=inputs=${times.length}:layout=${grid}:fill=black[grid]`;
  const bytes = await ffmpeg(
    [
      ...args,
      "-filter_complex_threads",
      "1",
      "-filter_complex",
      filter,
      "-map",
      "[grid]",
      "-an",
      "-frames:v",
      "1",
    ],
    signal,
  );
  return {
    label: `第 1 至 ${times.length} 格由左到右、由上到下（${cols} 列、${rows} 行），原视频时间 ${times.map(videoTime).join("、")}`,
    timestampsMs: times,
    ...image(bytes),
  };
}

export async function videoOverview(file, duration, policy, signal) {
  const count = Math.min(policy.maxImages * 12, Math.ceil(duration / 60_000));
  const times = samples(0, duration, count);
  const images = [];
  for (let i = 0; i < times.length; i += 12)
    images.push(
      await sheet(file, times.slice(i, i + 12), policy.maxEdge, signal),
    );
  return images;
}

export async function videoDetails(file, start, end, policy, signal) {
  const width = Math.floor(Math.min(960, policy.maxEdge) / 2) * 2;
  const height = Math.floor((width * 9) / 16 / 2) * 2;
  const frames = [];
  for (const at of samples(start, end, Math.min(8, policy.maxImages))) {
    const bytes = await ffmpeg(
      [
        ...input(file, at),
        "-map",
        "0:V:0",
        "-vf",
        fit(width, height),
        "-an",
        "-frames:v",
        "1",
      ],
      signal,
    );
    frames.push({
      ...image(bytes),
      label: `回看取样 ${videoTime(at)}（${at} 毫秒）`,
      timestampsMs: [at],
    });
  }
  return frames;
}
