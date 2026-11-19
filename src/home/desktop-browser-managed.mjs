/* global document, getComputedStyle */
import { randomUUID } from "node:crypto";
import { chromium } from "playwright-core";
import { publicUrl } from "../apps/urls.mjs";
import { buildChildEnv } from "../core/child-env.mjs";
import { findDesktopBrowser } from "../tools/public-screenshot.mjs";
import { attachDesktopBrowserNetwork } from "./desktop-browser-network.mjs";

const deadlineMs = 12_000;
const elementLimit = 40;
const selector = [
  "a[href]",
  "button",
  "summary",
  "select",
  "textarea",
  "input:not([type=password]):not([type=hidden]):not([type=file])",
  "[contenteditable=true]",
  "[role=button]",
  "[role=link]",
  "[role=checkbox]",
  "[role=textbox]",
  "[role=switch]",
].join(",");

function browserError(code) {
  return Error("DESKTOP_BROWSER_" + code);
}

function actionUnconfirmed() {
  // Browser error causes may include the private URL or page content.
  return Error("ACTION_UNCONFIRMED");
}

function pageUrl(raw) {
  try {
    return publicUrl(raw).href;
  } catch {
    throw browserError("DENIED");
  }
}

export function createManagedDesktopBrowserDriver({
  executablePath,
  launch = (options) => chromium.launch(options),
  networkOptions,
} = {}) {
  async function open(_origin, signal) {
    signal?.throwIfAborted();
    let network;
    let browser;
    let closing;
    let page;
    let refs = new Map();
    const close = () => {
      closing ??= Promise.allSettled([browser?.close(), network?.close()]);
      return closing;
    };
    try {
      signal?.throwIfAborted();
      browser = await launch({
        executablePath:
          executablePath ?? findDesktopBrowser(chromium.executablePath()).path,
        headless: true,
        chromiumSandbox: true,
        ignoreDefaultArgs: [
          "--enable-unsafe-swiftshader",
          "--unsafely-disable-devtools-self-xss-warnings",
        ],
        timeout: deadlineMs,
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
      signal?.throwIfAborted();
      const context = await browser.newContext({
        javaScriptEnabled: true,
        acceptDownloads: false,
        serviceWorkers: "block",
      });
      context.setDefaultTimeout(deadlineMs);
      context.setDefaultNavigationTimeout(deadlineMs);
      page = await context.newPage();
      const cdp = await context.newCDPSession(page);
      network = attachDesktopBrowserNetwork(cdp, networkOptions);
      await network.ready;
      context.on("page", (opened) => void opened.close().catch(() => {}));
      signal?.throwIfAborted();
    } catch (error) {
      await close();
      if (signal?.aborted) throw signal.reason;
      throw browserError("UNAVAILABLE");
    }

    async function clearRefs(keep) {
      const previous = refs;
      refs = new Map();
      await Promise.allSettled(
        [...previous.values()]
          .filter(({ element }) => element !== keep)
          .map(({ element }) => element.dispose()),
      );
    }

    async function observePage() {
      const current = page;
      const url = pageUrl(current.url());
      await clearRefs();
      const handles = await current.evaluateHandle(
        ({ selector, limit }) =>
          Array.from(document.querySelectorAll(selector))
            .filter(
              (element) =>
                element.getClientRects().length > 0 &&
                getComputedStyle(element).visibility === "visible" &&
                !element.closest(
                  "[inert],[aria-hidden=true],[disabled],[aria-disabled=true]",
                ),
            )
            .slice(0, limit),
        { selector, limit: elementLimit },
      );
      const elements = [];
      try {
        for (const handle of (await handles.getProperties()).values()) {
          const element = handle.asElement();
          if (!element) continue;
          const descriptor = await element.evaluate((node) => {
            const tag = node.tagName.toLowerCase();
            const type = node.getAttribute("type")?.toLowerCase();
            if (["password", "file", "hidden"].includes(type)) return null;
            const role =
              node.getAttribute("role") ||
              {
                a: "link",
                button: "button",
                select: "combobox",
                summary: "button",
                textarea: "textbox",
              }[tag] ||
              (["checkbox", "radio"].includes(type)
                ? type
                : tag === "input"
                  ? "textbox"
                  : "generic");
            const fillable =
              node.isContentEditable ||
              tag === "textarea" ||
              (tag === "input" &&
                ![
                  "button",
                  "submit",
                  "checkbox",
                  "radio",
                  "image",
                  "reset",
                ].includes(type));
            const referenced = (node.getAttribute("aria-labelledby") ?? "")
              .split(/\s+/)
              .map((id) => document.getElementById(id)?.innerText)
              .filter(Boolean)
              .join(" ");
            const label = (
              node.getAttribute("aria-label") ??
              (referenced ||
                node.labels?.[0]?.innerText ||
                node.innerText ||
                node.getAttribute("placeholder") ||
                node.getAttribute("title") ||
                "")
            ).trim();
            return {
              role: role.slice(0, 48),
              label: label.slice(0, 120),
              fillable,
            };
          });
          if (!descriptor) {
            await element.dispose();
            continue;
          }
          const ref = randomUUID();
          refs.set(ref, {
            element,
            fillable: descriptor.fillable,
            page: current,
          });
          elements.push({
            ref,
            role: descriptor.role,
            label: descriptor.label,
            kind: descriptor.fillable
              ? "field"
              : descriptor.role === "link"
                ? "link"
                : "control",
          });
        }
      } finally {
        await handles.dispose();
      }
      if (current !== page || current.url() !== url)
        throw browserError("STALE");
      const details = await current.evaluate(() => ({
        title: document.title.trim().slice(0, 256),
        text: (document.body?.innerText ?? "").trim().slice(0, 5000),
      }));
      if (current !== page || current.url() !== url)
        throw browserError("STALE");
      return { url, ...details, elements };
    }

    async function perform(signal, authorize, work) {
      signal?.throwIfAborted();
      if (closing || !browser.isConnected()) throw browserError("UNAVAILABLE");
      network.authorize(authorize);
      try {
        const value = await work();
        signal?.throwIfAborted();
        return value;
      } catch (error) {
        if (signal?.aborted) throw signal.reason;
        if (
          /^(?:DESKTOP_BROWSER_[A-Z_]+|SENSITIVE_OUTPUT_BLOCKED|PRIVATE_RECOLLECTION_EXTERNAL_CALL_BLOCKED|SOCIAL_SOURCE_DENIED|PROTECTED_WORK_OUTBOUND_DENIED|ACTION_UNCONFIRMED|SOURCE_RESTRICTED)$/.test(
            error?.message,
          )
        )
          throw error;
        if (!browser.isConnected() || page.isClosed())
          throw browserError("UNAVAILABLE");
        throw actionUnconfirmed();
      } finally {
        network.authorize(undefined);
      }
    }

    async function interact(ref, signal, authorize, text) {
      const entry = refs.get(ref);
      if (
        !entry ||
        entry.page !== page ||
        (text !== undefined && !entry.fillable)
      )
        throw browserError("STALE");
      const { element } = entry;
      await clearRefs(element);
      try {
        const link =
          text === undefined
            ? await element.evaluate((node) => {
                const anchor = node.closest("a[href]");
                if (anchor) return { url: anchor.href, target: anchor.target };
                const form = node.form;
                return (
                  form && {
                    url: node.getAttribute("formaction")
                      ? node.formAction
                      : form.action,
                  }
                );
              })
            : undefined;
        authorize?.(pageUrl(link?.url || page.url()), text);
        signal?.throwIfAborted();
        if (text !== undefined)
          await element.fill(text, { timeout: deadlineMs });
        else if (link?.target === "_blank")
          await page.goto(pageUrl(link.url), { waitUntil: "domcontentloaded" });
        else {
          await element.click({ timeout: deadlineMs });
          await page.waitForLoadState("domcontentloaded");
        }
      } finally {
        await element.dispose().catch(() => {});
      }
      return observePage();
    }

    return {
      navigate(url, signal, authorize) {
        return perform(signal, authorize, async () => {
          await clearRefs();
          signal?.throwIfAborted();
          const result = await page.goto(pageUrl(url), {
            waitUntil: "domcontentloaded",
          });
          if (!result?.ok()) throw actionUnconfirmed();
          return observePage();
        });
      },
      observe: (signal, authorize) => perform(signal, authorize, observePage),
      click: (ref, signal, authorize) =>
        perform(signal, authorize, () => interact(ref, signal, authorize)),
      fill: (ref, text, signal, authorize) =>
        perform(signal, authorize, () =>
          interact(ref, signal, authorize, text),
        ),
      close,
    };
  }

  return { open };
}
