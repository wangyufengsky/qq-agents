// @ts-check
import { findScreenshotBrowser } from "../src/tools/public-screenshot.mjs";
import { renderHomeScene } from "../src/home/scene-view.mjs";
import { homeTemplate, defaultLayout } from "../src/home/layout.mjs";

// This is the first browser launch in a fresh runner, without version probes or
// profile warming. Only packaged synthetic content reaches the owned renderer.
const executablePath = findScreenshotBrowser();
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
