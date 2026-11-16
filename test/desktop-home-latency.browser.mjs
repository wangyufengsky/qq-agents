/* global document, MutationObserver, window */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { arch, platform, release } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import { _electron } from "playwright-core";
import { desktopToken } from "../src/home/desktop-auth.mjs";
import { createServer } from "../src/server.mjs";
import { config, fixture } from "./helpers.mjs";

const repo = fileURLToPath(new URL("../", import.meta.url));

async function waitFor(read, description) {
  const deadline = Date.now() + 10000;
  for (;;) {
    const value = read();
    if (value) return value;
    if (Date.now() >= deadline) throw Error(description);
    await delay(25);
  }
}

test("local framework state commit to native floating bubble", async (t) => {
  const executablePath = process.env.QQ_TEST_ELECTRON;
  if (!executablePath) {
    t.skip("Set QQ_TEST_ELECTRON to the native Electron executable");
    return;
  }
  const cfg = config(2);
  cfg.desktopHome.enabled = true;
  const { runtime, root } = fixture(t, { cfg });
  const admin = randomBytes(32).toString("hex");
  const profile = join(root, "electron");
  await mkdir(profile);
  await writeFile(join(root, "desktop-home-token"), desktopToken(admin));
  const server = createServer({ runtime, token: admin, allowLive: true });
  const port = await server.listen();
  let electron;
  try {
    electron = await _electron.launch({
      executablePath,
      args: [join(repo, "desktop/home")],
      env: {
        ...process.env,
        DESKTOP_HOME_TRIAL_PROFILE: profile,
        DESKTOP_HOME_DATA_ROOT: root,
        DESKTOP_HOME_LIVE_ROOT: "",
        DESKTOP_HOME_PORT: String(port),
      },
      timeout: 20000,
    });
    await (await electron.firstWindow()).locator(".door-button").waitFor();
    const host = runtime.desktopVisits;
    await waitFor(
      () => host.live && host.eventSubscribers.size === 1,
      "No SSE subscription",
    );
    const role = host.live.room.roles[0];
    host.live.room.members[role.id] = "invited";
    host.live.admit(role);
    const sprite = await waitFor(
      () =>
        electron
          .windows()
          .find((page) => page.url().includes(`type=sprite&id=${role.id}`)),
      "No role window",
    );
    await sprite.locator(".speech span").waitFor({ state: "attached" });
    const captured = new Map();
    await sprite.exposeFunction("recordBubbleCommit", (id, timestamp) =>
      captured.get(id)?.(timestamp),
    );
    await sprite.evaluate(() => {
      const words = document.querySelector(".speech span");
      const observer = new MutationObserver(() => {
        const id = /^Synthetic sample (\d+)$/.exec(words.textContent)?.[1];
        if (id) window.recordBubbleCommit(Number(id), Date.now());
      });
      observer.observe(words, {
        childList: true,
        characterData: true,
        subtree: true,
      });
    });
    const samples = [];
    for (let id = 1; id <= 35; id++) {
      let timeout;
      const rendered = new Promise((resolve, reject) => {
        captured.set(id, resolve);
        timeout = setTimeout(
          () => reject(Error(`Bubble sample ${id} was not delivered`)),
          2500,
        );
      });
      const text = `Synthetic sample ${id}`;
      // Framework and renderer share the machine's wall clock, with millisecond precision.
      const commit = Date.now();
      host.live.room.bubbles[role.id] = { id, text, now: commit };
      host.notify();
      try {
        const delta = (await rendered) - commit;
        assert.ok(delta >= 0, `Clock moved backwards by ${delta} ms`);
        if (id > 5) samples.push(delta);
      } finally {
        clearTimeout(timeout);
        captured.delete(id);
      }
      await delay(35);
    }
    const sorted = samples.toSorted((left, right) => left - right);
    const percentile = (p) => sorted[Math.ceil(sorted.length * p) - 1];
    const commit = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: repo,
      encoding: "utf8",
    }).trim();
    const electronVersion = await electron.evaluate(
      () => process.versions.electron,
    );
    console.log(
      JSON.stringify({
        commit,
        os: `${platform()} ${release()} ${arch()}`,
        electron: electronVersion,
        warmup: 5,
        samples,
        p50: percentile(0.5),
        p95: percentile(0.95),
        max: sorted.at(-1),
      }),
    );
    assert.ok(percentile(0.95) < 100);
  } finally {
    try {
      await electron?.close();
    } finally {
      await server.close();
    }
  }
});
