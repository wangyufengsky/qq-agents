// @ts-check
import fs from "node:fs/promises";
import { findScreenshotBrowser } from "../src/tools/public-screenshot.mjs";
import { renderHomeScene } from "../src/home/scene-view.mjs";
import { homeTemplate, defaultLayout } from "../src/home/layout.mjs";

// This is the first browser launch in a fresh runner, without version probes or
// profile warming. Only packaged synthetic content reaches the owned renderer.
const executablePath = findScreenshotBrowser();
const observing = process.argv.includes("--observe-cold-start");
const launchTimeoutMs = observing ? 30000 : 15000;
console.log(
  JSON.stringify({
    name: "cold-browser-selection",
    executablePath,
    realpath: await fs.realpath(executablePath),
    source: process.env.QQ_SCREENSHOT_BROWSER
      ? "QQ_SCREENSHOT_BROWSER"
      : process.env.CHROME_PATH
        ? "CHROME_PATH"
        : "platform-default",
    launchTimeoutMs,
  }),
);
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
      launchTimeoutMs,
      signal: AbortSignal.timeout(observing ? 40000 : 20000),
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
      executablePath,
      launchTimeoutMs,
      launchTimedOut:
        typeof failure.cause?.message === "string" &&
        failure.cause.message.startsWith("browserType.launch: Timeout"),
      errorName: failure.cause?.name || failure.name,
      connected: failure.connected,
      browserState: failure.browserState,
    }),
  );
  process.exitCode = 1;
}
