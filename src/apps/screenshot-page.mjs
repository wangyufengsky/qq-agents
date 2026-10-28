// @ts-check
import { contentIdentity } from "./urls.mjs";
/** @param {any} page OpenCLI page handle, not a Playwright Page. @param {{url: string, platform: string}} job */
export async function screenshotAppPage(page, job) {
  const expected = contentIdentity(job.url, job.platform);
  await page.goto(/** @type {string} */ (expected.url));
  const current = async () => {
    const result = await page.evaluate("() => location.href");
    const url =
      result && typeof result === "object" && "data" in result
        ? result.data
        : result;
    if (contentIdentity(url, job.platform).key !== expected.key)
      throw Error("APP_SCREENSHOT_TARGET_MISMATCH");
  };
  await current();
  const data = await page.screenshot({
    format: "png",
    fullPage: false,
    width: 1280,
    height: 900,
  });
  await current();
  if (typeof data !== "string" || data.length > 12 * 1024 * 1024)
    throw Error("APP_OUTPUT_LIMIT");
  return { data };
}
