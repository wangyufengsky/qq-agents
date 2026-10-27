// @ts-check
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
let count = 0;
/** @param {string} dir */
function visit(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const f = path.join(dir, e.name);
    if (e.isDirectory()) visit(f);
    else if (/\.(mjs|js)$/.test(f)) {
      execFileSync(process.execPath, ["--check", f], { stdio: "pipe" });
      count++;
    }
  }
}
for (const dir of ["src", "public", "scripts", "test", "vendor"]) visit(dir);
console.log(`Syntax checked ${count} JavaScript modules.`);
