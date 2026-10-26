import { downloadFile } from "./file-download.mjs";

// Images share the bounded, DNS-pinned attachment transport, not the short
// webpage fetch budget. Keep provider messages and signed URLs out of errors.
export function imageDownloadError(error, signal) {
  if (signal?.aborted) return Error("ABORTED");
  const codes = {
    FILE_TOO_LARGE: "IMAGE_TOO_LARGE",
    FILE_DOWNLOAD_HTTP_ERROR: "IMAGE_DOWNLOAD_HTTP_ERROR",
    FILE_DOWNLOAD_FAILED: "IMAGE_DOWNLOAD_FAILED",
    FILE_DOWNLOAD_CANCELLED: "IMAGE_DOWNLOAD_TIMEOUT",
    FILE_URL_DENIED: "IMAGE_URL_DENIED",
    FILE_REDIRECT_INVALID: "IMAGE_REDIRECT_INVALID",
    FILE_REDIRECT_LIMIT: "IMAGE_REDIRECT_LIMIT",
  };
  return Error(
    codes[error?.message] ||
      (error?.name === "TimeoutError"
        ? "IMAGE_DOWNLOAD_TIMEOUT"
        : "IMAGE_DOWNLOAD_FAILED"),
  );
}

export async function downloadImage(url, maxBytes, { signal } = {}, transport) {
  try {
    return await downloadFile(url, { maxBytes, signal }, transport);
  } catch (error) {
    throw imageDownloadError(error, signal);
  }
}
