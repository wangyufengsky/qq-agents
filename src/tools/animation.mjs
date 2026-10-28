import { spawn } from "node:child_process";

const MAX_FRAMES = 1000;
const MAX_DURATION_MS = 120000;
const MAX_DECODE_PIXELS = 150000000;
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

// Inspect the GIF block structure before invoking a decoder. Compositing,
// transparency and disposal are left to FFmpeg, not reconstructed from patches.
export function inspectGif(data) {
  if (data.length < 13 || !/^GIF8[79]a/.test(data.toString("ascii", 0, 6)))
    throw Error("INVALID_GIF");
  const width = data.readUInt16LE(6),
    height = data.readUInt16LE(8);
  if (!width || !height || width * height > 16000000)
    throw Error("ANIMATION_PIXEL_LIMIT");
  let pos = 13,
    delayMs = 100,
    durationMs = 0;
  const frames = [];
  const skip = (size) => {
    if (pos + size > data.length) throw Error("INVALID_GIF");
    pos += size;
  };
  const blocks = () => {
    while (true) {
      if (pos >= data.length) throw Error("INVALID_GIF");
      const size = data[pos++];
      if (!size) break;
      skip(size);
    }
  };
  if (data[10] & 128) skip(3 * 2 ** ((data[10] & 7) + 1));
  while (pos < data.length) {
    const block = data[pos++];
    if (block === 0x3b) {
      if (!frames.length) throw Error("INVALID_GIF");
      return { width, height, durationMs, frames };
    }
    if (block === 0x21) {
      if (pos >= data.length) throw Error("INVALID_GIF");
      const label = data[pos++];
      if (label === 0xf9) {
        if (pos + 6 > data.length || data[pos] !== 4 || data[pos + 5] !== 0)
          throw Error("INVALID_GIF");
        const delay = data.readUInt16LE(pos + 2);
        // Preserve nonzero GIF delays. A missing/zero delay uses 100 ms.
        delayMs = delay === 0 ? 100 : delay * 10;
        pos += 6;
      } else {
        blocks();
      }
    } else if (block === 0x2c) {
      if (pos + 9 > data.length) throw Error("INVALID_GIF");
      const left = data.readUInt16LE(pos),
        top = data.readUInt16LE(pos + 2);
      const w = data.readUInt16LE(pos + 4),
        h = data.readUInt16LE(pos + 6);
      const packed = data[pos + 8];
      if (!w || !h || left + w > width || top + h > height)
        throw Error("INVALID_GIF");
      skip(9);
      if (packed & 128) skip(3 * 2 ** ((packed & 7) + 1));
      if (pos >= data.length || data[pos] < 2 || data[pos] > 8)
        throw Error("INVALID_GIF");
      skip(1);
      blocks();
      frames.push({
        index: frames.length,
        timeMs: durationMs,
        durationMs: delayMs,
      });
      durationMs += delayMs;
      delayMs = 100;
      if (frames.length > MAX_FRAMES || durationMs > MAX_DURATION_MS)
        throw Error("ANIMATION_LENGTH_LIMIT");
      if (frames.length * width * height > MAX_DECODE_PIXELS)
        throw Error("ANIMATION_PIXEL_LIMIT");
    } else {
      throw Error("INVALID_GIF");
    }
  }
  throw Error("INVALID_GIF");
}

export function selectFrames(info, options = {}) {
  const {
    mode = "overview",
    limit = 10,
    offset = 0,
    startMs = 0,
    endMs = info.durationMs,
  } = options;
  if (
    !["overview", "frames"].includes(mode) ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 12 ||
    !Number.isInteger(offset) ||
    offset < 0 ||
    offset > MAX_FRAMES ||
    !Number.isInteger(startMs) ||
    startMs < 0 ||
    !Number.isInteger(endMs) ||
    endMs > info.durationMs ||
    endMs <= startMs ||
    (mode === "overview" && offset !== 0)
  )
    throw Error("INVALID_ANIMATION_RANGE");
  const candidates = info.frames.filter(
    (f) => f.timeMs < endMs && f.timeMs + f.durationMs > startMs,
  );
  let selected;
  if (mode === "frames") {
    selected = candidates.filter((f) => f.index >= offset).slice(0, limit);
  } else if (candidates.length <= limit) {
    selected = candidates;
  } else {
    // Sample time rather than frame number: GIF delays can vary by frame.
    const indices = new Set();
    for (let i = 0; i < limit; i++) {
      const time =
        startMs + ((endMs - startMs - 1) * i) / Math.max(1, limit - 1);
      indices.add(candidates.find((f) => f.timeMs + f.durationMs > time).index);
    }
    // Long holds may select the same frame repeatedly; fill the remaining
    // budget with spatially distributed frame indices without dropping time samples.
    for (let i = 0; i < limit && indices.size < limit; i++)
      indices.add(
        candidates[Math.round(((candidates.length - 1) * i) / (limit - 1))]
          .index,
      );
    selected = candidates.filter((f) => indices.has(f.index));
  }
  if (!selected.length) throw Error("ANIMATION_FRAME_NOT_FOUND");
  const last = selected.at(-1).index;
  const nextFrameOffset =
    mode === "frames"
      ? (candidates.find((f) => f.index > last)?.index ?? null)
      : null;
  return {
    mode,
    startMs,
    endMs,
    selected,
    nextFrameOffset,
    complete: selected.length === info.frames.length,
    sampled: mode === "overview" && selected.length < candidates.length,
  };
}

