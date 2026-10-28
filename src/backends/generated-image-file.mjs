// @ts-check
import fs from "node:fs";
import path from "node:path";
import { imageMime } from "../tools/media.mjs";

// Only native, completed image items may name a file. Never accept a model-supplied
// path, a data URL, or arbitrary tool output as authority to read the filesystem.
/** @param {string} home @param {string} sessionId @param {{type?: string, status?: string, savedPath?: unknown}} item */
export function readGeneratedImage(home, sessionId, item) {
  if (
    !/^[A-Za-z0-9_-]{1,128}$/.test(sessionId) ||
    item.type !== "imageGeneration" ||
    item.status !== "completed"
  )
    throw Error("GENERATED_IMAGE_SOURCE_DENIED");
  const root = path.resolve(home),
    dir = path.join(root, "generated_images", sessionId);
  const file = item.savedPath;
  if (
    typeof file !== "string" ||
    path.dirname(path.resolve(file)) !== dir ||
    !/\.(png|jpe?g|webp)$/i.test(file)
  )
    throw Error("GENERATED_IMAGE_SOURCE_DENIED");
  for (const part of [root, path.join(root, "generated_images"), dir]) {
    const stat = fs.lstatSync(part);
    if (stat.isSymbolicLink() || !stat.isDirectory())
      throw Error("GENERATED_IMAGE_SOURCE_DENIED");
  }
  const parents = [root, path.join(root, "generated_images"), dir].map((p) => ({
    path: p,
    stat: fs.statSync(p),
  }));
  if (
    fs.realpathSync(file) !==
    path.join(
      fs.realpathSync(root),
      "generated_images",
      sessionId,
      path.basename(file),
    )
  )
    throw Error("GENERATED_IMAGE_SOURCE_DENIED");
  const fd = fs.openSync(
    file,
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
  );
  try {
    const before = fs.fstatSync(fd);
    if (!before.isFile() || before.nlink !== 1)
      throw Error("GENERATED_IMAGE_SOURCE_DENIED");
    if (before.size > 8 * 1024 * 1024) throw Error("IMAGE_TOO_LARGE");
    // Bounded read also protects against a file growing between stat and read.
    const buffer = Buffer.alloc(before.size + 1);
    const length = fs.readSync(fd, buffer, 0, buffer.length, 0),
      after = fs.fstatSync(fd);
    if (
      length !== before.size ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs
    )
      throw Error("GENERATED_IMAGE_FILE_CHANGED");
    for (const parent of parents) {
      const current = fs.lstatSync(parent.path);
      if (
        current.isSymbolicLink() ||
        current.dev !== parent.stat.dev ||
        current.ino !== parent.stat.ino
      )
        throw Error("GENERATED_IMAGE_SOURCE_DENIED");
    }
    const bytes = buffer.subarray(0, length);
    return { buffer: bytes, mimeType: imageMime(bytes) };
  } finally {
    fs.closeSync(fd);
  }
}

/** @param {{type?: string} | null | undefined} failure */
export function generationError(failure) {
  if (failure?.type === "usageLimitExceeded")
    return {
      code: "IMAGE_GENERATION_USAGE_LIMIT",
      hint: "原生生图明确报告用量限制；等待额度恢复，不自动重试。",
    };
  // Some CLI versions omit the HTTP error entirely in imageGeneration events.
  // Absence of that evidence must never turn a generic failure into a quota claim.
  return {
    code: "IMAGE_GENERATION_FAILED",
    hint: "生图失败；后端未提供可核实的失败分类。若原生工具回执是 HTML 且带 cf-mitigated: challenge 或 Cloudflare challenge 脚本，应报告验证拦截；不能仅凭 429 判断余额不足。不要循环重试。",
  };
}
