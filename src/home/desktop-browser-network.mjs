import http from "node:http";
import https from "node:https";
import net from "node:net";
import { publicUrl } from "../apps/urls.mjs";
import {
  isPrivateIp,
  validateFetchUrl,
} from "../../vendor/social-reader/safe-fetch.js";
import { validateWithSignal } from "../tools/file-download.mjs";

const hopHeaders = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

function forwardedHeaders(headers) {
  const normalized = Object.fromEntries(
    Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]),
  );
  const connection = String(normalized.connection ?? "")
    .toLowerCase()
    .split(",")
    .map((value) => value.trim());
  return Object.fromEntries(
    Object.entries(normalized).filter(
      ([name]) => !hopHeaders.has(name) && !connection.includes(name),
    ),
  );
}

function pinnedRequest(url, options) {
  return new Promise((resolve, reject) => {
    const request = (url.protocol === "https:" ? https : http).request(
      url,
      { ...options, agent: false },
      (response) => {
        const chunks = [];
        let bytes = 0;
        response.on("data", (chunk) => {
          bytes += chunk.length;
          if (bytes > 16 * 1024 * 1024) {
            response.destroy();
            reject(Error("DESKTOP_BROWSER_LIMIT"));
          } else chunks.push(chunk);
        });
        response.on("end", () =>
          resolve({
            status: response.statusCode,
            headers: response.headers,
            body: Buffer.concat(chunks),
          }),
        );
        response.on("error", reject);
        response.on("aborted", () =>
          reject(Error("DESKTOP_BROWSER_UNAVAILABLE")),
        );
      },
    );
    request.on("error", reject);
    request.end(options.body);
  });
}

// The browser has no direct network route. Each intercepted request must
// retain the turn's external authorization before DNS and before dispatch.
export function attachDesktopBrowserNetwork(
  cdp,
  { validate = validateFetchUrl, request = pinnedRequest } = {},
) {
  const lifetime = new AbortController();
  const inFlight = new Set();
  let policy;
  async function handle({ requestId, request: incoming }) {
    try {
      const authorize = policy;
      if (!authorize || !["GET", "HEAD", "POST"].includes(incoming.method))
        throw Error("DESKTOP_BROWSER_DENIED");
      const url = publicUrl(incoming.url);
      const headers = forwardedHeaders(incoming.headers);
      const post = incoming.method === "POST";
      let data;
      let postAuthorization;
      if (post) {
        if (
          !authorize.post ||
          !/^(?:application\/(?:json|x-www-form-urlencoded)|text\/plain)(?:;|$)/i.test(
            headers["content-type"] ?? "",
          )
        )
          throw Error("DESKTOP_BROWSER_DENIED");
        data = incoming.postDataEntries?.every(
          ({ bytes }) => bytes !== undefined,
        )
          ? Buffer.concat(
              incoming.postDataEntries.map(({ bytes }) =>
                Buffer.from(bytes, "base64"),
              ),
            )
          : Buffer.from(incoming.postData ?? "");
        const body = data.toString("utf8");
        if (
          (incoming.hasPostData && !data.length) ||
          data.length > 64 * 1024 ||
          !Buffer.from(body).equals(data)
        )
          throw Error("DESKTOP_BROWSER_DENIED");
        postAuthorization = { url: url.href, method: "POST", body };
      }
      const check = () => {
        if (post) authorize.post(postAuthorization);
        else authorize(url.href, undefined, "network");
      };
      check();
      const signal = AbortSignal.any([
        lifetime.signal,
        AbortSignal.timeout(15_000),
      ]);
      const { addresses } = await validateWithSignal(
        url.href,
        validate,
        signal,
      );
      if (!addresses?.length || addresses.some(isPrivateIp))
        throw Error("DESKTOP_BROWSER_DENIED");
      const pins = addresses.map((value) => ({
        address: value,
        family: net.isIP(value),
      }));
      delete headers.host;
      delete headers["content-length"];
      headers["accept-encoding"] = "identity";
      if (post) headers["content-length"] = String(data.length);
      check();
      const response = await request(url, {
        headers,
        body: data,
        signal,
        method: incoming.method,
        lookup(_host, { all }, done) {
          if (all) done(null, pins);
          else done(null, pins[0].address, pins[0].family);
        },
      });
      signal.throwIfAborted();
      const responseHeaders = Object.entries(
        forwardedHeaders(response.headers),
      ).flatMap(([name, value]) =>
        [value].flat().map((item) => ({ name, value: String(item) })),
      );
      await cdp.send("Fetch.fulfillRequest", {
        requestId,
        responseCode: response.status,
        responseHeaders,
        body: response.body.toString("base64"),
      });
    } catch {
      await cdp
        .send("Fetch.failRequest", {
          requestId,
          errorReason: "BlockedByClient",
        })
        .catch(() => {});
    }
  }
  function paused(event) {
    const job = handle(event);
    inFlight.add(job);
    void job.finally(() => inFlight.delete(job));
  }
  cdp.on("Fetch.requestPaused", paused);
  return {
    ready: cdp.send("Fetch.enable", {
      patterns: [{ urlPattern: "http://*" }, { urlPattern: "https://*" }],
    }),
    authorize(value) {
      policy = value;
    },
    async close() {
      cdp.off("Fetch.requestPaused", paused);
      lifetime.abort();
      await Promise.allSettled(inFlight);
    },
  };
}
