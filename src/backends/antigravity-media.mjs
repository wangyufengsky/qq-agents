// @ts-check
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { imageMime } from "../tools/media.mjs";
import { hasOtherAnimation } from "../tools/animation.mjs";

/** Native view_file must only see pixels returned by an authorized tool in this turn.
 * CLI MCP offloading alone does not reliably attach later images to model input. */
export class AntigravityMedia {
  constructor() {
    /** @type {string | null} */
    this.directory = null;
    /** @type {Map<string, {path: string, sha256: string, bytes: number}>} */
    this.files = new Map();
    this.bytes = 0;
    this.closed = false;
  }
  prepare() {
    this.directory ??= fs.mkdtempSync(path.join(os.tmpdir(), "qq-agy-media-"));
    fs.chmodSync(this.directory, 0o700);
    return this.directory;
  }
  /** @param {any} result */
  result(result) {
    if (this.closed) throw Error("ANTIGRAVITY_TURN_INACTIVE");
    if (result.isError) return result;
    const images = result.content.filter(
      (/** @type {any} */ c) => c.type === "image",
    );
    if (!images.length) return result;
    if (images.length > 10) throw Error("ANTIGRAVITY_MEDIA_LIMIT");
    // Validate the whole result before granting any image paths.
    let bytes = 0;
    const prepared = images.map((/** @type {any} */ image) => {
      if (
        typeof image.data !== "string" ||
        image.data.length > 12 * 1024 * 1024
      )
        throw Error("ANTIGRAVITY_MEDIA_LIMIT");
      const data = Buffer.from(image.data, "base64");
      bytes += data.length;
      if (data.length > 8 * 1024 * 1024 || bytes > 20 * 1024 * 1024)
        throw Error("ANTIGRAVITY_MEDIA_LIMIT");
      const extensions = /** @type {Record<string,string>} */ ({
        "image/png": "png",
        "image/jpeg": "jpg",
        "image/webp": "webp",
      });
      const extension = extensions[image.mimeType];
      try {
        if (
          !extension ||
          imageMime(data) !== image.mimeType ||
          hasOtherAnimation(data, image.mimeType)
        )
          throw Error();
      } catch {
        throw Error("ANTIGRAVITY_MEDIA_FORMAT");
      }
      return {
        data,
        extension,
        sha256: createHash("sha256").update(data).digest("hex"),
      };
    });
    const unique = new Map(
      prepared.map((/** @type {any} */ p) => [p.sha256, p]),
    );
    const added = [...unique.values()].filter((p) => !this.files.has(p.sha256));
    if (
      this.files.size + added.length > 32 ||
      this.bytes + added.reduce((n, p) => n + p.data.length, 0) >
        64 * 1024 * 1024
    )
      throw Error("ANTIGRAVITY_MEDIA_LIMIT");
    const directory = this.prepare();
    const created = [];
    try {
      for (const p of added) {
        const file = path.join(directory, `${p.sha256}.${p.extension}`);
        fs.writeFileSync(file, p.data, { mode: 0o600, flag: "wx" });
        created.push({ path: file, sha256: p.sha256, bytes: p.data.length });
      }
    } catch {
      for (const file of created) fs.rmSync(file.path, { force: true });
      throw Error("ANTIGRAVITY_MEDIA_FAILED");
    }
    for (const file of created) {
      this.files.set(file.sha256, file);
      this.bytes += file.bytes;
    }
    let index = 0;
    return {
      ...result,
      content: result.content.map((/** @type {any} */ c) => {
        if (c.type !== "image") return c;
        const file = this.files.get(prepared[index++].sha256);
        return {
          type: "text",
          text: `Image ${index}: pixels are not yet visible. Call native view_file with AbsolutePath=${JSON.stringify(file?.path)} to inspect this exact image before describing it. This path is authorized only for this turn. Preserve the original frame timing and sampled/complete metadata; do not infer unseen frames.`,
        };
      }),
    };
  }
  catalog() {
    return [...this.files.values()];
  }
  close() {
    this.closed = true;
    this.files.clear();
    if (this.directory)
      fs.rmSync(this.directory, { recursive: true, force: true });
  }
}
