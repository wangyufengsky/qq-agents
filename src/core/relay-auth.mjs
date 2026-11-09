// @ts-check
import fs from "node:fs";
import path from "node:path";
import { createHmac, randomUUID } from "node:crypto";
import { openNoFollow } from "./no-follow.mjs";

const RELAY_DOMAIN = "qq-agents:dsh-stdio-output-relay:v1";

/** @param {string} adminToken */
export function deriveRelayToken(adminToken) {
  return createHmac("sha256", adminToken).update(RELAY_DOMAIN).digest("hex");
}

/** @param {string} root @param {string} adminToken */
export function writeRelayToken(root, adminToken) {
  const file = path.join(root, "relay-token");
  const temp = file + "." + randomUUID() + ".tmp";
  try {
    fs.writeFileSync(temp, deriveRelayToken(adminToken), {
      mode: 0o600,
      flag: "wx",
    });
    fs.chmodSync(temp, 0o600);
    fs.renameSync(temp, file);
  } finally {
    fs.rmSync(temp, { force: true });
  }
  return file;
}

/** @param {string | undefined} file */
export function readRelayToken(file) {
  try {
    if (!file) throw Error("MCP_RELAY_AUTH_REQUIRED");
    const fd = openNoFollow(file);
    try {
      const stat = fs.fstatSync(fd);
      if (
        !stat.isFile() ||
        stat.size !== 64 ||
        (process.platform !== "win32" && (stat.mode & 0o077) !== 0)
      )
        throw Error("MCP_RELAY_AUTH_REQUIRED");
      const token = fs.readFileSync(fd, "utf8");
      if (!/^[a-f0-9]{64}$/.test(token)) throw Error("MCP_RELAY_AUTH_REQUIRED");
      return token;
    } finally {
      fs.closeSync(fd);
    }
  } catch (cause) {
    throw Error("MCP_RELAY_AUTH_REQUIRED", { cause });
  }
}
