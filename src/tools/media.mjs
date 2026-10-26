import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { atomicJSON } from "../core/config.mjs";
import {
  inspectGif,
  selectFrames,
  decodeGif,
  hasOtherAnimation,
} from "./animation.mjs";
import { looksLikeImageBuffer } from "../../vendor/social-reader/safe-fetch.js";
import { downloadImage } from "./image-download.mjs";

export const MAX_IMAGE_SOURCE_BYTES = 20 * 1024 * 1024;
const MAX_STATIC_BYTES = 8 * 1024 * 1024;

export function imageMime(buffer) {
  if (
    buffer.length >= 24 &&
    buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  )
    return "image/png";
  if (
    buffer.length >= 12 &&
    buffer[0] === 255 &&
    buffer[1] === 216 &&
    buffer[2] === 255
  )
    return "image/jpeg";
  if (buffer.length >= 13 && /^GIF8[79]a/.test(buffer.toString("ascii", 0, 6)))
    return "image/gif";
  if (
    buffer.length >= 16 &&
    buffer.toString("ascii", 0, 4) === "RIFF" &&
    buffer.toString("ascii", 8, 12) === "WEBP"
  )
    return "image/webp";
  throw Error("INVALID_IMAGE");
}
export class MediaStore {
  constructor(root, { fetchBuffer = downloadImage, decode = decodeGif } = {}) {
    this.root = root;
    this.fetchBuffer = fetchBuffer;
    this.decode = decode;
    this.activeAnimations = 0;
    this.activeDownloads = 0;
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  }
  dir(agentId) {
    if (!/^[a-z][a-z0-9_-]{0,63}$/.test(agentId)) throw Error("INVALID_AGENT");
    return path.join(this.root, agentId);
  }
  put(agentId, buffer, mimeType, meta = {}) {
    if (
      !Buffer.isBuffer(buffer) ||
      !buffer.length ||
      !looksLikeImageBuffer(buffer) ||
      !["image/png", "image/jpeg", "image/gif", "image/webp"].includes(mimeType)
    )
      throw Error("INVALID_IMAGE");
    if (imageMime(buffer) !== mimeType) throw Error("IMAGE_MIME_MISMATCH");
    if (
      buffer.length >
      (mimeType === "image/gif" ? MAX_IMAGE_SOURCE_BYTES : MAX_STATIC_BYTES)
    )
      throw Error("IMAGE_TOO_LARGE");
    const id = createHash("sha256").update(buffer).digest("hex"),
      dir = this.dir(agentId);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(dir, id + ".bin"), buffer, { mode: 0o600 });
    const existing = this.metadata(agentId, id);
    atomicJSON(path.join(dir, id + ".json"), {
      ...existing,
      id,
      mimeType,
      bytes: buffer.length,
      ...meta,
      protectedOperations:
        existing?.protectedOperations || meta.protectedOperations || false,
      protectedRepositories: [
        ...new Set([
          ...(existing?.protectedRepositories || []),
          ...(meta.protectedRepositories || []),
        ]),
      ],
      sources: [
        ...(existing?.sources ||
          (existing?.conversation
            ? [
                {
                  conversation: existing.conversation,
                  eventId: existing.sourceEventId || null,
                  type: existing.sourceType,
                  index: existing.sourceIndex,
                },
              ]
            : [])),
        ...(meta.sources || []),
        ...(meta.conversation
          ? [
              {
                conversation: meta.conversation,
                eventId: meta.sourceEventId || null,
                type: meta.sourceType,
                index: meta.sourceIndex,
              },
            ]
          : []),
      ].filter(
        (x, i, all) =>
          all.findIndex(
            (y) =>
              y.conversation === x.conversation &&
              y.eventId === x.eventId &&
              y.type === x.type &&
              y.index === x.index,
          ) === i,
      ),
    });
    return { id, mimeType, bytes: buffer.length };
  }
  metadata(agentId, id) {
    if (!/^[a-f0-9]{64}$/.test(id)) throw Error("INVALID_MEDIA_ID");
    try {
      return JSON.parse(
        fs.readFileSync(path.join(this.dir(agentId), id + ".json"), "utf8"),
      );
    } catch {
      return null;
    }
  }
  read(agentId, id) {
    const meta = this.metadata(agentId, id);
    if (!meta) throw Error("MEDIA_NOT_FOUND");
    return {
      type: "image",
      data: fs
        .readFileSync(path.join(this.dir(agentId), id + ".bin"))
        .toString("base64"),
      mimeType: meta.mimeType,
    };
  }
  async view(agentId, id, options, signal) {
    if (signal?.aborted) throw Error("ABORTED");
    const meta = this.metadata(agentId, id);
    if (!meta) throw Error("MEDIA_NOT_FOUND");
    const data = fs.readFileSync(path.join(this.dir(agentId), id + ".bin"));
    const media = { id, mimeType: meta.mimeType, bytes: data.length };
    if (hasOtherAnimation(data, meta.mimeType))
      throw Error("ANIMATION_FORMAT_UNSUPPORTED_USE_GIF");
    const info = meta.mimeType === "image/gif" ? inspectGif(data) : null;
    if (!info || info.frames.length === 1) {
      if (data.length > MAX_STATIC_BYTES) throw Error("IMAGE_OUTPUT_LIMIT");
      return {
        content: [
          { type: "text", text: JSON.stringify({ ...media, animated: false }) },
          {
            type: "image",
            data: data.toString("base64"),
            mimeType: meta.mimeType,
          },
        ],
      };
    }
    const selection = selectFrames(info, options);
    if (this.activeAnimations >= 2) throw Error("ANIMATION_DECODER_BUSY");
    this.activeAnimations++;
    let images;
    try {
      images = await this.decode(data, info, selection.selected, { signal });
    } finally {
      this.activeAnimations--;
    }
    if (signal?.aborted) throw Error("ABORTED");
    const animation = {
      frameCount: info.frames.length,
      durationMs: info.durationMs,
      width: info.width,
      height: info.height,
      timing: "one cycle; missing/zero GIF delays use 100 ms",
      mode: selection.mode,
      startMs: selection.startMs,
      endMs: selection.endMs,
      complete: selection.complete,
      sampled: selection.sampled,
      frames: selection.selected,
      nextFrameOffset: selection.nextFrameOffset,
      next:
        selection.nextFrameOffset === null
          ? null
          : {
              mediaId: id,
              animation: {
                mode: "frames",
                offset: selection.nextFrameOffset,
                limit: options?.limit ?? 10,
                startMs: selection.startMs,
                endMs: selection.endMs,
              },
            },
    };
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            ...media,
            animated: true,
            animation,
            hint: "以下按时间排列的图片来自同一张动图，帧序号从0开始。结合画面变化理解动作。complete=false时没有展示全部帧，不能声称看完；可用sticker_read(mediaId, animation)读取已缓存原图，mode=frames并按next分页，或指定startMs/endMs细看。收藏和发送仍使用原始mediaId。",
          }),
        },
        ...images.flatMap((image, i) => [
          {
            type: "text",
            text: `动图帧 ${selection.selected[i].index}，时间 ${selection.selected[i].timeMs} ms，持续 ${selection.selected[i].durationMs} ms`,
          },
          image,
        ]),
      ],
    };
  }
  segment(agentId, id) {
    const image = this.read(agentId, id);
    return { type: "image", data: { file: "base64://" + image.data } };
  }
  cachedSource(agentId, eventId, index) {
    const dir = this.dir(agentId);
    if (!eventId || !fs.existsSync(dir)) return null;
    for (const file of fs.readdirSync(dir)) {
      if (!/^[a-f0-9]{64}\.json$/.test(file)) continue;
      const meta = this.metadata(agentId, file.slice(0, -5));
      if (
        meta?.sources?.some(
          (source) =>
            source.eventId === eventId &&
            source.type === "image" &&
            source.index === index,
        ) &&
        fs.existsSync(path.join(dir, meta.id + ".bin"))
      )
        return { id: meta.id, mimeType: meta.mimeType, bytes: meta.bytes };
    }
    return null;
  }
  async fromMessage(agentId, event, index = 0, { signal, assertActive } = {}) {
    const active = () => {
      if (signal?.aborted) throw Error("ABORTED");
      assertActive?.();
    };
    active();
    const segments = event.payload?.segments || [],
      images = segments.filter((s) => s.type === "image");
    if (!Number.isInteger(index) || index < 0 || index >= images.length)
      throw Error("IMAGE_NOT_FOUND");
    const cached = this.cachedSource(agentId, event.id, index);
    if (cached) return cached;
    const data = images[index].data || {};
    if (Number(data.file_size || data.size) > MAX_IMAGE_SOURCE_BYTES)
      throw Error("IMAGE_TOO_LARGE");
    const url = data.url;
    if (!url) throw Error("IMAGE_URL_UNAVAILABLE");
    if (this.activeDownloads >= 2) throw Error("IMAGE_DOWNLOAD_BUSY");
    this.activeDownloads++;
    try {
      const result = await this.fetchBuffer(url, MAX_IMAGE_SOURCE_BYTES, {
        signal,
      });
      active();
      const buffer = Buffer.isBuffer(result) ? result : result.buffer;
      return this.put(agentId, buffer, imageMime(buffer), {
        sourceEventId: event.id,
        sourceType: "image",
        sourceIndex: index,
        conversation: event.conversation,
        protectedOperations: event.protectedOperations === true,
      });
    } finally {
      this.activeDownloads--;
    }
  }
  collect(agentId, id, { title, tags = [] }) {
    const meta = this.metadata(agentId, id);
    if (!meta) throw Error("MEDIA_NOT_FOUND");
    if (
      typeof title !== "string" ||
      title.length > 300 ||
      !Array.isArray(tags) ||
      tags.some((s) => typeof s !== "string" || s.length > 80)
    )
      throw Error("INVALID_STICKER");
    atomicJSON(path.join(this.dir(agentId), id + ".json"), {
      ...meta,
      sticker: true,
      title,
      tags,
    });
    return { id, title, tags };
  }
  list(agentId, query = "") {
    const dir = this.dir(agentId);
    if (!fs.existsSync(dir)) return [];
    return fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")))
      .filter(
        (x) => x.sticker && JSON.stringify([x.title, x.tags]).includes(query),
      )
      .slice(0, 30);
  }
  saved(agentId, { query = "", offset = 0, limit = 10 } = {}) {
    const dir = this.dir(agentId);
    if (!fs.existsSync(dir)) return { items: [], nextOffset: null };
    const rows = fs
      .readdirSync(dir)
      .filter((f) => /^[a-f0-9]{64}\.json$/.test(f))
      .map((f) => this.metadata(agentId, f.slice(0, -5)))
      .filter(
        (x) =>
          x &&
          (x.saved || x.generatedBy || x.appRecordId) &&
          String(x.title || "生成图").includes(query),
      )
      .sort(
        (a, b) =>
          String(b.createdAt || "").localeCompare(String(a.createdAt || "")) ||
          a.id.localeCompare(b.id),
      );
    return {
      items: rows.slice(offset, offset + limit),
      nextOffset: offset + limit < rows.length ? offset + limit : null,
    };
  }
}