function splitPngs(data, count) {
  const images = [];
  let pos = 0;
  while (pos < data.length) {
    const start = pos;
    if (!data.subarray(pos, pos + 8).equals(PNG_SIGNATURE))
      throw Error("ANIMATION_DECODE_FAILED");
    pos += 8;
    while (true) {
      if (pos + 12 > data.length) throw Error("ANIMATION_DECODE_FAILED");
      const length = data.readUInt32BE(pos),
        type = data.toString("ascii", pos + 4, pos + 8);
      pos += length + 12;
      if (pos > data.length) throw Error("ANIMATION_DECODE_FAILED");
      if (type === "IEND") break;
    }
    images.push({
      type: "image",
      mimeType: "image/png",
      data: data.subarray(start, pos).toString("base64"),
    });
  }
  if (images.length !== count) throw Error("ANIMATION_DECODE_FAILED");
  return images;
}

export async function decodeGif(
  data,
  info,
  frames,
  {
    command = process.env.FFMPEG_PATH || "ffmpeg",
    signal,
    timeoutMs = 15000,
    maxOutputBytes = MAX_OUTPUT_BYTES,
  } = {},
) {
  if (signal?.aborted) throw Error("ABORTED");
  const ratio = Math.min(1, 512 / Math.max(info.width, info.height));
  const width = Math.max(1, Math.round(info.width * ratio));
  const height = Math.max(1, Math.round(info.height * ratio));
  const select = frames.map((f) => `eq(n\\,${f.index})`).join("+");
  const output = await new Promise((resolve, reject) => {
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
        "gif",
        "-ignore_loop",
        "1",
        "-min_delay",
        "0",
        "-default_delay",
        "10",
        "-i",
        "pipe:0",
        "-an",
        "-vf",
        `select=${select},scale=${width}:${height}`,
        "-fps_mode",
        "passthrough",
        "-frames:v",
        String(frames.length),
        "-threads",
        "1",
        "-c:v",
        "png",
        "-f",
        "image2pipe",
        "pipe:1",
      ],
      { stdio: ["pipe", "pipe", "ignore"], windowsHide: true },
    );
    const chunks = [];
    let bytes = 0,
      failure = null;
    const stop = (code) => {
      failure ??= Error(code);
      child.kill("SIGKILL");
    };
    const abort = () => stop("ABORTED");
    const timer = setTimeout(() => stop("ANIMATION_DECODE_TIMEOUT"), timeoutMs);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    child.stdout.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes > maxOutputBytes) stop("ANIMATION_OUTPUT_LIMIT");
      else if (!failure) chunks.push(chunk);
    });
    child.on("error", (e) => {
      failure ??= Error(
        e.code === "ENOENT"
          ? "ANIMATION_DECODER_UNAVAILABLE"
          : "ANIMATION_DECODE_FAILED",
      );
    });
    // FFmpeg can close input early after producing the requested frame count.
    child.stdin.on("error", (e) => {
      if (e.code !== "EPIPE") stop("ANIMATION_DECODE_FAILED");
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      if (failure) reject(failure);
      else if (code !== 0) reject(Error("ANIMATION_DECODE_FAILED"));
      else resolve(Buffer.concat(chunks));
    });
    child.stdin.end(data);
  });
  return splitPngs(output, frames.length);
}

// Never silently present the first frame of another animation format as a still.
export function hasOtherAnimation(data, mimeType) {
  if (mimeType === "image/png") {
    for (let p = 8; p + 12 <= data.length;) {
      const n = data.readUInt32BE(p),
        type = data.toString("ascii", p + 4, p + 8);
      if (type === "acTL") return true;
      if (type === "IDAT" || type === "IEND") break;
      p += n + 12;
    }
  } else if (mimeType === "image/webp") {
    for (let p = 12; p + 8 <= data.length;) {
      const type = data.toString("ascii", p, p + 4),
        n = data.readUInt32LE(p + 4);
      if (
        type === "ANIM" ||
        type === "ANMF" ||
        (type === "VP8X" && n >= 1 && data[p + 8] & 2)
      )
        return true;
      p += 8 + n + (n & 1);
    }
  }
  return false;
}
