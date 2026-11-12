import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import crossSpawn from "cross-spawn";
import { DesktopLauncher } from "../src/home/desktop-launcher.mjs";
import { temp } from "./helpers.mjs";

test("the desktop launcher is available on native macOS and Windows", () => {
  assert.equal(DesktopLauncher.supports("darwin"), true);
  assert.equal(DesktopLauncher.supports("win32"), true);
  assert.equal(DesktopLauncher.supports("linux"), false);
});

test(
  "Windows npm launch preserves the local path and cancels the owned process tree",
  { skip: process.platform !== "win32", timeout: 25_000 },
  async (t) => {
    const fixture = temp(t);
    const data = path.join(fixture, "小窝 %TEMP% & 资料");
    const marker = path.join(fixture, "ready.json");
    fs.writeFileSync(
      path.join(fixture, "package.json"),
      JSON.stringify({ scripts: { "desktop:home": "node client.mjs" } }),
    );
    fs.writeFileSync(
      path.join(fixture, "client.mjs"),
      `import { renameSync, writeFileSync } from "node:fs";
writeFileSync("ready.next", JSON.stringify({
  root: process.env.DESKTOP_HOME_DATA_ROOT,
  port: process.env.DESKTOP_HOME_PORT,
  args: process.argv.slice(2),
  pid: process.pid,
}));
renameSync("ready.next", "ready.json");
setTimeout(() => {}, 30_000);
`,
    );
    const launcher = new DesktopLauncher(data, {
      spawn: (command, args, options) =>
        crossSpawn(command, args, { ...options, cwd: fixture }),
    });
    t.after(() => launcher.cancel());
    launcher.open(43210);
    assert.equal(launcher.state, "opening");
    const exited = once(launcher.child, "exit");
    const started = (async () => {
      const deadline = Date.now() + 12_000;
      while (!fs.existsSync(marker)) {
        if (Date.now() >= deadline)
          throw Error("desktop fixture did not start");
        await delay(50);
      }
      return JSON.parse(fs.readFileSync(marker, "utf8"));
    })();
    const { pid, ...input } = await Promise.race([
      started,
      exited.then(() => {
        throw Error("desktop fixture exited before reporting its launch");
      }),
    ]);
    assert.deepEqual(input, { root: data, port: "43210", args: [] });
    process.kill(pid, 0);
    launcher.cancel();
    await exited;
    assert.equal(launcher.state, "idle");
    assert.equal(launcher.child, null);
    assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  },
);
