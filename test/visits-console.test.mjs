import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { fixture } from "./helpers.mjs";
import { createServer } from "../src/server.mjs";

function setup() {
  const views = [],
    listeners = {};
  const api = () => {
    throw Error("WRAPPER_MUST_REUSE_SHARED_READ_CHAIN");
  };
  const createSocialView = (options) => {
    const view = {
      options,
      closed: false,
      render() {
        options.root.textContent = `${options.agentId}的合成私人访问记录`;
      },
      close() {
        view.closed = true;
        options.root.textContent = "";
      },
    };
    views.push(view);
    return view;
  };
  const sandbox = vm.createContext({
    roleId: "agent-a",
    tab: "visits",
    api,
    document: {
      hidden: false,
      addEventListener: (name, listener) => {
        listeners[name] = listener;
      },
    },
    addEventListener: (name, listener) => {
      listeners[name] = listener;
    },
  });
  vm.runInContext(
    fs
      .readFileSync(new URL("../public/visits-ui.js", import.meta.url), "utf8")
      .replace('import("./home-space/social.mjs")', "sharedModulePromise"),
    sandbox,
  );
  sandbox.sharedModule = { createSocialView };
  vm.runInContext(
    "var sharedModulePromise = Promise.resolve(sharedModule)",
    sandbox,
  );
  const content = () => {
    const root = { textContent: "" };
    return { root, innerHTML: "", querySelector: () => root };
  };
  const render = async (node) => {
    sandbox.content = node;
    await vm.runInContext("renderVisits(content)", sandbox);
  };
  sandbox.action = (fn) => fn();
  sandbox.$ = () => sandbox.content;
  return { sandbox, views, listeners, content, render, api };
}

test("console visits use the shared participant-scoped letter reader and immediately clear old role text", async () => {
  const f = setup(),
    first = f.content();
  await f.render(first);
  const old = f.views[0];
  assert.equal(old.options.agentId, "agent-a");
  assert.equal(old.options.presentation, "letters");
  assert.equal(old.options.roomOwnerAgentId, undefined);
  assert.equal(old.options.api, f.api);
  assert.equal(old.options.isActive(), true);
  assert.match(first.root.textContent, /agent-a/);
  const pending = Promise.withResolvers();
  f.sandbox.loadingModule = pending.promise;
  f.sandbox.content = f.content();
  vm.runInContext(
    'roleId = "agent-b"; sharedModulePromise = loadingModule; var secondRender = renderVisits(content)',
    f.sandbox,
  );
  assert.equal(old.closed, true);
  assert.equal(first.root.textContent, "");
  assert.equal(old.options.isActive(), false);
  pending.resolve(f.sandbox.sharedModule);
  await vm.runInContext("secondRender", f.sandbox);
  assert.equal(f.views[1].options.agentId, "agent-b");
  vm.runInContext('tab = "diary"; closeVisits()', f.sandbox);
  assert.equal(f.views[1].closed, true);
  assert.equal(f.sandbox.content.root.textContent, "");
});

test("a late module load cannot mount a former role and hidden pages close the active reader", async () => {
  const f = setup(),
    pending = Promise.withResolvers();
  f.sandbox.loadingModule = pending.promise;
  f.sandbox.first = f.content();
  f.sandbox.second = f.content();
  vm.runInContext(
    'sharedModulePromise = loadingModule; var firstRender = renderVisits(first); roleId = "agent-b"; var secondRender = renderVisits(second)',
    f.sandbox,
  );
  pending.resolve(f.sandbox.sharedModule);
  await vm.runInContext("Promise.all([firstRender, secondRender])", f.sandbox);
  assert.equal(f.views.length, 1);
  assert.equal(f.views[0].options.agentId, "agent-b");
  assert.doesNotMatch(f.sandbox.first.root.textContent, /私人/);
  f.sandbox.document.hidden = true;
  f.listeners.visibilitychange();
  assert.equal(f.views[0].closed, true);
  assert.equal(f.sandbox.second.root.textContent, "");
});

test("record links retain the memory route and route legacy diary filters to the diary menu", () => {
  const source = fs.readFileSync(
    new URL("../public/app.js", import.meta.url),
    "utf8",
  );
  const prefix = source.slice(0, source.indexOf("const titles ="));
  for (const [search, expected] of [
    ["?view=memory", "memory"],
    ["?view=diary", "diary"],
    ["?view=memory&type=diary", "diary"],
    ["?view=visits", "visits"],
  ]) {
    const sandbox = vm.createContext({
      document: {},
      sessionStorage: { getItem: () => "" },
      location: { search },
      URLSearchParams,
    });
    vm.runInContext(prefix + "\nvar initialTab = tab;", sandbox);
    assert.equal(sandbox.initialTab, expected);
  }
});

test("a failed module load does not prevent reopening visits after recovery", async () => {
  const f = setup();
  f.sandbox.rejectedModule = Promise.reject(Error("SYNTHETIC_LOAD_FAILURE"));
  vm.runInContext("sharedModulePromise = rejectedModule", f.sandbox);
  const failed = f.content();
  await f.render(failed);
  assert.match(failed.root.textContent, /暂时无法读取/);
  vm.runInContext(
    "sharedModulePromise = Promise.resolve(sharedModule)",
    f.sandbox,
  );
  await f.render(f.content());
  assert.equal(f.views.length, 1);
});

test("the real console serves its visits entry script without a route stub", async (t) => {
  const f = fixture(t),
    app = createServer({ runtime: f.runtime, token: "synthetic-static-token" });
  const port = await app.listen();
  t.after(() => app.close());
  const response = await fetch(`http://127.0.0.1:${port}/visits-ui.js`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /javascript/);
  assert.match(await response.text(), /createSocialView/);
});

test("returning from a hidden page reloads metadata through the shared view", async () => {
  const f = setup();
  await f.render(f.content());
  f.sandbox.document.hidden = true;
  f.listeners.visibilitychange();
  f.sandbox.document.hidden = false;
  await f.listeners.visibilitychange();
  assert.equal(f.views.length, 2);
  assert.equal(f.views[0].closed, true);
  assert.equal(f.views[1].options.agentId, "agent-a");
});
