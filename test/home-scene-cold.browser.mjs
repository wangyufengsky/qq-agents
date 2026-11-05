// @ts-check
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { fixture, config, context } from "./helpers.mjs";
import { findScreenshotBrowser } from "../src/tools/public-screenshot.mjs";
import { homeSceneView, renderHomeScene } from "../src/home/scene-view.mjs";
import { mediaLease } from "../src/tools/media-lease.mjs";

// No browser/version probe precedes this real tool call in the fresh runner.
const executablePath = findScreenshotBrowser();
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
  }),
);
/** @type {Array<() => unknown>} */
const cleanup = [];
const cfg = config();
cfg.agents[0].subject.enabled = true;
cfg.agents[0].home = {
  ...cfg.agents[0].home,
  enabled: true,
  publishing: true,
  sceneView: { enabled: true },
};
const f = fixture(
  { after: (/** @type {() => unknown} */ fn) => cleanup.push(fn) },
  { cfg },
);
const ctx = context(f.runtime, "agent-0", "@subject");
/** @type {any} */
let observedFailure;
/** @type {AbortSignal | undefined} */
let generationSignal;
const started = performance.now();
try {
  const result = /** @type {any} */ (
    await homeSceneView(
      f.runtime,
      ctx,
      { type: "room", viewport: "desktop" },
      async (snapshot, options = {}) => {
        generationSignal = options.signal;
        try {
          return await renderHomeScene(snapshot, options);
        } catch (error) {
          observedFailure = error;
          throw error;
        }
      },
    )
  );
  assert.equal(result[mediaLease](), true);
  const image = Array.isArray(result.content)
    ? result.content.find((/** @type {any} */ part) => part.type === "image")
    : undefined;
  if (image) {
    assert.equal(observedFailure, undefined);
    const png = Buffer.from(image.data, "base64");
    assert.equal(png.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
    const text = JSON.parse(
      result.content.find((/** @type {any} */ part) => part.type === "text")
        .text,
    );
    assert.equal(text.imageAvailable, true);
    console.log(
      JSON.stringify({
        mode: "image",
        elapsedMs: Math.round(performance.now() - started),
        bytes: png.length,
      }),
    );
  } else {
    // Accept only the actual launch budget or the tool's total budget, after
    // renderHomeScene's finally succeeded. Cleanup errors replace those causes
    // and therefore fail this check; arbitrary render errors never pass.
    const launchTimeout =
      observedFailure?.cause?.name === "TimeoutError" &&
      observedFailure.cause.message.startsWith("browserType.launch: Timeout");
    const totalTimeout =
      generationSignal?.aborted &&
      generationSignal.reason?.name === "TimeoutError" &&
      observedFailure === generationSignal.reason;
    assert.ok(
      launchTimeout || totalTimeout,
      "cold render failed for a non-budget reason",
    );
    assert.equal(result.imageAvailable, false);
    assert.equal(result.reason, "HOME_SCENE_RENDER_FAILED");
    assert.equal(result.view.ownerAgentId, ctx.agentId);
    assert.ok(result.view.layout);
    assert.match(result.notice, /仅为结构化文字描述.*不能声称已看见图片/);
    assert.ok(
      !Array.isArray(result.content),
      "fallback must contain neither image nor image-success content",
    );
    console.log(
      JSON.stringify({
        mode: "timeout-fallback",
        elapsedMs: Math.round(performance.now() - started),
        code: result.reason,
      }),
    );
  }
} finally {
  for (const fn of cleanup.reverse()) await fn();
}
