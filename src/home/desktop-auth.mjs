import { createHmac, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export function desktopToken(admin) {
  return createHmac("sha256", admin)
    .update("qq-agents:desktop-home:v1")
    .digest("hex");
}

export function writeDesktopToken(root, admin) {
  const file = path.join(root, "desktop-home-token");
  const next = file + "." + randomUUID() + ".tmp";
  try {
    fs.writeFileSync(next, desktopToken(admin), { mode: 0o600, flag: "wx" });
    fs.renameSync(next, file);
  } finally {
    fs.rmSync(next, { force: true });
  }
}
