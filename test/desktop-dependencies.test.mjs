import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { temp } from "./helpers.mjs";
import {
  desktopAsset,
  desktopDependencyCache,
  managedDesktopExecutable,
} from "../src/home/desktop-dependencies.mjs";
import {
  inspectDesktopDependencies,
  installDesktopAsset,
  prepareDesktopDependencies,
} from "../src/home/desktop-dependency-installer.mjs";
import { findDesktopBrowser } from "../src/tools/public-screenshot.mjs";
import { DesktopLauncher } from "../src/home/desktop-launcher.mjs";

const mac = { platform: "darwin", arch: "arm64" };
const windows = { platform: "win32", arch: "x64" };
const archive = "synthetic package bytes";
const sha256 = createHash("sha256").update(archive).digest("hex");

function cacheFixture(
  root,
  asset,
  dir = path.join(desktopDependencyCache(root), asset.cacheKey),
) {
  for (const file of [asset.executable, ...asset.companions]) {
    const destination = path.join(dir, file);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, "synthetic executable", { mode: 0o700 });
  }
}

test("desktop assets pin the version and platform, including the macOS native helper", (t) => {
  const root = temp(t);
  const asset = desktopAsset("agent-desktop", mac.platform, mac.arch);
  assert.match(asset.url, /v1\.2\.0-aarch64-apple-darwin\.tar\.gz$/);
  assert.match(
    desktopAsset("electron", windows.platform, windows.arch).url,
    /v45\.3\.0-win32-x64\.zip$/,
  );
  assert.equal(
    desktopAsset("agent-desktop", "win32", "arm64").executable,
    "agent-desktop.exe",
  );
  assert.equal(desktopAsset("agent-desktop", "linux", "x64"), null);
  cacheFixture(root, asset);
  const executable = managedDesktopExecutable(root, "agent-desktop", mac);
  assert.equal(path.basename(executable), "agent-desktop");
  fs.unlinkSync(
    path.join(path.dirname(executable), "agent-desktop-macos-helper"),
  );
  assert.equal(managedDesktopExecutable(root, "agent-desktop", mac), undefined);
});

test("desktop installation verifies archives before extraction and only publishes complete caches", async (t) => {
  const root = temp(t);
  const asset = {
    ...desktopAsset("agent-desktop", mac.platform, mac.arch),
    sha256,
  };
  const options = { root, asset, ...mac, signal: AbortSignal.timeout(10000) };
  const fetchImpl = async () => new Response(archive);
  const cache = desktopDependencyCache(root);
  await assert.rejects(
    installDesktopAsset({
      ...options,
      fetchImpl,
      asset: { ...asset, sha256: "0".repeat(64) },
      unpack: () => assert.fail("unverified archive must not be extracted"),
    }),
    /DESKTOP_DEPENDENCY_CHECKSUM/,
  );
  await assert.rejects(
    installDesktopAsset({
      ...options,
      fetchImpl: async () =>
        new Response(null, {
          status: 302,
          headers: { location: "https://example.test/unexpected" },
        }),
      unpack: () => assert.fail("unexpected origin must not be extracted"),
    }),
    /DESKTOP_DEPENDENCY_DOWNLOAD_FAILED/,
  );
  await assert.rejects(
    installDesktopAsset({
      ...options,
      fetchImpl,
      unpack: (_file, directory) => {
        fs.writeFileSync(path.join(directory, asset.executable), "incomplete", {
          mode: 0o700,
        });
      },
    }),
    /DESKTOP_DEPENDENCY_INSTALL_FAILED/,
  );
  assert.deepEqual(fs.readdirSync(cache), []);
  const ready = Promise.withResolvers();
  let extracting = 0;
  const unpack = async (file, directory) => {
    assert.equal(fs.readFileSync(file, "utf8"), archive);
    assert.equal(
      managedDesktopExecutable(root, "agent-desktop", mac),
      undefined,
    );
    cacheFixture(root, asset, directory);
    if (++extracting === 2) ready.resolve();
    await ready.promise;
  };
  await Promise.all([
    installDesktopAsset({ ...options, fetchImpl, unpack }),
    installDesktopAsset({ ...options, fetchImpl, unpack }),
  ]);
  assert.deepEqual(fs.readdirSync(cache), [asset.cacheKey]);
  assert.ok(managedDesktopExecutable(root, "agent-desktop", mac));
  await installDesktopAsset({
    ...options,
    fetchImpl: () => assert.fail("installed dependency must be reused"),
  });
});

