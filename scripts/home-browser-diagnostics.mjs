// @ts-check
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { chromium } from "playwright-core";
import { findScreenshotBrowser } from "../src/tools/public-screenshot.mjs";
import { buildChildEnv } from "../src/core/child-env.mjs";
import { homeBrowserArguments } from "../src/home/browser-process.mjs";
import { renderHomeScene } from "../src/home/scene-view.mjs";
import { homeTemplate, defaultLayout } from "../src/home/layout.mjs";

// Fixed, empty-profile CI probes distinguish packaging, flags and pipe forwarding.
// These probes never open user pages or use the bridge's runtime/configuration.
const executablePath = findScreenshotBrowser(),
  env = buildChildEnv("browser");
const root = await fs.mkdtemp(
  path.join(os.tmpdir(), "home-browser-diagnostics-"),
);
/** @param {string} command @param {string[]} args */
function command(command, args) {
  try {
    return {
      ok: true,
      output: execFileSync(command, args, {
        encoding: "utf8",
        env,
        timeout: 5000,
        maxBuffer: 8192,
      }).slice(0, 4096),
    };
  } catch (error) {
    const e = /** @type {any} */ (error);
    return {
      ok: false,
      code: e.code,
      output: String(e.stderr || e.message).slice(0, 4096),
    };
  }
}
/** @param {string} name @param {() => Promise<any>} launch */
async function probe(name, launch) {
  const started = Date.now();
  try {
    const result = await launch();
    if (result?.close) await result.close();
    console.log(
      JSON.stringify({ name, ok: true, elapsedMs: Date.now() - started }),
    );
  } catch (error) {
    const e = /** @type {any} */ (error);
    console.log(
      JSON.stringify({
        name,
        ok: false,
        elapsedMs: Date.now() - started,
        message: String(e.cause?.message || e.message).slice(0, 2500),
        connected: e.connected,
        browserState: e.browserState,
      }),
    );
  }
}
try {
  const realpath = await fs.realpath(executablePath);
  console.log(
    JSON.stringify({
      executablePath,
      realpath,
      file: command("file", [realpath]),
      package: command("dpkg-query", ["-S", realpath]),
      version: command(executablePath, ["--version"]),
    }),
  );
  const profile = path.join(root, "direct-profile");
  await fs.mkdir(profile);
  await probe("direct-fixed-flags", () =>
    chromium.launch({
      executablePath,
      env,
      timeout: 5000,
      ignoreDefaultArgs: true,
      args: homeBrowserArguments(profile),
    }),
  );
  await probe("owned-shim-fixed-flags", () =>
    renderHomeScene(
      {
        type: "room",
        template: homeTemplate("room"),
        view: { layout: defaultLayout("room") },
        residents: [],
      },
      {
        executablePath,
        launchTimeoutMs: 5000,
        signal: AbortSignal.timeout(20000),
      },
    ),
  );
  await probe("direct-playwright-defaults", () =>
    chromium.launch({ executablePath, env, timeout: 5000, headless: true }),
  );
  for (const candidate of [
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
  ]) {
    if (candidate === executablePath) break;
    try {
      await fs.access(candidate);
    } catch {
      continue;
    }
    console.log(
      JSON.stringify({
        candidate,
        realpath: await fs.realpath(candidate),
        version: command(candidate, ["--version"]),
      }),
    );
    await probe("owned-shim-google-chrome", () =>
      renderHomeScene(
        {
          type: "room",
          template: homeTemplate("room"),
          view: { layout: defaultLayout("room") },
          residents: [],
        },
        {
          executablePath: candidate,
          launchTimeoutMs: 5000,
          signal: AbortSignal.timeout(20000),
        },
      ),
    );
    break;
  }
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
