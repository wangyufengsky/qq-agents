import test from "node:test";
import assert from "node:assert/strict";
import { createDesktopBrowserDriver } from "../src/home/desktop-browser-driver.mjs";

const origin = "https://approved.example";
const publicAddress = "93.184.216.34";
const validatePublic = async (url) => ({
  url: new URL(url),
  addresses: [publicAddress],
});
const html = (text) => ({
  contentType: "text/html",
  buffer: Buffer.from(text),
});

function fakeChromium(resources = []) {
  let options, contextOptions, routeHandler, finalRequest, fulfilled;
  let closed = 0;
  const frame = {};
  const page = {
    mainFrame: () => frame,
    url: () => finalRequest,
    async goto(url) {
      finalRequest = url;
      await routeHandler({
        request: () => ({
          url: () => url,
          method: () => "GET",
          isNavigationRequest: () => true,
          frame: () => frame,
        }),
        fulfill: async (response) => {
          fulfilled = response;
        },
        abort: async () => {},
      });
      await Promise.all(
        resources.map((path) =>
          routeHandler({
            request: () => ({
              url: () => new URL(path, url).href,
              method: () => "GET",
              isNavigationRequest: () => false,
              resourceType: () => "image",
            }),
            fulfill: async () => {},
            abort: async () => {},
          }),
        ),
      );
      return { ok: () => Boolean(fulfilled) };
    },
    async evaluate() {
      return { title: "Fixture", text: "Fixture", elements: [] };
    },
  };
  return {
    async launch(input) {
      options = input;
      return {
        close: async () => {
          closed++;
        },
        newContext: async (input) => {
          contextOptions = input;
          return {
            route: async (_, handler) => {
              routeHandler = handler;
            },
            routeWebSocket: async () => {},
            newPage: async () => page,
            on: () => {},
          };
        },
      };
    },
    capture: () => ({
      options,
      contextOptions,
      finalRequest,
      fulfilled,
      closed,
    }),
  };
}

test("browser broker follows redirects under its own DNS pins and renders only the final HTML at an inert origin", async (t) => {
  const browser = fakeChromium();
  const checked = [];
  const requested = [];
  const driver = createDesktopBrowserDriver({
    executablePath: "fixture-chromium",
    launch: browser.launch,
    validate: async (raw) => {
      checked.push(raw);
      return validatePublic(raw);
    },
    request: async (url, addresses) => {
      requested.push({ url: url.href, addresses });
      if (url.pathname === "/start") return { redirect: "/target/path" };
      return html("Fixture");
    },
  });
  const session = await driver.open(origin);
  t.after(() => session.close());
  const result = await session.navigate(origin + "/start");
  assert.equal(result.url, origin + "/target/path");
  assert.deepEqual(checked, [origin + "/start", origin + "/target/path"]);
  assert.deepEqual(
    requested,
    checked.map((url) => ({ url, addresses: [publicAddress] })),
  );
  const { options, contextOptions, finalRequest, fulfilled } =
    browser.capture();
  assert.equal(options.chromiumSandbox, true);
  assert.deepEqual(contextOptions, {
    javaScriptEnabled: false,
    serviceWorkers: "block",
    acceptDownloads: false,
    offline: true,
  });
  assert.equal(finalRequest, "https://desktop-browser.invalid/target/path");
  assert.equal(fulfilled.status, 200);
  assert.match(
    fulfilled.headers["content-security-policy"],
    /form-action 'none'/,
  );
  assert.equal(fulfilled.headers["set-cookie"], undefined);
});

test("foreign origins and non-public redirect addresses are denied before any request to them", async (t) => {
  const browser = fakeChromium();
  const checked = [];
  const requested = [];
  const driver = createDesktopBrowserDriver({
    executablePath: "fixture-chromium",
    launch: browser.launch,
    validate: async (raw) => {
      checked.push(raw);
      if (raw.endsWith("/private"))
        return { addresses: [publicAddress, "127.0.0.1"] };
      if (raw.endsWith("/fake")) return { addresses: ["198.18.0.1"] };
      return validatePublic(raw);
    },
    request: async (url) => {
      requested.push(url.pathname);
      if (url.pathname === "/cross")
        return { redirect: "https://other.example/target" };
      return { redirect: url.pathname.replace("-start", "") };
    },
  });
  const session = await driver.open(origin);
  t.after(() => session.close());
  for (const route of ["/cross", "/private-start", "/fake-start"])
    await assert.rejects(
      session.navigate(origin + route),
      /DESKTOP_BROWSER_DENIED/,
    );
  await assert.rejects(
    session.navigate("file:///etc/passwd"),
    /DESKTOP_BROWSER_DENIED/,
  );
  await assert.rejects(
    session.navigate(origin + "/target?session=fixture"),
    /DESKTOP_BROWSER_DENIED/,
  );
  assert.deepEqual(requested, ["/cross", "/private-start", "/fake-start"]);
  assert.deepEqual(
    checked,
    ["/cross", "/private-start", "/private", "/fake-start", "/fake"].map(
      (route) => origin + route,
    ),
  );
  assert.equal(browser.capture().finalRequest, undefined);
});

