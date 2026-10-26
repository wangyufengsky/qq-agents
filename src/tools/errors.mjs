// Report actionable validation bounds without echoing input values, paths,
// stack traces, provider errors or credentials into either model backend.
export function safeToolFailure(error) {
  if (
    /^(ANIMATION_[A-Z_]+|INVALID_GIF|INVALID_ANIMATION_RANGE)$/.test(
      error?.message || "",
    )
  )
    return {
      code: error.message,
      hint: "Animation frames were not read. Do not describe motion or silently treat it as a still. For invalid ranges, omit animation options to get an overview and duration first. Missing decoder requires an administrator to install/configure FFmpeg. Other animated formats currently require a GIF source; processing limits or decode errors do not mean the source is static.",
    };
  if (error?.name === "ZodError" && Array.isArray(error.issues))
    return {
      code: "INVALID_TOOL_ARGUMENTS",
      issues: error.issues.slice(0, 8).map((issue) => ({
        field: (issue.path || [])
          .filter(
            (p) =>
              typeof p === "string" && /^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(p),
          )
          .slice(0, 4)
          .join("."),
        code: [
          "too_big",
          "too_small",
          "invalid_type",
          "invalid_value",
          "unrecognized_keys",
        ].includes(issue.code)
          ? issue.code
          : "invalid_argument",
        ...(Number.isFinite(issue.minimum) ? { minimum: issue.minimum } : {}),
        ...(Number.isFinite(issue.maximum) ? { maximum: issue.maximum } : {}),
      })),
      hint: "Correct the named arguments within these bounds, or omit optional budgets and use pagination. The operation did not succeed. Do not infer unread content or claim successful delivery.",
    };
  const hints = {
    SCREENSHOT_BROWSER_MISSING:
      "No supported local Chromium browser is available. No screenshot was saved. The administrator can configure QQ_SCREENSHOT_BROWSER; do not claim capture succeeded.",
    SCREENSHOT_BROWSER_FAILED:
      "The isolated screenshot browser could not start. No screenshot was saved. Check the host browser runtime; do not retry with a local file path.",
    SCREENSHOT_PAGE_UNAVAILABLE:
      "The public page could not be captured within the bounded request budget. No screenshot was saved. Public screenshots use a separate signed-out browser with scripts disabled; authorized App pages have their own app_screenshot tool.",
    APP_SCREENSHOT_TARGET_MISMATCH:
      "The browser did not stay on the requested App content page. No screenshot was saved. A login or unrelated page is not evidence of the requested content.",
    GENERATED_IMAGE_DELIVERY_UNKNOWN:
      "This generated image already has a pending or unknown delivery to this conversation. Do not send it again with a new requestId or regenerate it to bypass this check. Inspect the existing QQ receipt first.",
    INVALID_IMAGE:
      "The downloaded bytes are not a supported image. No pixels were read. Use the actual GIF, PNG, JPEG or WebP attachment; a filename or an error page is not image evidence.",
    IMAGE_MIME_MISMATCH:
      "The declared image format does not match the downloaded bytes. No pixels were read; request a valid source image rather than describing this failed result.",
    IMAGE_TOO_LARGE:
      "Image pixels were not read. GIF originals are limited to 20 MiB; other image originals to 8 MiB. File attachments also obey the configured file size limit. Ask for a smaller source instead of repeating this download.",
    IMAGE_OUTPUT_LIMIT:
      "Image pixels were not read. A static image or single-frame GIF exceeds the 8 MiB output limit. Request a smaller image; do not treat an unread GIF as a successfully viewed animation.",
    IMAGE_DOWNLOAD_TIMEOUT:
      "Image pixels were not read. The bounded download deadline expired. Do not repeatedly retry the same large or slow source; ask for a smaller attachment or a fresh upload. A failed download is not evidence of a static image.",
    IMAGE_DOWNLOAD_HTTP_ERROR:
      "Image pixels were not read. The image server rejected the download or returned an unsupported response. The signed link may have expired; request a fresh upload rather than repeating the same URL.",
    IMAGE_DOWNLOAD_FAILED:
      "Image pixels were not read because the transfer failed. Do not describe the image or repeatedly retry the same source. A fresh upload may be needed.",
    IMAGE_DOWNLOAD_BUSY:
      "The image download concurrency limit is reached. Wait for existing reads to finish before requesting another image; no pixels were read by this call.",
    IMAGE_URL_DENIED:
      "The source URL failed the public-network safety check. Do not bypass this check with another tool or a local path; request a supported QQ image upload.",
    IMAGE_REDIRECT_INVALID:
      "Image pixels were not read because the download redirect was invalid. Request a fresh supported upload; do not infer image content.",
    IMAGE_REDIRECT_LIMIT:
      "Image pixels were not read because the download exceeded its redirect limit. Request a fresh supported upload; do not repeat the redirect chain.",
    IMAGE_NOT_FOUND:
      "This record has no image at the requested source/index. Use the ID of the event containing the actual image or image file attachment. source selects image or file; index starts at zero within that type. Text about an image is not image evidence.",
    IMAGE_ATTACHMENT_REQUIRED:
      "The selected file is not named as a GIF, PNG, JPEG or WebP image attachment. Read the actual image event instead. Arbitrary files cannot be interpreted as image pixels.",
    IMAGE_URL_UNAVAILABLE:
      "The image event has no downloadable source URL. Request a fresh image upload; no pixels were read and a local gateway path must not be substituted.",
    REPLY_BURST_LIMIT:
      "Consecutive replies are exhausted. Read genuinely new human input before replying again; rereads, peer messages and restarting a turn do not refill this budget.",
    PRIVATE_RECOLLECTION_EXTERNAL_CALL_BLOCKED:
      "This request lacks outbound authority. Ordinary searches/reads can use the administrator's autonomous network permission; otherwise use a configured exact public URL, a matching current human requestEventId, or exact console approval. Operations-derived content and media disclosure still require their own authority. Do not copy private records into a query.",
    EXTERNAL_URL_REQUIRES_WEB_FETCH:
      "Arbitrary MCP URL fetching cannot enforce bridge DNS/redirect checks. Use web_fetch for a public URL; no external call was made.",
    APP_OUTSIDE_HOURS:
      "The configured browsing hours reject this action. A matching current human requestEventId bypasses autonomous-only hours; an administrator all-hours policy still applies.",
  };
  return {
    code: /^[A-Z][A-Z0-9_:-]{0,100}$/.test(error?.message || "")
      ? error.message
      : "TOOL_FAILED",
    hint:
      hints[error?.message] ||
      "The operation was rejected or not confirmed. Do not claim success; unknown delivery must not be retried with a new request ID.",
  };
}
