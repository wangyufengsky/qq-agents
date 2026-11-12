// @ts-check
import { execFileSync } from "node:child_process";
import path from "node:path";

/** @param {number} pid */
export function taskkillTree(pid) {
  execFileSync(
    path.join(
      process.env.SystemRoot || "C:\\Windows",
      "System32",
      "taskkill.exe",
    ),
    ["/pid", String(pid), "/T", "/F"],
    { stdio: "ignore", windowsHide: true, timeout: 10000 },
  );
}
