import fs from "node:fs";
import path from "node:path";
import { validateFetchUrl } from "../../vendor/social-reader/safe-fetch.js";
import { requestFile, validateWithSignal } from "./file-download.mjs";

let active = 0;
// Chromium never sends page traffic itself: every document and subresource is
// fetched through the same public-DNS-pinned transport as file downloads.
export function screenshotRoutes({
  signal = new AbortController().signal,
  validate = validateFetchUrl,
  request = requestFile,
} = {}) {
  let count = 0,
    bytes = 0,
    documentError = null,
    blocked = 0,
    chain = Promise.resolve();
  return {
    get documentError() {
      return documentError;
    },
    get blocked() {
      return blocked;
    },
    handle(route) {
      const pending = chain.then(() => handle(route));
      chain = pending.catch(() => {});
      return pending;
    },
  };
  async function handle(route) {
    const req = route.request();
    try {
      signal?.throwIfAborted();
      if (req.method() !== "GET" || ++count > 100 || bytes >= 24 * 1024 * 1024)
        throw Error("SCREENSHOT_RESOURCE_LIMIT");
      const checked = await validateWithSignal(req.url(), validate, signal);
      signal?.throwIfAborted();
      const response = await request(checked.url, checked.addresses, {
        maxBytes: Math.min(4 * 1024 * 1024, 24 * 1024 * 1024 - bytes),
        signal,
        includeType: true,
      });
      signal?.throwIfAborted();
      if (response.redirect) {
        const next = await validateWithSignal(
          new URL(response.redirect, checked.url).href,
          validate,
          signal,
        );
        return await route.fulfill({
          status: 302,
          headers: { location: next.url.href },
        });
      }
      bytes += response.buffer.length;
      if (bytes > 24 * 1024 * 1024) throw Error("SCREENSHOT_RESOURCE_LIMIT");
      await route.fulfill({
        status: 200,
        contentType: response.contentType,
        body: response.buffer,
      });
    } catch {
      blocked++;
      if (
        req.isNavigationRequest() &&
        req.frame() === req.frame().page().mainFrame()
      )
        documentError = "SCREENSHOT_PAGE_UNAVAILABLE";
      await route.abort().catch(() => {});
    }
  }
}
const browserCandidates = {
  darwin: [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
  ],
  linux: [
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/snap/bin/chromium",
  ],
};
// An explicit administrator setting wins and is never silently replaced by a
// probed browser; otherwise only well-known paths for this platform are used.
export function findScreenshotBrowser({
  env = process.env,
  platform = process.platform,
  exists = fs.existsSync,
} = {}) {
  const configured = env.QQ_SCREENSHOT_BROWSER || env.CHROME_PATH;
  if (configured) {
    if (!path.isAbsolute(configured) || !exists(configured))
      throw Error("SCREENSHOT_BROWSER_MISSING");
    return configured;
  }
  const found = (browserCandidates[platform] || []).find((p) => exists(p));
  if (!found) throw Error("SCREENSHOT_BROWSER_MISSING");
  return found;
}
export async function capturePublicPage(
  url,
  { root, signal, executablePath } = {},
) {
  const combined = AbortSignal.any([
    signal || new AbortController().signal,
    AbortSignal.timeout(45000),
  ]);
  await validateWithSignal(url, validateFetchUrl, combined);
  if (active >= 2) throw Error("SCREENSHOT_BUSY");
  executablePath ||= findScreenshotBrowser();
  active++;
  let dir, browser;
  const abort = () => {
    void browser?.close().catch(() => {});
  };
  try {
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    dir = fs.mkdtempSync(path.join(root, ".capture-"));
    const { chromium } = await import("playwright-core");
    browser = await chromium.launchPersistentContext(
      path.join(dir, "profile"),
      {
        executablePath,
        headless: true,
        javaScriptEnabled: false,
        serviceWorkers: "block",
        acceptDownloads: false,
        viewport: { width: 1280, height: 900 },
        downloadsPath: path.join(dir, "downloads"),
        env: { ...process.env, TMPDIR: dir, TMP: dir, TEMP: dir },
        args: [
          "--disable-background-networking",
          "--disable-component-update",
          "--no-first-run",
        ],
      },
    );
    combined.addEventListener("abort", abort, { once: true });
    combined.throwIfAborted();
    const network = screenshotRoutes({ signal: combined });
    await browser.route("**/*", (route) => network.handle(route));
    await browser.routeWebSocket(/.*/, (socket) => socket.close());
    const page = browser.pages()[0] || (await browser.newPage());
    await page.goto(url, { waitUntil: "load", timeout: 35000 });
    if (network.documentError) throw Error(network.documentError);
    const finalUrl = (
      await validateWithSignal(page.url(), validateFetchUrl, combined)
    ).url.href;
    const buffer = await page.screenshot({
      type: "png",
      fullPage: false,
      timeout: 10000,
    });
    combined.throwIfAborted();
    if (network.documentError) throw Error(network.documentError);
    return {
      buffer,
      url: finalUrl,
      scope: "public-page-viewport",
      blockedResources: network.blocked,
      notice:
        "公开网页的 1280×900 可视区域截图；独立无登录环境，不执行网页脚本。脚本生成的内容可能缺失，不代表已读全文。",
    };
  } catch (e) {
    if (signal?.aborted) throw Error("ABORTED", { cause: e });
    throw Error(
      /^SCREENSHOT_[A-Z_]+$/.test(e.message)
        ? e.message
        : browser
          ? "SCREENSHOT_PAGE_UNAVAILABLE"
          : "SCREENSHOT_BROWSER_FAILED",
      { cause: e },
    );
  } finally {
    combined.removeEventListener("abort", abort);
    await browser?.close().catch(() => {});
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
    active--;
  }
}
