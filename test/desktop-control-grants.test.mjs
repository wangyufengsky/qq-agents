import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { createServer, request } from "node:http";
import { once } from "node:events";
import test from "node:test";
import { MemoryStore } from "../src/memory/store.mjs";
import { DesktopNative } from "../src/home/desktop-native.mjs";
import { createManagedDesktopBrowserDriver } from "../src/home/desktop-browser-managed.mjs";
import { DesktopBrowser } from "../src/home/desktop-browser.mjs";
import { temp } from "./helpers.mjs";

const owner = "agent-0";
const peer = "agent-1";
const origin = "https://approved.example";

function fixture(t) {
  const memory = new MemoryStore(path.join(temp(t), "memory.sqlite"));
  t.after(() => memory.close());
  const visits = new Map([
    [owner, {}],
    [peer, {}],
  ]);
  const live = {
    room: { epoch: randomUUID() },
    visits,
    here: () => [...visits.keys()].map((id) => ({ id })),
  };
  let now = Date.now();
  const host = {
    live,
    client: { id: randomUUID() },
    connected: () => Boolean(host.client),
    notify() {},
    runtime: {
      config: { desktopHome: { browserControl: { enabled: true } } },
      memory,
      running: new Map(),
      now: () => now,
      assertActive: (ctx) => {
        ctx.controller.signal.throwIfAborted();
        return { id: ctx.agentId };
      },
      agent: (id) => ({ id }),
      toolsFor: () => ["desktop_native_control", "desktop_browser_control"],
      stageToolOutput() {},
      authorizeExternal() {},
      assertSafeOutput() {},
      home: { rooms: { shareable() {} } },
    },
  };
  function ctx(agentId) {
    return {
      agentId,
      controller: new AbortController(),
      desktopUnified: true,
      runtimeKind: "desktop",
      conversation: "@desktop",
      privateRead: new Set(),
      inputEpoch: randomUUID(),
      turnId: randomUUID(),
    };
  }
  function grant(agentId, targetId = randomUUID()) {
    return {
      agentId,
      targetId,
      grantId: randomUUID(),
      roomEpoch: live.room.epoch,
    };
  }
  function reply(native, request) {
    const { roomEpoch, grantId, requestId } = request;
    return native.receive({
      client: host.client.id,
      roomEpoch,
      grantId,
      requestId,
      result: { elements: [] },
    });
  }
  return { host, visits, ctx, grant, reply, advance: (ms) => (now += ms) };
}

test("native grant retains identity across time, disconnection, visits and database reopen", async (t) => {
  const f = fixture(t);
  const native = new DesktopNative(f.host);
  const record = f.grant(owner);
  native.change(false, record);
  f.advance(3_600_000);
  f.visits.delete(owner);
  assert.equal(native.state().grants[0].grantId, record.grantId);
  await assert.rejects(
    native.run(f.ctx(owner), { type: "observe", grantId: record.grantId }),
    /DESKTOP_NATIVE_UNAVAILABLE/,
  );
  f.host.client = undefined;
  native.clear();
  assert.equal(native.state().grants[0].grantId, record.grantId);
  f.host.client = { id: randomUUID() };
  f.host.live.room.epoch = randomUUID();
  f.visits.set(owner, {});
  const restored = new DesktopNative(f.host);
  const observed = restored.run(f.ctx(owner), {
    type: "observe",
    grantId: record.grantId,
  });
  const [request] = restored.clientWork().nativeRequests;
  assert.equal(request.targetId, record.targetId);
  assert.equal(request.roomEpoch, f.host.live.room.epoch);
  f.reply(restored, request);
  await observed;
  assert.deepEqual(
    await restored.run(f.ctx(peer), {
      type: "revoke",
      grantId: record.grantId,
    }),
    { revoked: false },
  );
  assert.deepEqual(
    await restored.run(f.ctx(owner), {
      type: "revoke",
      grantId: record.grantId,
    }),
    { revoked: true },
  );
  const restarted = new DesktopNative(f.host);
  assert.deepEqual(restarted.state().grants, []);
  assert.throws(
    () =>
      restarted.change(false, { ...record, roomEpoch: f.host.live.room.epoch }),
    /DESKTOP_NATIVE_UNAVAILABLE/,
  );
});

