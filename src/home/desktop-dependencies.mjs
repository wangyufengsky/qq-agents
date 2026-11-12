// @ts-check
import fs from "node:fs";
import path from "node:path";
import { updateDirectory } from "../updates/paths.mjs";

export const electronVersion = "45.3.0";
export const nativeDesktopVersion = "1.2.0";

const electron = {
  "darwin-arm64":
    "b0c7cbb70f98ff72beffa98b4c449a7d92d8b51d3d25817cfcdcb6ee2d61711a",
  "darwin-x64":
    "17b39cede4bd26ec9a125ffa405f324e9eb6c5c2ae2aa8a6060c310d518134a1",
  "win32-arm64":
    "cfe6a3e7a756e4b70ecc32f89c40a0823cdd446941976acff252128cfebd73a7",
  "win32-x64":
    "b43b532e712a4323f4224627b73808a039c9769fdf7ba1dbc3cb49c1dbfa350b",
};
const native = {
  "darwin-arm64": [
    "aarch64-apple-darwin",
    "219813428bb1ad8decae172faed05c5964a2415170df402e2786ccfa6452ba82",
  ],
  "darwin-x64": [
    "x86_64-apple-darwin",
    "d9dc50226f28d7fc86a2f5b0945f0c206dff6c31e418907749f493b6f9e773e6",
  ],
  "win32-arm64": [
    "aarch64-pc-windows-msvc",
    "d6d8643310c2c13eace2261444d9e4c0d16ca09581f38500983104903604caa6",
  ],
  "win32-x64": [
    "x86_64-pc-windows-msvc",
    "a4199f741a441cedd349bf56c5eba01783b1261258b498efeb7ec9945220c3e8",
  ],
};

/**
 * @param {"electron" | "agent-desktop"} name
 * @param {NodeJS.Platform} platform
 * @param {string} arch
 */
export function desktopAsset(name, platform, arch) {
  const key = /** @type {keyof typeof electron} */ (`${platform}-${arch}`);
  if (!Object.hasOwn(electron, key)) return null;
  const windows = platform === "win32";
  if (name === "electron") {
    const version = electronVersion;
    const filename = `electron-v${version}-${key}.zip`;
    return {
      version,
      cacheKey: `${name}-v${version}-${key}`,
      executable: windows
        ? "electron.exe"
        : "Electron.app/Contents/MacOS/Electron",
      companions: [],
      filename,
      url: `https://github.com/electron/electron/releases/download/v${version}/${filename}`,
      sha256: electron[key],
      maxBytes: 256 * 1024 * 1024,
    };
  }
  const version = nativeDesktopVersion;
  const [target, sha256] = native[key];
  const filename = `agent-desktop-v${version}-${target}.tar.gz`;
  return {
    version,
    cacheKey: `${name}-v${version}-${key}`,
    executable: windows ? "agent-desktop.exe" : "agent-desktop",
    companions: windows ? [] : ["agent-desktop-macos-helper"],
    filename,
    url: `https://github.com/vercel-labs/agent-desktop/releases/download/v${version}/${filename}`,
    sha256,
    maxBytes: 8 * 1024 * 1024,
  };
}

/** @param {string} root */
export function desktopDependencyCache(root) {
  return path.resolve(root, updateDirectory, "desktop-dependencies");
}

/** @param {string | undefined} file */
export function executableFile(file) {
  if (!file || !path.isAbsolute(file)) return false;
  try {
    if (!fs.statSync(file).isFile()) return false;
    fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * @param {string} directory
 * @param {NonNullable<ReturnType<typeof desktopAsset>>} asset
 */
export function installedDesktopExecutable(directory, asset) {
  const executable = path.join(directory, asset.executable);
  return executableFile(executable) &&
    asset.companions.every((file) => executableFile(path.join(directory, file)))
    ? executable
    : undefined;
}

/**
 * @param {string | null} root
 * @param {"electron" | "agent-desktop"} name
 * @param {{platform?: NodeJS.Platform, arch?: string}} [options]
 */
export function managedDesktopExecutable(
  root,
  name,
  { platform = process.platform, arch = process.arch } = {},
) {
  const asset = desktopAsset(name, platform, arch);
  if (root && asset) {
    return installedDesktopExecutable(
      path.join(desktopDependencyCache(root), asset.cacheKey),
      asset,
    );
  }
}