test("failed subresources consume the shared streamed byte budget", async (t) => {
  const browser = fakeChromium(
    Array.from({ length: 14 }, (_, index) => "/image-" + index),
  );
  const requested = [];
  const mib = 1024 * 1024;
  const fixture = html("Fixture");
  const driver = createDesktopBrowserDriver({
    executablePath: "fixture-chromium",
    launch: browser.launch,
    validate: validatePublic,
    request: async (url, _, { maxBytes, onBytes }) => {
      if (url.pathname === "/start") {
        onBytes?.(fixture.buffer.length);
        return fixture;
      }
      requested.push({ path: url.pathname, maxBytes });
      onBytes?.(Math.min(mib, maxBytes));
      throw Error("FILE_DOWNLOAD_FAILED");
    },
  });
  const session = await driver.open(origin);
  t.after(() => session.close());
  await session.navigate(origin + "/start");
  assert.equal(requested.length, 12);
  assert.deepEqual(requested.at(-1), {
    path: "/image-11",
    maxBytes: mib - fixture.buffer.length,
  });
});

test("cancellation closes the browser and prevents a delayed broker result from being rendered", async () => {
  const browser = fakeChromium();
  const started = Promise.withResolvers();
  const response = Promise.withResolvers();
  const driver = createDesktopBrowserDriver({
    executablePath: "fixture-chromium",
    launch: browser.launch,
    validate: validatePublic,
    request: async () => {
      started.resolve();
      return response.promise;
    },
  });
  const session = await driver.open(origin);
  const controller = new AbortController();
  const navigating = session.navigate(origin + "/start", controller.signal);
  const rejection = assert.rejects(navigating, /fixture revoked/);
  await started.promise;
  controller.abort(Error("fixture revoked"));
  response.resolve(html("Fixture"));
  await rejection;
  await session.close();
  assert.equal(browser.capture().closed, 1);
  assert.equal(browser.capture().finalRequest, undefined);
  await assert.rejects(session.observe(), /DESKTOP_BROWSER_UNAVAILABLE/);
});

test("real Chromium allows only scoped static-page navigation and refreshes element references", async (t) => {
  const executablePath = process.env.QQ_TEST_DESKTOP_BROWSER;
  if (!executablePath)
    return t.skip(
      "Set QQ_TEST_DESKTOP_BROWSER to run the isolated Chromium acceptance",
    );
  const requested = [];
  const driver = createDesktopBrowserDriver({
    executablePath,
    validate: validatePublic,
    request: async (url) => {
      requested.push(url.href);
      if (url.pathname === "/next")
        return html("<title>Next</title><p>Next page</p>");
      if (url.pathname === "/theme.css")
        return { redirect: "/assets/theme.css" };
      if (url.pathname === "/assets/theme.css")
        return {
          contentType: "text/css",
          buffer: Buffer.from(".css-hidden{display:none}"),
        };
      return html(`
        <title>Static fixture</title>
        <link rel="stylesheet" href="/theme.css">
        <link rel="stylesheet" href="https://other.example/evil.css">
        <iframe src="/unexpected-frame"></iframe>
        <div class="css-hidden">CSS hidden</div>
        <h1>Fixture</h1>
        <script>document.body.innerHTML = 'unexpected script';</script>
        <base href="https://other.example/">
        <a href="/next">Next</a>
        <a href="https://other.example/target">Other</a>
        <form action="/submit" method="post">
          <input placeholder="Search"><input type="password" value="hidden">
          <button>Submit</button>
        </form>
        <details><summary>Details</summary>Expanded content</details>
      `);
    },
  });
  const session = await driver.open(origin);
  t.after(() => session.close());
  const first = await session.navigate(origin + "/start");
  assert.match(first.text, /Fixture/);
  assert.doesNotMatch(first.text, /unexpected script|Expanded content|hidden/i);
  assert.deepEqual(
    first.elements.map(({ label, kind }) => [label, kind]),
    [
      ["Next", "link"],
      ["Other", "link"],
      ["Search", "field"],
      ["Details", "toggle"],
    ],
  );
  await assert.rejects(
    session.click(first.elements[1].ref),
    /DESKTOP_BROWSER_DENIED/,
  );
  const filled = await session.fill(first.elements[2].ref, "literal text");
  assert.equal(filled.filled, true);
  assert.doesNotMatch(JSON.stringify(filled), /literal text/);
  await assert.rejects(
    session.click(first.elements[0].ref),
    /DESKTOP_BROWSER_STALE/,
  );
  const expanded = await session.click(filled.elements[3].ref);
  assert.match(expanded.text, /Expanded content/);
  const next = await session.click(expanded.elements[0].ref);
  assert.equal(next.title, "Next");
  assert.deepEqual(
    requested,
    ["/start", "/theme.css", "/assets/theme.css", "/next"].map(
      (route) => origin + route,
    ),
  );
});
