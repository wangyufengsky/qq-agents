import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { atomicJSON } from "../core/config.mjs";
import {
  safeFetchBuffer,
  looksLikeImageBuffer,
} from "../../vendor/social-reader/safe-fetch.js";

export class MediaStore {
  constructor(root) {
    this.root = root;
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
      buffer.length > 8 * 1024 * 1024 ||
      !looksLikeImageBuffer(buffer) ||
      !["image/png", "image/jpeg", "image/gif", "image/webp"].includes(mimeType)
    )
      throw Error("INVALID_IMAGE");
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
  segment(agentId, id) {
    const image = this.read(agentId, id);
    return { type: "image", data: { file: "base64://" + image.data } };
  }
  async fromMessage(agentId, event, index = 0) {
    const segments = event.payload?.segments || [],
      images = segments.filter((s) => s.type === "image");
    if (!Number.isInteger(index) || index < 0 || index >= images.length)
      throw Error("IMAGE_NOT_FOUND");
    const url = images[index].data?.url;
    if (!url) throw Error("IMAGE_URL_UNAVAILABLE");
    const result = await safeFetchBuffer(url, 8 * 1024 * 1024);
    const buffer = Buffer.isBuffer(result) ? result : result.buffer;
    const mimeType =
      buffer[0] === 137
        ? "image/png"
        : buffer[0] === 255
          ? "image/jpeg"
          : buffer.toString("ascii", 0, 3) === "GIF"
            ? "image/gif"
            : "image/webp";
    return this.put(agentId, buffer, mimeType, {
      sourceEventId: event.id,
      conversation: event.conversation,
    });
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
}
