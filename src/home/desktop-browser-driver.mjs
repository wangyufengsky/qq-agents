/* global document, getComputedStyle */
import { randomUUID } from "node:crypto";
import { chromium } from "playwright-core";
import { publicUrl } from "../apps/urls.mjs";
import { buildChildEnv } from "../core/child-env.mjs";
import {
  isPrivateIp,
  validateFetchUrl,
} from "../../vendor/social-reader/safe-fetch.js";
import { requestFile, validateWithSignal } from "../tools/file-download.mjs";
import { findDesktopBrowser } from "../tools/public-screenshot.mjs";

const renderingOrigin = "https://desktop-browser.invalid";
const documentTypes = new Set(["text/html", "application/xhtml+xml"]);
const resourceTypes = {
  image:
    /^(image\/(?:png|jpeg|gif|webp|avif|svg\+xml|x-icon|vnd\.microsoft\.icon))$/,
  stylesheet: /^text\/css$/,
  font: /^(font\/(?:woff2?|ttf|otf)|application\/font-woff)$/,
};
const contentSecurityPolicy = [
  "default-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "img-src 'self' data:",
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self'",
  "sandbox allow-same-origin",
].join("; ");
const limits = {
  deadlineMs: 15000,
  requests: 64,
  responseBytes: 2 * 1024 * 1024,
  navigationBytes: 12 * 1024 * 1024,
  redirects: 5,
  elements: 40,
  text: 5000,
};

function failure(code) {
  return Error("DESKTOP_BROWSER_" + code);
}

function checkedUrl(raw, origin) {
  let url;
  try {
    url = publicUrl(raw);
  } catch {
    throw failure("DENIED");
  }
  if (url.href.length > 2048 || (origin && url.origin !== origin))
    throw failure("DENIED");
  return url;
}

function renderingUrl(url) {
  const result = new URL(renderingOrigin);
  result.pathname = url.pathname;
  result.search = url.search;
  result.hash = url.hash;
  return result.href;
}

function externalUrl(raw, origin) {
  const url = checkedUrl(raw);
  if (url.origin !== renderingOrigin) return checkedUrl(url.href, origin);
  const external = new URL(origin);
  external.pathname = url.pathname;
  external.search = url.search;
  external.hash = url.hash;
  return external;
}

function mimeType(response) {
  return response.contentType?.split(";", 1)[0].trim().toLowerCase();
}

function broker(origin, signal, validate, request) {
  let count = 0;
  let received = 0;
  let queue = Promise.resolve();
  const fetchOne = async (raw) => {
    let url = checkedUrl(raw, origin);
    for (let hop = 0; hop <= limits.redirects; hop++) {
      signal.throwIfAborted();
      if (++count > limits.requests || received >= limits.navigationBytes)
        throw failure("LIMIT");
      const checked = await validateWithSignal(url.href, validate, signal);
      if (!checked.addresses?.length || checked.addresses.some(isPrivateIp))
        throw failure("DENIED");
      signal.throwIfAborted();
      const maxBytes = Math.min(
        limits.responseBytes,
        limits.navigationBytes - received,
      );
      let streamed = 0;
      const response = await request(url, checked.addresses, {
        signal,
        maxBytes,
        includeType: true,
        onBytes(bytes) {
          streamed += bytes;
          received += bytes;
        },
      });
      signal.throwIfAborted();
      if (response.redirect) {
        try {
          url = checkedUrl(new URL(response.redirect, url).href, origin);
        } catch {
          throw failure("DENIED");
        }
        continue;
      }
      received += Math.max(0, response.buffer.length - streamed);
      if (response.buffer.length > maxBytes) throw failure("LIMIT");
      return { ...response, url };
    }
    throw failure("LIMIT");
  };
  return (url) => {
    const next = queue.then(() => fetchOne(url));
    queue = next.catch(() => {});
    return next;
  };
}

function responseHeaders(response) {
  return {
    "content-type": response.contentType,
    "content-security-policy": contentSecurityPolicy,
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "cache-control": "no-store",
  };
}