test("separate native targets and browser can run together, while a second use of the same target waits for settlement", async (t) => {
  // Unified grants are issued to present roles without the legacy mode or role-tool toggles.

  const f = fixture(t);
  f.host.runtime.config.desktopHome.browserControl.enabled = false;
  f.host.runtime.toolsFor = () => [];
  const native = new DesktopNative(f.host);
  assert.deepEqual(native.state().eligible, []);
  assert.deepEqual(native.unified.eligible(), [owner, peer]);
  const first = f.grant(owner);
  const sameTarget = f.grant(peer, first.targetId);
  const other = f.grant(peer);
  for (const grant of [first, sameTarget, other]) native.change(false, grant);
  const firstOperation = native.run(f.ctx(owner), {
    type: "observe",
    grantId: first.grantId,
  });
  const otherOperation = native.run(f.ctx(peer), {
    type: "observe",
    grantId: other.grantId,
  });
  await assert.rejects(
    native.run(f.ctx(peer), { type: "observe", grantId: sameTarget.grantId }),
    /DESKTOP_NATIVE_UNAVAILABLE/,
  );
  const browserGate = Promise.withResolvers();
  const starting = Promise.withResolvers();
  const browser = new DesktopBrowser(f.host, {
    driver: {
      async open() {
        return {
          async navigate() {
            starting.resolve();
            await browserGate.promise;
            return { title: "fixture" };
          },
          async observe() {
            return { title: "same browser across turns" };
          },
          async close() {},
        };
      },
    },
  });
  const browserRecord = f.grant(owner);
  assert.deepEqual(browser.state().eligible, []);
  assert.deepEqual(browser.unified.eligible(), [owner, peer]);
  browser.change("browser-grant", browserRecord);
  const browsing = browser.run(f.ctx(owner), {
    action: "navigate",
    url: origin,
    grantId: browserRecord.grantId,
  });
  await starting.promise;
  const requests = native.clientWork().nativeRequests;
  assert.equal(requests.length, 2);
  for (const request of requests) f.reply(native, request);
  await Promise.all([firstOperation, otherOperation]);
  const sequence = native.run(f.ctx(peer), {
    type: "observe",
    grantId: sameTarget.grantId,
  });
  f.reply(native, native.clientWork().nativeRequests[0]);
  await sequence;
  browserGate.resolve();
  await browsing;
  f.advance(3_600_000);
  f.visits.delete(owner);
  await assert.rejects(
    browser.run(f.ctx(owner), {
      action: "observe",
      grantId: browserRecord.grantId,
    }),
    /DESKTOP_BROWSER_UNAVAILABLE/,
  );
  assert.equal(browser.state().grants[0].grantId, browserRecord.grantId);
  f.visits.set(owner, {});
  assert.match(
    (
      await browser.run(f.ctx(owner), {
        action: "observe",
        grantId: browserRecord.grantId,
      })
    ).title,
    /same browser/,
  );
  browser.change("browser-revoke", {
    roomEpoch: browserRecord.roomEpoch,
    grantId: browserRecord.grantId,
  });
  assert.deepEqual(browser.state().grants, []);
  assert.deepEqual(new DesktopBrowser(f.host).state().grants, []);
});

test("a closed browser target remains unavailable across framework restart", async (t) => {
  const f = fixture(t);
  let opens = 0;
  const driver = {
    async open() {
      opens++;
      return { navigate: async () => ({ title: "fixture" }), async close() {} };
    },
  };
  const browser = new DesktopBrowser(f.host, { driver });
  const record = { ...f.grant(owner), origin };
  browser.change("browser-grant", record);
  assert.equal(browser.state().grants[0].targetStatus, "ready-to-open");
  const action = { action: "navigate", url: origin, grantId: record.grantId };
  await browser.run(f.ctx(owner), action);
  assert.equal(browser.state().grants[0].targetStatus, "open");
  await browser.suspendUnified();

  const restored = new DesktopBrowser(f.host, { driver });
  assert.equal(restored.state().grants[0].targetStatus, "unavailable");
  await assert.rejects(
    restored.run(f.ctx(owner), action),
    /DESKTOP_BROWSER_UNAVAILABLE/,
  );
  assert.equal(opens, 1);
});

