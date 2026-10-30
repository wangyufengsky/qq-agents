import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import {
  ReleaseUpdates,
  compareVersions,
  readRelease,
} from "../src/updates/releases.mjs";
import { createServer } from "../src/server.mjs";
import { temp, fixture, context } from "./helpers.mjs";

const release = (extra = {}) => ({
  tag_name: "v0.6.0",
  draft: false,
  prerelease: false,
  published_at: "2026-10-30T00:00:00Z",
  body: "Synthetic notes <script>bad()</script>",
  html_url: "https://untrusted.invalid",
  ...extra,
});
function updates(t, extra = {}) {
  const value = new ReleaseUpdates({
    root: temp(t),
    installed: {
      packageVersion: "0.5.4",
      commit: "a".repeat(40),
      modified: false,
      provenance: "git",
    },
    fetchImpl: async () =>
      Response.json(release(), { headers: { etag: '"fixture"' } }),
    ...extra,
  });
  t.after(() => value.close());
  return value;
}
test("version ordering handles large components and excludes prereleases and unknown installs", () => {
  assert.equal(compareVersions("v0.9.0", "0.10.0"), -1);
  assert.equal(compareVersions("1.0.0", "v1.0.0"), 0);
  assert.equal(compareVersions("10000000000000000000.0.0", "9.0.0"), 1);
  for (const value of ["unknown", "1.2", "01.2.3", "1.2.3-rc.1", "1.2.3+local"])
    assert.equal(compareVersions(value, "1.2.3"), null);
});
test("checking is opt-in, fixed-origin, anonymous and supplies a canonical release link", async (t) => {
  let calls = 0;
  const u = updates(t, {
    fetchImpl: async (url, options) => {
      calls++;
      assert.equal(
        url,
        "https://api.github.com/repos/wangyufengsky/qq-agents/releases/latest",
      );
      assert.equal(options.credentials, "omit");
      assert.equal(options.redirect, "error");
      assert.equal(options.headers.authorization, undefined);
      assert.equal(options.body, undefined);
      return Response.json(release());
    },
  });
  u.start();
  assert.equal(calls, 0);
  assert.equal(u.timer, undefined);
  const s = await u.check();
  assert.equal(s.notify, true);
  assert.equal(s.comparison, "available");
  assert.equal(
    s.latest.url,
    "https://github.com/wangyufengsky/qq-agents/releases/tag/v0.6.0",
  );
  assert.equal(calls, 1);
  await u.check();
  assert.equal(calls, 1);
});
test("preferences survive restart; ignoring is bound to the last inspected release", async (t) => {
  const root = temp(t),
    u = updates(t, { root });
  await u.check();
  assert.throws(
    () => u.configure({ ignoredTag: "v99.0.0" }),
    /UPDATE_RELEASE_CHANGED/,
  );
  u.configure({ enabled: true, ignoredTag: "v0.6.0" });
  assert.equal(u.snapshot().notify, false);
  const next = updates(t, { root });
  assert.equal(next.snapshot().enabled, true);
  assert.equal(next.snapshot().ignoredTag, "v0.6.0");
  assert.equal(next.snapshot().checkedAt, null);
  assert.throws(
    () => u.configure({ endpoint: "https://untrusted.invalid" }),
    /UPDATE_SETTINGS_INVALID/,
  );
  u.configure({ ignoredTag: null, enabled: false });
  assert.equal(u.snapshot().notify, true);
});
test("corrupt preferences disable scheduled checks and can be replaced explicitly", (t) => {
  const root = temp(t);
  fs.writeFileSync(path.join(root, "updates.json"), "invalid");
  const u = updates(t, { root });
  assert.equal(u.snapshot().error, "UPDATE_SETTINGS_INVALID");
  assert.equal(u.snapshot().enabled, false);
  u.configure({ enabled: false });
  assert.equal(u.snapshot().error, null);
});
test("same version and development versions never offer a downgrade", async (t) => {
  for (const [version, expected] of [
    ["0.6.0", "same-version"],
    ["0.7.0", "ahead"],
    ["0.6.0-dev", "unknown"],
  ]) {
    const u = updates(t, {
      installed: { packageVersion: version, modified: true },
    });
    const s = await u.check();
    assert.equal(s.comparison, expected);
    assert.equal(s.notify, false);
    assert.equal(s.installed.modified, true);
  }
});
test("conditional checks reuse notes; network errors keep stale metadata with a failure label", async (t) => {
  let clock = 1000,
    count = 0;
  const u = updates(t, {
    now: () => clock,
    fetchImpl: async (_url, options) => {
      count++;
      if (count === 1)
        return Response.json(release(), { headers: { etag: '"fixture"' } });
      assert.equal(options.headers["if-none-match"], '"fixture"');
      if (count === 2) return new Response(null, { status: 304 });
      throw Error("synthetic private upstream details");
    },
  });
  await u.check();
  clock += 61000;
  assert.equal((await u.check()).checkedAt, clock);
  clock += 61000;
  const failed = await u.check();
  assert.equal(failed.error, "UPDATE_UNAVAILABLE");
  assert.equal(failed.latest.tag, "v0.6.0");
  assert.equal(failed.checkedAt, clock - 61000);
  assert.equal(JSON.stringify(failed).includes("private upstream"), false);
  assert.equal(failed.nextCheckAt, clock + 300000);
});
test("404 and rate limits are distinct from being up to date", async (t) => {
  for (const [status, error] of [
    [404, null],
    [403, "UPDATE_RATE_LIMITED"],
    [429, "UPDATE_RATE_LIMITED"],
    [502, "UPDATE_UNAVAILABLE"],
  ]) {
    const u = updates(t, {
      fetchImpl: async () => new Response("", { status }),
    });
    const s = await u.check();
    assert.equal(s.comparison, "unknown");
    assert.equal(s.error, error);
    assert.equal(s.notify, false);
  }
});
test("invalid or oversized metadata is rejected", async () => {
  for (const extra of [
    { tag_name: "../evil" },
    { tag_name: "v1.0.0-rc.1" },
    { draft: true },
    { prerelease: true },
    { published_at: "no" },
    { body: {} },
  ])
    await assert.rejects(
      readRelease(Response.json(release(extra))),
      /UPDATE_RESPONSE_INVALID/,
    );
  await assert.rejects(
    readRelease(new Response("x".repeat(270000))),
    /UPDATE_RESPONSE_INVALID/,
  );
  await assert.rejects(
    readRelease(new Response("{", { headers: { "content-length": "270000" } })),
    /UPDATE_RESPONSE_INVALID/,
  );
});
test("concurrent checks share one request and shutdown aborts without accepting late results", async (t) => {
  let done,
    signal,
    calls = 0;
  const u = updates(t, {
    fetchImpl: async (_url, options) => {
      calls++;
      signal = options.signal;
      return new Promise((resolve) => {
        done = resolve;
      });
    },
  });
  const first = u.check(),
    second = u.check();
  assert.equal(calls, 1);
  assert.equal(u.snapshot().checking, true);
  u.close();
  assert.equal(signal.aborted, true);
  done(Response.json(release()));
  await Promise.all([first, second]);
  assert.equal(u.snapshot().latest, null);
});
test("update routes require administrator credentials; model capabilities cannot check or change settings", async (t) => {
  const f = fixture(t),
    token = "synthetic-admin";
  f.runtime.updates = updates(t);
  const app = createServer({ runtime: f.runtime, token });
  const port = await app.listen();
  t.after(() => app.close());
  const capability = context(f.runtime).token;
  for (const [route, method, body] of [
    ["", "GET"],
    ["/check", "POST", {}],
    ["/settings", "PUT", { enabled: true }],
  ]) {
    const request = (headers) =>
      fetch(`http://127.0.0.1:${port}/api/updates${route}`, {
        method,
        headers,
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    assert.equal((await request({})).status, 401);
    assert.equal(
      (await request({ "x-agent-capability": capability })).status,
      401,
    );
    assert.equal((await request({ "x-admin-token": token })).status, 200);
  }
});
test("release notes are rendered as escaped plain text", async (t) => {
  const u = updates(t),
    data = await u.check();
  const sandbox = {
    setInterval() {},
    esc: (s) =>
      String(s)
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll('"', "&quot;"),
    tag: () => "",
  };
  vm.createContext(sandbox);
  vm.runInContext(
    fs.readFileSync(
      new URL("../public/updates-ui.js", import.meta.url),
      "utf8",
    ),
    sandbox,
  );
  sandbox.data = data;
  const html = vm.runInContext("updatesMarkup(data)", sandbox);
  assert.equal(html.includes("<script>bad()"), false);
  assert.match(html, /&lt;script>bad/);
});
