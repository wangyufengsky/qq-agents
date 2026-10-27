import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { config, fixture } from "./helpers.mjs";
import { createServer } from "../src/server.mjs";

function element(name, label) {
  const classes = new Set(),
    attributes = new Map();
  return {
    name,
    tagName: "INPUT",
    classes,
    attributes,
    classList: {
      add: (c) => classes.add(c),
      remove: (c) => classes.delete(c),
    },
    setAttribute: (k, v) => attributes.set(k, v),
    removeAttribute: (k) => attributes.delete(k),
    closest: () => ({
      childNodes: [
        { nodeType: 3, textContent: label },
        { nodeType: 1, textContent: "ignored" },
      ],
    }),
    scrollIntoView() {
      this.scrolled = true;
    },
    focus() {
      this.focused = true;
    },
  };
}

async function setup(t) {
  const f = fixture(t, { cfg: config(1) });
  const app = createServer({
    runtime: f.runtime,
    token: "test-admin",
    allowLive: true,
  });
  const port = await app.listen();
  t.after(() => app.close());
  const inputs = {
    groups: element("groups", "群白名单（逗号分隔）"),
    httpUrl: element("httpUrl", "OneBot HTTP 地址"),
  };
  const nodes = new Map();
  const node = (s) => {
    if (!nodes.has(s))
      nodes.set(s, {
        addEventListener() {},
        querySelectorAll: () => [],
        classList: { add() {}, remove() {} },
        dataset: {},
        insertAdjacentHTML(_, html) {
          this.innerHTML += html;
        },
      });
    return nodes.get(s);
  };
  Object.assign(node("#editor"), {
    open: true,
    close() {
      this.open = false;
    },
  });
  node("#edit-form").elements = { namedItem: (n) => inputs[n] ?? null };
  const document = {
    querySelector: node,
    querySelectorAll: () => [],
    body: { classList: { remove() {} } },
    activeElement: null,
  };
  let tick;
  const sandbox = vm.createContext({
    document,
    sessionStorage: { getItem: () => "test-admin" },
    setInterval: (fn) => (tick = fn),
    setTimeout() {},
    clearTimeout() {},
    structuredClone,
    FormData: class {
      constructor(fields) {
        return fields;
      }
    },
    fetch: (url, options) =>
      fetch(`http://127.0.0.1:${port}` + url, {
        ...options,
        headers: { ...options?.headers, "x-admin-token": "test-admin" },
      }),
  });
  // Same load order as public/index.html: the overview renders the checklist.
  for (const file of ["onboarding-ui.js", "app.js"])
    vm.runInContext(
      fs.readFileSync(new URL("../public/" + file, import.meta.url), "utf8"),
      sandbox,
    );
  await vm.runInContext("load()", sandbox);
  vm.runInContext(
    "var submitted; action = (fn) => (submitted = fn());",
    sandbox,
  );
  return { ...f, node, inputs, document, sandbox, tick: () => tick() };
}

test("a rejected config names and highlights the editor field without echoing the value", async (t) => {
  const f = await setup(t);
  const bad = structuredClone(f.runtime.config);
  bad.agents[0].allow.groups = ["abc-typed"];
  f.sandbox.bad = bad;
  vm.runInContext(
    'editing = { type: "agents", id: "agent-0", row: config.agents[0] };',
    f.sandbox,
  );
  await assert.rejects(
    vm.runInContext(
      'api("/api/config", { config: bad, revision }, "PUT")',
      f.sandbox,
    ),
    (e) => {
      assert.match(e.message, /群白名单（逗号分隔）/);
      assert.match(e.message, /已在表单中标出/);
      assert.doesNotMatch(e.message, /abc-typed|INVALID_REQUEST/);
      return true;
    },
  );
  const groups = f.inputs.groups;
  assert(groups.classes.has("invalid"));
  assert.equal(groups.attributes.get("aria-invalid"), "true");
  assert(groups.scrolled && groups.focused);
  // A failure outside the open row is listed by path instead of guessed.
  vm.runInContext(
    'editing = { type: "connections", id: "qq-0", row: config.connections[0] };',
    f.sandbox,
  );
  await assert.rejects(
    vm.runInContext(
      'api("/api/config", { config: bad, revision }, "PUT")',
      f.sandbox,
    ),
    /agents\.0\.allow\.groups\.0/,
  );
});

test("a wrong admin token gets a readable hint", async (t) => {
  const f = await setup(t);
  f.sandbox.fetch = () =>
    Promise.resolve(
      new Response(JSON.stringify({ error: "UNAUTHORIZED", requestId: "x" }), {
        status: 401,
      }),
    );
  await assert.rejects(
    vm.runInContext('api("/api/config")', f.sandbox),
    (e) => {
      assert.match(e.message, /令牌不正确.*admin-token/);
      assert.doesNotMatch(e.message, /UNAUTHORIZED|关联 ID/);
      return true;
    },
  );
});

test("save notice names connections that need a reconnect only when they do", async (t) => {
  const f = await setup(t);
  vm.runInContext("render = () => {};", f.sandbox);
  const c = f.runtime.config.connections[0];
  const fields = new Map(
    Object.entries({
      id: c.id,
      label: c.label,
      accountId: c.accountId,
      deployment: "external",
      httpUrl: "http://127.0.0.1:10",
      wsUrl: c.wsUrl,
      enabled: "on",
      autoReconnect: "on",
      maxAttempts: "8",
    }),
  );
  const submit = async () => {
    vm.runInContext(
      'editing = { type: "connections", id: "qq-0", row: config.connections[0] };',
      f.sandbox,
    );
    f.node("#editor").open = true;
    f.node("#edit-form").onsubmit({ preventDefault() {}, target: fields });
    await vm.runInContext("submitted", f.sandbox);
    return f.node("#notice").textContent;
  };
  assert.match(await submit(), /“Fixture 0” 的连接设置已变化.*手动重新连接/);
  fields.delete("enabled");
  assert.match(await submit(), /未启用，无需重新连接/);
  fields.set("label", "Renamed");
  assert.doesNotMatch(await submit(), /重新连接/);
});

test("auto-refresh keeps the error filter and never re-renders under a focused input", async (t) => {
  const f = await setup(t);
  vm.runInContext('tab = "overview"; render();', f.sandbox);
  const filter = f.node("#error-filter");
  filter.oninput({ target: { value: "http" } });
  vm.runInContext("render();", f.sandbox);
  assert.match(f.node("#content").innerHTML, /id="error-filter" value="http"/);
  let renders = 0;
  vm.runInContext("render = () => renderCount();", f.sandbox);
  f.sandbox.renderCount = () => renders++;
  f.node("#editor").open = false;
  f.node("#content").contains = (el) => el === filter;
  filter.matches = () => true;
  f.document.activeElement = filter;
  f.node("#recent-errors").innerHTML = "stale";
  f.tick();
  await vm.runInContext("submitted", f.sandbox);
  assert.equal(renders, 0);
  assert.notEqual(f.node("#recent-errors").innerHTML, "stale");
  f.document.activeElement = null;
  f.tick();
  await vm.runInContext("submitted", f.sandbox);
  assert.equal(renders, 1);
});
