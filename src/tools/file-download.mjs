import http from "node:http";
import https from "node:https";
import net from "node:net";
import { validateFetchUrl } from "../../vendor/social-reader/safe-fetch.js";

// Resolve and pin each hop; never forward cookies, auth headers or local paths.
export function requestFile(url, addresses, { maxBytes, signal }) {
  return new Promise((resolve, reject) => {
    const request = (url.protocol === "https:" ? https : http).get(
      url,
      {
        signal,
        agent: false,
        headers: { "accept-encoding": "identity" },
        lookup: (_host, options, callback) => {
          const values = addresses.map((address) => ({
            address,
            family: net.isIP(address),
          }));
          if (options.all) callback(null, values);
          else callback(null, values[0].address, values[0].family);
        },
      },
      (response) => {
        if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
          response.destroy();
          resolve({ redirect: response.headers.location });
          return;
        }
        if (
          response.statusCode !== 200 ||
          (response.headers["content-encoding"] &&
            response.headers["content-encoding"] !== "identity")
        ) {
          response.destroy();
          reject(Error("FILE_DOWNLOAD_HTTP_ERROR"));
          return;
        }
        if (Number(response.headers["content-length"]) > maxBytes) {
          response.destroy();
          reject(Error("FILE_TOO_LARGE"));
          return;
        }
        const chunks = [];
        let size = 0;
        response.on("data", (chunk) => {
          size += chunk.length;
          if (size > maxBytes) {
            reject(Error("FILE_TOO_LARGE"));
            response.destroy();
          } else chunks.push(chunk);
        });
        response.on("end", () => resolve({ buffer: Buffer.concat(chunks) }));
        response.on("error", () => reject(Error("FILE_DOWNLOAD_FAILED")));
        response.on("aborted", () => reject(Error("FILE_DOWNLOAD_FAILED")));
      },
    );
    request.on("error", () =>
      reject(
        Error(
          signal.aborted ? "FILE_DOWNLOAD_CANCELLED" : "FILE_DOWNLOAD_FAILED",
        ),
      ),
    );
  });
}

export async function downloadFile(
  raw,
  { maxBytes, signal },
  { validate = validateFetchUrl, request = requestFile } = {},
) {
  const deadline = AbortSignal.timeout(60000);
  const combined = signal ? AbortSignal.any([signal, deadline]) : deadline;
  for (let hop = 0; hop <= 5; hop++) {
    combined.throwIfAborted();
    let checked;
    try {
      checked = await validate(raw);
    } catch {
      throw Error("FILE_URL_DENIED");
    }
    combined.throwIfAborted();
    const result = await request(checked.url, checked.addresses, {
      maxBytes,
      signal: combined,
    });
    if (result.buffer)
      return { buffer: result.buffer, origin: checked.url.origin };
    if (!result.redirect) throw Error("FILE_REDIRECT_INVALID");
    raw = new URL(result.redirect, checked.url).toString();
  }
  throw Error("FILE_REDIRECT_LIMIT");
}
