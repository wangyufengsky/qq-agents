// @ts-check
import fs from "node:fs/promises";
import { findScreenshotBrowser } from "../src/tools/public-screenshot.mjs";
import { renderHomeScene } from "../src/home/scene-view.mjs";
import { homeTemplate, defaultLayout } from "../src/home/layout.mjs";

// This is the first browser launch in a fresh runner, without version probes or
// profile warming. Only packaged synthetic content reaches the owned renderer.
let executablePath = findScreenshotBrowser();
if (process.platform === "linux") {
  // Temporary single-variable evidence: stable Chrome is first, never warmed by
  // a preceding Chromium/default-Playwright probe. Remove after finder acceptance.
  for (const candidate of [
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
  ]) {
    try {
      await fs.access(candidate);
      executablePath = candidate;
      break;
    } catch {
      /* Try the other fixed stable installation path. */
    }
  }
}
const started = Date.now();
try {
  const png = await renderHomeScene(
    {
      type: "room",
      template: homeTemplate("room"),
      view: { layout: defaultLayout("room") },
      residents: [],
    },
    {
      executablePath,
      launchTimeoutMs: 15000,
      signal: AbortSignal.timeout(20000),
    },
  );
  if (png.length < 1000) throw Error("HOME_SCENE_RENDER_FAILED");
  console.log(
    JSON.stringify({
      name: "cold-owned-renderer",
      ok: true,
      executablePath,
      elapsedMs: Date.now() - started,
      bytes: png.length,
    }),
  );
} catch (error) {
  const failure = /** @type {any} */ (error);
  console.log(
    JSON.stringify({
      name: "cold-owned-renderer",
      ok: false,
      elapsedMs: Date.now() - started,
      connected: failure.connected,
      browserState: failure.browserState,
    }),
  );
  process.exitCode = 1;
}