test("real unified browser runs JavaScript, follows a public cross-site link, isolates cookie state and revokes one browser", async (t) => {
  const executablePath = process.env.QQ_TEST_DESKTOP_BROWSER;
  if (!executablePath)
    return t.skip(
      "Set QQ_TEST_DESKTOP_BROWSER for isolated Chromium acceptance",
    );
  const requests = [];
  const decisions = [];
  const f = fixture(t);
  f.host.runtime.authorizeExternal = (_ctx, request) =>
    decisions.push(request.args);
  const app = createServer(async (incoming, outgoing) => {
    requests.push([
      incoming.headers.host,
      incoming.url,
      incoming.headers.cookie,
    ]);
    outgoing.setHeader("content-type", "text/html");
    if (incoming.headers.host === "next.example") {
      outgoing.end(
        "<title>Next public page</title><h1>Cross-site document</h1>",
      );
      return;
    }
    if (incoming.url === "/commit") {
      const chunks = [];
      for await (const chunk of incoming) chunks.push(chunk);
      outgoing.end(
        `<h1>Submitted form</h1><p>${Buffer.concat(chunks)}</p><a href="http://next.example/">Cross-site link</a>`,
      );
      return;
    }
    if (incoming.url === "/fetch-preview") {
      outgoing.end("Script fetch succeeded");
      return;
    }
    if (incoming.url === "/cookie") {
      outgoing.end(incoming.headers.cookie ?? "Independent cookie jar");
      return;
    }
    outgoing.setHeader("set-cookie", "fixture=current; Path=/; SameSite=Lax");
    outgoing.end(`
      <title>JavaScript fixture</title>
      <form action="/commit" method="POST">
        <label for="name">Display name</label><input id="name" name="display">
        <button id="preview" type="button">Preview</button>
        <button type="submit">Submit fixture</button>
        <output id="result">Before</output>
      </form>
      <script>
        document.querySelector("#result").textContent = "JavaScript ready";
        document.querySelector("#preview").onclick = async () => {
          const response = await fetch("/fetch-preview");
          document.querySelector("#result").textContent =
            document.querySelector("#name").value + ": " + await response.text();
        };
      </script>
    `);
  });
  app.listen(0, "127.0.0.1");
  await once(app, "listening");
  t.after(() => new Promise((resolve) => app.close(resolve)));
  const driver = createManagedDesktopBrowserDriver({
    executablePath,
    networkOptions: {
      async validate(raw) {
        const url = new URL(raw);
        if (!["fixture.example", "next.example"].includes(url.hostname))
          throw Error("DESKTOP_BROWSER_DENIED");
        return { addresses: ["93.184.216.34"] };
      },
      request(url, options) {
        assert.equal(options.lookup instanceof Function, true);
        return new Promise((resolve, reject) => {
          const socket = request(
            url,
            {
              ...options,
              headers: { ...options.headers, host: url.host },
              hostname: "127.0.0.1",
              port: app.address().port,
            },
            (response) => {
              const chunks = [];
              response.on("data", (chunk) => chunks.push(chunk));
              response.on("end", () =>
                resolve({
                  status: response.statusCode,
                  headers: response.headers,
                  body: Buffer.concat(chunks),
                }),
              );
            },
          );
          socket.on("error", reject);
          socket.end(options.body);
        });
      },
    },
  });
  const browser = new DesktopBrowser(f.host, { managedDriver: driver });
  t.after(() => browser.suspendUnified());
  const first = f.grant(owner);
  const second = f.grant(owner);
  browser.change("browser-grant", first);
  browser.change("browser-grant", second);
  const initial = f.ctx(owner);
  const on = (ctx, grant, action) =>
    browser.run(ctx, { ...action, grantId: grant.grantId });
  let value = await on(initial, first, {
    action: "navigate",
    url: "http://fixture.example/",
  });
  assert.match(value.text, /JavaScript ready/);
  assert.equal(value.url, "http://fixture.example/");
  const ref = (label) =>
    value.elements.find((element) => element.label === label).ref;
  assert.equal(
    value.elements.find((element) => element.label === "Preview").role,
    "button",
  );
  value = await on(initial, first, {
    action: "fill",
    ref: ref("Display name"),
    text: "Fixture name",
  });
  value = await on(initial, first, { action: "click", ref: ref("Preview") });
  for (let i = 0; i < 10 && !value.text.includes("Script fetch succeeded"); i++)
    value = await on(initial, first, { action: "observe" });
  assert.match(value.text, /Fixture name: Script fetch succeeded/);
  value = await on(initial, first, {
    action: "click",
    ref: ref("Submit fixture"),
  });
  assert.match(value.text, /Submitted form/);
  assert.match(value.text, /display=Fixture\+name/);
  assert.deepEqual(
    decisions.filter(({ method }) => method === "POST"),
    Array.from({ length: 2 }, () => ({
      url: "http://fixture.example/commit",
      method: "POST",
      body: "display=Fixture+name",
    })),
  );
  const nextTurn = f.ctx(owner);
  await assert.rejects(
    on(nextTurn, first, { action: "click", ref: ref("Cross-site link") }),
    /DESKTOP_BROWSER_STALE/,
  );
  value = await on(nextTurn, first, { action: "observe" });
  value = await on(nextTurn, first, {
    action: "click",
    ref: ref("Cross-site link"),
  });
  assert.match(value.text, /Cross-site document/);
  assert.equal(value.url, "http://next.example/");
  assert.match(
    (
      await on(nextTurn, first, {
        action: "navigate",
        url: "http://fixture.example/cookie",
      })
    ).text,
    /fixture=current/,
  );
  assert.match(
    (
      await on(nextTurn, second, {
        action: "navigate",
        url: "http://fixture.example/cookie",
      })
    ).text,
    /Independent cookie jar/,
  );
  assert.equal(
    requests.some(([host, url]) => host === "next.example" && url === "/"),
    true,
  );
  assert.deepEqual(await on(nextTurn, first, { action: "revoke" }), {
    revoked: true,
  });
  await assert.rejects(
    on(nextTurn, first, { action: "observe" }),
    /DESKTOP_BROWSER_UNAVAILABLE/,
  );
  assert.match(
    (await on(nextTurn, second, { action: "observe" })).text,
    /Independent cookie jar/,
  );
});
