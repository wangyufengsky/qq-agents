import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { Transform, Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import { buildChildEnv } from "../core/child-env.mjs";
import { findDesktopBrowser } from "../tools/public-screenshot.mjs";
import {
  desktopAsset,
  desktopDependencyCache,
  executableFile,
  installedDesktopExecutable,
  managedDesktopExecutable,
  nativeDesktopVersion,
} from "./desktop-dependencies.mjs";

const exec = promisify(execFile);
const require = createRequire(import.meta.url);
const dependencyIds = ["electron", "agent-desktop", "chromium"];
const releaseHosts = new Set([
  "github.com",
  "release-assets.githubusercontent.com",
  "objects.githubusercontent.com",
]);

function requirements(policy, all) {
  const enabled = policy?.enabled === true;
  return {
    electron: all || enabled,
    "agent-desktop":
      all ||
      (enabled &&
        (policy.nativeControl?.enabled === true ||
          policy.autonomousObservation === true)),
    chromium: all || (enabled && policy.browserControl?.enabled === true),
  };
}

export async function inspectDesktopDependencies({
  root,
  policy,
  all = false,
  env = process.env,
  platform = process.platform,
  arch = process.arch,
}) {
  const required = requirements(policy, all);
  const supported = !!desktopAsset("electron", platform, arch);
  return Promise.all(
    dependencyIds.map(async (id) => {
      const check = { id, required: required[id], status: "missing" };
      if (!supported) return { ...check, status: "unsupported" };
      if (id === "chromium") {
        const { chromium } = await import("playwright-core");
        try {
          const { source } = findDesktopBrowser(chromium.executablePath(), {
            env,
            platform,
          });
          return { ...check, status: "ready", source };
        } catch {
          return {
            ...check,
            source:
              env.QQ_SCREENSHOT_BROWSER || env.CHROME_PATH
                ? "configured"
                : "playwright",
          };
        }
      }
      check.version = desktopAsset(id, platform, arch).version;
      if (id === "agent-desktop" && env.QQ_AGENTS_AGENT_DESKTOP_EXECUTABLE) {
        const executable = env.QQ_AGENTS_AGENT_DESKTOP_EXECUTABLE;
        let status = "missing";
        if (
          executableFile(executable) &&
          (platform !== "win32" || executable.toLowerCase().endsWith(".exe"))
        ) {
          try {
            const { stdout } = await exec(executable, ["version"], {
              env: buildChildEnv("browser", {}, { parent: env, platform }),
              timeout: 5000,
              maxBuffer: 65536,
              windowsHide: true,
            });
            const { ok, data } = JSON.parse(stdout);
            status =
              ok &&
              data?.version === nativeDesktopVersion &&
              data.os === (platform === "win32" ? "windows" : "macos")
                ? "ready"
                : "invalid";
          } catch {
            status = "invalid";
          }
        }
        return { ...check, status, source: "configured" };
      }
      return {
        ...check,
        status: managedDesktopExecutable(root, id, { platform, arch })
          ? "ready"
          : "missing",
        source: "managed",
      };
    }),
  );
}

async function download(asset, file, signal, fetchImpl) {
  let url = new URL(asset.url);
  for (let hop = 0; hop <= 3; hop++) {
    if (
      url.protocol !== "https:" ||
      url.port ||
      url.username ||
      url.password ||
      !releaseHosts.has(url.hostname)
    )
      throw Error("DESKTOP_DEPENDENCY_DOWNLOAD_FAILED");
    const response = await fetchImpl(url, {
      signal,
      redirect: "manual",
      credentials: "omit",
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      await response.body?.cancel();
      const location = response.headers.get("location");
      if (!location) break;
      url = new URL(location, url);
      continue;
    }
    if (!response.ok || !response.body) {
      await response.body?.cancel();
      break;
    }
    let bytes = 0;
    const hash = createHash("sha256");
    const verify = new Transform({
      transform(chunk, _encoding, done) {
        bytes += chunk.length;
        if (bytes > asset.maxBytes)
          return done(Error("DESKTOP_DEPENDENCY_DOWNLOAD_FAILED"));
        hash.update(chunk);
        done(null, chunk);
      },
    });
    await pipeline(
      Readable.fromWeb(response.body),
      verify,
      fs.createWriteStream(file, { flags: "wx", mode: 0o600 }),
      { signal },
    );
    if (hash.digest("hex") !== asset.sha256)
      throw Error("DESKTOP_DEPENDENCY_CHECKSUM");
    return;
  }
  throw Error("DESKTOP_DEPENDENCY_DOWNLOAD_FAILED");
}

async function extract(file, destination, { signal, platform, env }) {
  const windows = platform === "win32";
  const zip = file.endsWith(".zip");
  const binary = windows
    ? path.join(
        env.SYSTEMROOT || env.SystemRoot || "C:\\Windows",
        "System32",
        "tar.exe",
      )
    : zip
      ? "/usr/bin/ditto"
      : "/usr/bin/tar";
  const args =
    !windows && zip
      ? ["-x", "-k", file, destination]
      : ["-xf", file, "-C", destination];
  await exec(binary, args, {
    env: buildChildEnv("browser", {}, { parent: env, platform }),
    signal,
    timeout: 90000,
    maxBuffer: 65536,
    windowsHide: true,
  });
}

export async function installDesktopAsset({
  root,
  asset,
  signal,
  fetchImpl = fetch,
  unpack = extract,
  platform = process.platform,
  env = process.env,
}) {
  const cache = desktopDependencyCache(root);
  const destination = path.join(cache, asset.cacheKey);
  if (installedDesktopExecutable(destination, asset)) return;
  fs.mkdirSync(cache, { recursive: true, mode: 0o700 });
  const staging = fs.mkdtempSync(path.join(cache, ".prepare-"));
  try {
    const file = path.join(staging, asset.filename);
    const contents = path.join(staging, "contents");
    fs.mkdirSync(contents, { mode: 0o700 });
    await download(asset, file, signal, fetchImpl);
    await unpack(file, contents, { signal, platform, env });
    signal.throwIfAborted();
    if (!installedDesktopExecutable(contents, asset))
      throw Error("DESKTOP_DEPENDENCY_INSTALL_FAILED");
    try {
      fs.renameSync(contents, destination);
    } catch (error) {
      // A concurrent prepare may already have published the verified package.
      if (!installedDesktopExecutable(destination, asset)) throw error;
    }
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

async function installChromium({ env, signal }) {
  const cli = path.join(
    path.dirname(require.resolve("playwright-core/package.json")),
    "cli.js",
  );
  await exec(process.execPath, [cli, "install", "--no-shell", "chromium"], {
    env: {
      ...buildChildEnv("desktop-home", {}, { parent: env }),
      ...(!env.PLAYWRIGHT_BROWSERS_PATH
        ? {}
        : {
            PLAYWRIGHT_BROWSERS_PATH:
              env.PLAYWRIGHT_BROWSERS_PATH === "0"
                ? "0"
                : path.resolve(
                    env.INIT_CWD || process.cwd(),
                    env.PLAYWRIGHT_BROWSERS_PATH,
                  ),
          }),
      PLAYWRIGHT_SKIP_BROWSER_GC: "1",
    },
    timeout: 240000,
    maxBuffer: 1024 * 1024,
    windowsHide: true,
    signal,
  });
}

export async function prepareDesktopDependencies({
  root,
  policy,
  all = false,
  env = process.env,
  platform = process.platform,
  arch = process.arch,
  signal,
}) {
  const options = { root, policy, all, env, platform, arch };
  signal?.throwIfAborted();
  const before = await inspectDesktopDependencies(options);
  const missing = before.filter(
    (check) => check.required && check.status !== "ready",
  );
  if (missing.some((check) => check.status === "unsupported"))
    throw Error("DESKTOP_DEPENDENCY_UNSUPPORTED");
  if (missing.some((check) => check.source === "configured"))
    throw Error("DESKTOP_DEPENDENCY_OVERRIDE_INVALID");
  const installed = [];
  for (const check of missing) {
    signal?.throwIfAborted();
    const deadline = AbortSignal.timeout(300000);
    const installSignal = signal
      ? AbortSignal.any([deadline, signal])
      : deadline;
    try {
      if (check.id === "chromium")
        await installChromium({ env, signal: installSignal });
      else {
        await installDesktopAsset({
          root,
          asset: desktopAsset(check.id, platform, arch),
          signal: installSignal,
          platform,
          env,
        });
      }
    } catch (error) {
      if (
        [
          "DESKTOP_DEPENDENCY_CHECKSUM",
          "DESKTOP_DEPENDENCY_DOWNLOAD_FAILED",
        ].includes(error.message)
      )
        throw error;
      throw Error("DESKTOP_DEPENDENCY_INSTALL_FAILED", { cause: error });
    }
    installed.push(check.id);
  }
  const checks = installed.length
    ? await inspectDesktopDependencies(options)
    : before;
  if (checks.some((check) => check.required && check.status !== "ready"))
    throw Error("DESKTOP_DEPENDENCY_INSTALL_FAILED");
  return { ok: true, installed, checks };
}