test("desktop preparation follows saved settings without granting tools or replacing an override", async (t) => {
  const root = temp(t);
  const env = {
    QQ_AGENTS_AGENT_DESKTOP_EXECUTABLE: path.join(root, "absent"),
    QQ_SCREENSHOT_BROWSER: path.join(root, "absent"),
  };
  const offline = await prepareDesktopDependencies({
    root,
    ...mac,
    env,
    policy: { enabled: false },
  });
  assert.deepEqual(offline.installed, []);
  assert(offline.checks.every(({ required }) => !required));
  assert.equal(fs.existsSync(desktopDependencyCache(root)), false);
  await assert.rejects(
    prepareDesktopDependencies({ root, ...mac, env, all: true }),
    /DESKTOP_DEPENDENCY_OVERRIDE_INVALID/,
  );
  assert.equal(fs.existsSync(desktopDependencyCache(root)), false);
  cacheFixture(root, desktopAsset("electron", mac.platform, mac.arch));
  const result = await prepareDesktopDependencies({
    root,
    ...mac,
    env,
    policy: { enabled: true },
  });
  assert.deepEqual(result.installed, []);
  assert.deepEqual(
    result.checks.map(({ required }) => required),
    [true, false, false],
  );
  assert.equal(result.checks[0].status, "ready");
  const observation = await inspectDesktopDependencies({
    root,
    ...mac,
    env,
    policy: { enabled: true, autonomousObservation: true },
  });
  assert.deepEqual(
    observation.map(({ required }) => required),
    [true, true, false],
  );
  await assert.rejects(
    prepareDesktopDependencies({ root, all: true, platform: "linux" }),
    /DESKTOP_DEPENDENCY_UNSUPPORTED/,
  );
});

test("the desktop browser honors explicit paths and can reuse the Playwright browser", (t) => {
  const root = temp(t);
  const browser = path.join(root, "chromium");
  fs.writeFileSync(browser, "synthetic", { mode: 0o700 });
  assert.deepEqual(findDesktopBrowser(browser, { env: {}, platform: "aix" }), {
    path: browser,
    source: "playwright",
  });
  assert.deepEqual(
    findDesktopBrowser(undefined, { env: { QQ_SCREENSHOT_BROWSER: browser } }),
    {
      path: browser,
      source: "configured",
    },
  );
  assert.throws(
    () =>
      findDesktopBrowser(browser, {
        env: { QQ_SCREENSHOT_BROWSER: path.join(root, "missing") },
      }),
    /SCREENSHOT_BROWSER_MISSING/,
  );
});

test(
  "the framework launches its prepared Electron directly",
  {
    skip: !desktopAsset("electron", process.platform, process.arch),
  },
  (t) => {
    const root = path.join(temp(t), "synthetic %TEMP% & desktop");
    const asset = desktopAsset("electron", process.platform, process.arch);
    cacheFixture(root, asset);
    const calls = [];
    const child = new EventEmitter();
    child.unref = () => {};
    const launcher = new DesktopLauncher(root, {
      spawn(command, args, options) {
        calls.push({ command, args, options });
        return child;
      },
    });
    launcher.open(43210);
    launcher.connected();
    assert.equal(calls.length, 1);
    assert.equal(calls[0].command, managedDesktopExecutable(root, "electron"));
    assert.deepEqual(calls[0].args, [
      "desktop/home",
      "--data",
      root,
      "--port",
      "43210",
    ]);
    assert.equal(calls[0].options.shell, undefined);
    assert.equal(launcher.state, "open");
  },
);