// Chromium renders at an inert origin with networking disabled. The only
// external sockets belong to the bounded, DNS-pinned request broker.
export function createDesktopBrowserDriver({
  executablePath,
  launch = (options) => chromium.launch(options),
  validate = validateFetchUrl,
  request = requestFile,
} = {}) {
  async function open(approvedOrigin, signal = new AbortController().signal) {
    const origin = checkedUrl(approvedOrigin).origin;
    if (origin !== approvedOrigin || origin === renderingOrigin)
      throw failure("DENIED");
    const lifetime = new AbortController();
    const startup = AbortSignal.any([
      signal,
      AbortSignal.timeout(limits.deadlineMs),
    ]);
    let browser;
    let context;
    let page;
    let closing;
    let action;
    let currentUrl;
    let currentRendered;
    let refs = new Map();
    let navigation;

    const close = () => {
      if (!closing) {
        closing = Promise.resolve()
          .then(() => browser?.close())
          .catch(() => {
            throw failure("UNAVAILABLE");
          });
        lifetime.abort(failure("UNAVAILABLE"));
        refs.clear();
      }
      return closing;
    };
    const cancelStart = () => {
      if (browser) void close().catch(() => {});
    };
    startup.addEventListener("abort", cancelStart, { once: true });
    try {
      startup.throwIfAborted();
      browser = await launch({
        executablePath:
          executablePath ?? findDesktopBrowser(chromium.executablePath()).path,
        headless: true,
        chromiumSandbox: true,
        ignoreDefaultArgs: [
          "--enable-unsafe-swiftshader",
          "--unsafely-disable-devtools-self-xss-warnings",
        ],
        timeout: limits.deadlineMs,
        env: buildChildEnv("browser"),
        args: [
          "--disable-background-networking",
          "--disable-component-update",
          "--disable-extensions",
          "--disable-sync",
          "--disable-quic",
          "--disable-unsafe-swiftshader",
          "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
          "--host-resolver-rules=MAP * ~NOTFOUND",
          "--proxy-server=http://desktop-browser.invalid:9",
          "--proxy-bypass-list=<-loopback>",
        ],
      });
      startup.throwIfAborted();
      context = await browser.newContext({
        javaScriptEnabled: false,
        serviceWorkers: "block",
        acceptDownloads: false,
        offline: true,
      });
      await context.route("**/*", async (route) => {
        try {
          const request = route.request();
          const url = checkedUrl(request.url(), renderingOrigin);
          if (request.method() !== "GET" || !navigation)
            throw failure("DENIED");
          if (request.isNavigationRequest()) {
            if (
              navigation.served ||
              url.href !== navigation.rendered ||
              request.frame() !== page.mainFrame()
            )
              throw failure("DENIED");
            navigation.served = true;
            const { response } = navigation;
            return await route.fulfill({
              status: 200,
              headers: responseHeaders(response),
              body: response.buffer,
            });
          }
          const allowed = resourceTypes[request.resourceType()];
          if (!allowed) throw failure("DENIED");
          const response = await navigation.fetch(
            externalUrl(url.href, origin).href,
          );
          if (!allowed.test(mimeType(response))) throw failure("DENIED");
          await route.fulfill({
            status: 200,
            headers: responseHeaders(response),
            body: response.buffer,
          });
        } catch {
          await route.abort().catch(() => {});
        }
      });
      await context.routeWebSocket(/.*/, (socket) => socket.close());
      page = await context.newPage();
      context.on("page", (extra) => {
        if (extra !== page) void extra.close().catch(() => {});
      });
      startup.throwIfAborted();
    } catch {
      await close().catch(() => {});
      signal.throwIfAborted();
      throw failure("UNAVAILABLE");
    } finally {
      startup.removeEventListener("abort", cancelStart);
    }

    async function perform(signal, operation) {
      if (closing) throw failure("UNAVAILABLE");
      if (action) throw failure("BUSY");
      const combined = AbortSignal.any([
        lifetime.signal,
        AbortSignal.timeout(limits.deadlineMs),
        ...(signal ? [signal] : []),
      ]);
      combined.throwIfAborted();
      const abort = () => void close().catch(() => {});
      combined.addEventListener("abort", abort, { once: true });
      action = true;
      try {
        const result = await operation(combined);
        combined.throwIfAborted();
        return result;
      } catch (error) {
        if (signal?.aborted) signal.throwIfAborted();
        if (combined.aborted) throw failure("UNAVAILABLE");
        if (/^DESKTOP_BROWSER_[A-Z_]+$/.test(error?.message)) throw error;
        throw failure("UNAVAILABLE");
      } finally {
        action = false;
        combined.removeEventListener("abort", abort);
      }
    }

    async function observePage() {
      if (!currentUrl || page.url() !== currentRendered)
        throw failure("UNAVAILABLE");
      const prefix = randomUUID();
      const observation = await page.evaluate(
        ({ textLimit, elementLimit, prefix }) => {
          const selector =
            "a[href],summary,input:not([disabled]),textarea:not([disabled])";
          const visible = (element) => {
            const style = getComputedStyle(element);
            return (
              element.getClientRects().length > 0 &&
              style.visibility === "visible" &&
              !element.closest("[inert],[aria-hidden=true]")
            );
          };
          const kindOf = (element) => {
            if (element.matches("a[href]")) return "link";
            if (
              element.matches("summary,input[type=checkbox],input[type=radio]")
            )
              return "toggle";
            if (
              element.matches(
                "textarea,input:not([type]),input[type=text],input[type=search],input[type=email],input[type=tel],input[type=url]",
              )
            )
              return "field";
            return null;
          };
          for (const element of document.querySelectorAll(
            "[data-qq-desktop-ref]",
          ))
            element.removeAttribute("data-qq-desktop-ref");
          const elements = [];
          for (const element of document.querySelectorAll(selector)) {
            const kind = kindOf(element);
            if (!kind || !visible(element)) continue;
            const ref = prefix + "-" + elements.length;
            element.setAttribute("data-qq-desktop-ref", ref);
            const label = (
              element.getAttribute("aria-label") ||
              element.labels?.[0]?.innerText ||
              element.innerText ||
              element.getAttribute("placeholder") ||
              element.getAttribute("title") ||
              ""
            )
              .trim()
              .slice(0, 96);
            elements.push({ ref, kind, label });
            if (elements.length >= elementLimit) break;
          }
          return {
            title: document.title.trim().slice(0, 256),
            text: (document.body?.innerText || "").trim().slice(0, textLimit),
            elements,
          };
        },
        { textLimit: limits.text, elementLimit: limits.elements, prefix },
      );
      refs = new Map(observation.elements.map(({ ref, kind }) => [ref, kind]));
      return { url: currentUrl.href, ...observation };
    }

    async function navigatePage(raw, signal) {
      refs.clear();
      const fetch = broker(origin, signal, validate, request);
      const response = await fetch(raw);
      if (!documentTypes.has(mimeType(response))) throw failure("DENIED");
      const rendered = renderingUrl(response.url).split("#", 1)[0];
      currentUrl = undefined;
      navigation = { rendered, response, fetch, served: false };
      try {
        const loaded = await page.goto(rendered, {
          waitUntil: "load",
          timeout: limits.deadlineMs,
        });
        if (!loaded?.ok() || !navigation.served) throw failure("UNAVAILABLE");
        currentUrl = response.url;
        currentRendered = rendered;
      } finally {
        navigation = undefined;
      }
      return observePage();
    }

    function lookup(ref, kinds) {
      if (page.url() !== currentRendered || !kinds.includes(refs.get(ref)))
        throw failure("STALE");
      return page.locator(`[data-qq-desktop-ref="${ref}"]`);
    }

    return {
      navigate: (url, signal) =>
        perform(signal, (combined) => navigatePage(url, combined)),
      observe: (signal) => perform(signal, observePage),
      click: (ref, signal) =>
        perform(signal, async (combined) => {
          const element = lookup(ref, ["link", "toggle"]);
          if (refs.get(ref) === "link") {
            const href = await element.evaluate((link) => link.href);
            return navigatePage(externalUrl(href, origin).href, combined);
          }
          await element.click({ timeout: limits.deadlineMs });
          return observePage();
        }),
      fill: (ref, text, signal) =>
        perform(signal, async () => {
          if (typeof text !== "string" || text.length > 1000)
            throw failure("LIMIT");
          await lookup(ref, ["field"]).fill(text, {
            timeout: limits.deadlineMs,
          });
          return observePage();
        }),
      close,
    };
  }

  return { open };
}
