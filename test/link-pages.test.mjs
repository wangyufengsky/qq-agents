import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { randomBytes } from "node:crypto";
import { config, fixture } from "./helpers.mjs";
import { validateConfig } from "../src/core/config.mjs";
import { createServer } from "../src/server.mjs";

// The connection page's QQ account and AI backend forms after the redesign:
// the same field names, so what a browser submits from a form nobody touched
// must save every stored field back exactly as it was.

// Reads a rendered form the way a browser submits it: inputs by value
// (checkboxes only when checked), the selected option, textarea text.
function formValues(html) {
  const text = (s) =>
    s.replace(
      /&(amp|lt|gt|quot|#39);/g,
      (_, e) =>
        ({ amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'" })[e] ?? "",
    );
  const attr = (tag, name) => {
    const m = tag.match(new RegExp(`\\s${name}="([^"]*)"`));
    return m ? text(m[1]) : null;
  };
  const flag = (tag, name) => new RegExp(`\\s${name}(\\s|>)`).test(tag);
  const values = new Map();
  for (const [tag] of html.matchAll(/<input\b[^>]*>/g)) {
    const name = attr(tag, "name");
    if (!name) continue;
    if (attr(tag, "type") !== "checkbox")
      values.set(name, attr(tag, "value") ?? "");
    else if (flag(tag, "checked")) values.set(name, "on");
  }
  for (const [, name, body] of html.matchAll(
    /<select\b[^>]*name="([^"]*)"[^>]*>([^]*?)<\/select>/g,
  )) {
    const options = [...body.matchAll(/<option\b[^>]*>/g)].map((m) => m[0]);
    values.set(
      name,
      attr(options.find((o) => flag(o, "selected")) ?? options[0], "value"),
    );
  }
  for (const [, name, body] of html.matchAll(
    /<textarea\b[^>]*name="([^"]*)"[^>]*>([^]*?)<\/textarea>/g,
  ))
    values.set(name, text(body));
  return values;
}

// Every kind of stored row the forms can meet: tokenless and token-guarded
// connections, Docker and native deployments with their extra fields, and
// one backend of each adapter with the fields only it uses.
function linkConfig() {
  const base = config(1);
  return validateConfig({
    ...base,
    connections: [
      ...base.connections,
      {
        id: "qq-docker",
        label: "Docker <A> & 小号",
        accountId: "10001",
        messageIdNamespace: "napcat-b",
        gateway: "onebot",
        deployment: "docker",
        container: "napcat-qq-a",
        httpUrl: "http://napcat:3000",
        wsUrl: "ws://napcat:3001",
        webUrl: "http://127.0.0.1:6099/webui",
        tokenEnv: "QQ_UNIFIED_ONEBOT_B",
        allowPrivateNetwork: true,
        enabled: false,
        recovery: {
          autoReconnect: false,
          maxAttempts: 5,
          initialDelayMs: 3000,
          maxDelayMs: 60000,
          heartbeatTimeoutMs: 0,
        },
      },
      {
        id: "qq-native",
        label: "原生",
        accountId: "10002",
        deployment: "native",
        httpUrl: "http://127.0.0.1:23020",
        wsUrl: "ws://127.0.0.1:23021",
        tokenEnv: "QQ_UNIFIED_ONEBOT_C",
        enabled: true,
        process: {
          command: "/opt/napcat/run.sh",
          args: ["--qq", "10002"],
          env: { NAPCAT_TOKEN: "QQ_UNIFIED_ONEBOT_C" },
        },
      },
    ],
    backends: [
      ...base.backends,
      {
        id: "dsh-fixed",
        type: "dsh",
        label: "DSH <桌面>",
        provider: "deepseek-official",
        model: "deepseek-chat",
        effort: "max",
        preset: "qq-unified-2",
        baseUrl: "http://127.0.0.1:3213",
        recovery: { autoReconnect: true },
      },
      {
        id: "dsh-relay",
        type: "dsh",
        label: "DSH relay",
        recovery: { autoReconnect: false, dshInstance: "relay:web" },
      },
      {
        id: "codex-x",
        type: "codex",
        label: "Codex",
        model: "gpt-5-codex",
        effort: "xhigh",
        command: "/usr/local/bin/codex",
        env: { OPENAI_API_KEY: "QQ_UNIFIED_CODEX_KEY" },
        toolServers: [
          {
            id: "search",
            transport: "http",
            url: "https://mcp.example.test/mcp",
            headers: { Authorization: "QQ_UNIFIED_MCP_TOKEN" },
            allowedTools: ["search"],
          },
        ],
      },
      {
        id: "api",
        type: "openai",
        label: "API",
        baseUrl: "https://api.example.test/v1",
        apiKeyEnv: "QQ_TEST_OPENAI_KEY",
        model: "m",
        effort: "",
        contextWindow: 64000,
        maxToolRounds: 8,
        requestTimeoutMs: 90000,
        vision: true,
        sendEffort: false,
      },
    ],
  });
}

// Values made inside the console's sandbox, as plain data.
const plain = (x) => JSON.parse(JSON.stringify(x));
async function consoleFor(t, cfg = linkConfig()) {
  const f = fixture(t, { cfg }),
    token = randomBytes(32).toString("hex");
  const server = createServer({ runtime: f.runtime, token, allowLive: true });
  const port = await server.listen();
  t.after(() => server.close());
  const nodes = new Map();
  const node = (s) => {
    if (!nodes.has(s))
      nodes.set(s, {
        close() {},
        showModal() {},
        addEventListener() {},
        querySelectorAll: () => [],
        dataset: {},
      });
    return nodes.get(s);
  };
  const sandbox = vm.createContext({
    document: {
      querySelector: node,
      querySelectorAll: () => [],
      body: { classList: { remove() {}, toggle() {} } },
    },
    sessionStorage: { getItem: () => "" },
    setInterval() {},
    setTimeout() {},
    clearTimeout() {},
    structuredClone,
    URLSearchParams,
    FormData: class {
      constructor(fields) {
        return fields;
      }
    },
    fetch: (url, options) =>
      fetch(`http://127.0.0.1:${port}${url}`, {
        ...options,
        headers: { ...options?.headers, "x-admin-token": token },
      }),
  });
  vm.runInContext(
    fs.readFileSync(new URL("../public/app.js", import.meta.url), "utf8"),
    sandbox,
  );
  vm.runInContext("render = () => {};", sandbox);
  await vm.runInContext("load()", sandbox);
  const run = (code) => vm.runInContext(code, sandbox);
  const open = (type, id) => {
    run(`openEditor(${JSON.stringify(type)}, ${JSON.stringify(id)})`);
    return node("#edit-fields").innerHTML;
  };
  const save = async (values) => {
    run("var submitted; action = (fn) => (submitted = fn());");
    node("#edit-form").onsubmit({ preventDefault() {}, target: values });
    await run("submitted");
    assert.match(node("#notice").textContent, /已保存/);
  };
  return { ...f, node, run, open, save };
}

test("untouched QQ account and backend forms save every stored field back unchanged", async (t) => {
  const c = await consoleFor(t),
    before = structuredClone(c.runtime.config);
  for (const type of ["connections", "backends"])
    for (const { id } of before[type]) {
      await c.save(formValues(c.open(type, id)));
      assert.deepEqual(
        c.runtime.config[type].find((x) => x.id === id),
        before[type].find((x) => x.id === id),
        `${type} ${id}`,
      );
    }
  assert.deepEqual(c.runtime.config, before);
  // A connection without a token stays without one. The old form filled in
  // QQ_UNIFIED_ONEBOT_A here, which then had to exist to connect.
  assert.equal(
    Object.hasOwn(c.runtime.config.connections[0], "tokenEnv"),
    false,
  );
  // A blank effort stays blank. The old form turned it into "high".
  assert.equal(c.runtime.config.backends.at(-1).effort, "");
});

test("new QQ account and backend forms start from the same defaults as before", async (t) => {
  const c = await consoleFor(t, config(1));
  const connection = formValues(c.open("connections", null));
  assert.match(c.node("#edit-fields").innerHTML, /placeholder="例如 qq-a"/);
  connection.set("id", "qq-new");
  connection.set("label", "新号");
  connection.set("accountId", "10009");
  await c.save(connection);
  assert.deepEqual(c.runtime.config.connections.at(-1), {
    id: "qq-new",
    label: "新号",
    accountId: "10009",
    messageIdNamespace: "onebot",
    gateway: "napcat",
    httpUrl: "http://127.0.0.1:23010",
    wsUrl: "ws://127.0.0.1:23011",
    tokenEnv: "QQ_UNIFIED_ONEBOT_A",
    enabled: false,
    recovery: {
      autoReconnect: true,
      maxAttempts: 8,
      initialDelayMs: 2000,
      maxDelayMs: 300000,
    },
    deployment: "external",
  });
  const backend = formValues(c.open("backends", null));
  backend.set("id", "new-dsh");
  backend.set("label", "新后端");
  await c.save(backend);
  const saved = c.runtime.config.backends.at(-1);
  assert.deepEqual(
    {
      type: saved.type,
      provider: saved.provider,
      model: saved.model,
      effort: saved.effort,
      preset: saved.preset,
      command: saved.command,
      toolServers: saved.toolServers,
      recovery: saved.recovery,
      baseUrl: saved.baseUrl,
    },
    {
      type: "dsh",
      provider: "",
      model: "",
      effort: "high",
      preset: "qq-unified",
      command: "codex",
      toolServers: [],
      recovery: { autoReconnect: false },
      baseUrl: undefined,
    },
  );
});

test("the forms give examples, fold the rare fields and show each adapter its own", async (t) => {
  const c = await consoleFor(t);
  const docker = c.open("connections", "qq-docker");
  for (const example of [
    'placeholder="例如 http://127.0.0.1:3000"',
    'placeholder="例如 ws://127.0.0.1:3001"',
    'placeholder="例如 QQ_UNIFIED_ONEBOT_A；不用令牌时留空"',
    'placeholder="例如 http://127.0.0.1:6099/webui"',
    'placeholder="例如 napcat-qq-a"',
  ])
    assert(docker.includes(example), example);
  // Reconnects, the NapCat page and the private-network switch are folded.
  const [, folded] = docker.split('<details class="adv">');
  for (const name of [
    "autoReconnect",
    "maxAttempts",
    "webUrl",
    "allowPrivateNetwork",
  ])
    assert.match(folded, new RegExp(`name="${name}"`), name);
  assert.match(
    docker,
    /<div class="for-type" data-for="docker">.*name="container"/,
  );
  assert.match(
    docker,
    /<div class="for-type" data-for="native">.*name="process"/,
  );
  assert.match(docker, /value="Docker &lt;A&gt; &amp; 小号"/);

  const api = c.open("backends", "api");
  assert.match(api, /<input name="model" value="m" list="backend-models"/);
  assert.match(api, /placeholder="例如 https:\/\/api.deepseek.com\/v1"/);
  assert.match(
    api,
    /<div class="for-type" data-for="openai">.*name="apiKeyEnv"/,
  );
  // A blank effort is offered and kept for an OpenAI-compatible API.
  assert.match(api, /<option value="" selected>留空使用默认<\/option>/);
  const [, rare] = api.split('<details class="adv">');
  for (const name of [
    "contextWindow",
    "vision",
    "sendEffort",
    "preset",
    "command",
    "toolServers",
  ])
    assert.match(rare, new RegExp(`name="${name}"`), name);

  // DSH: no blank (it refuses one with a model), the stored "max" kept.
  const dsh = c.open("backends", "dsh-fixed");
  assert.doesNotMatch(dsh, /<option value="">/);
  assert.match(dsh, /<option value="max" selected>max（当前值）<\/option>/);
  assert.match(dsh, /list="backend-providers"/);
  assert.match(
    dsh,
    /<datalist id="backend-providers"><option value="deepseek-official" label="DeepSeek 官方">/,
  );
  assert.match(
    dsh,
    /<datalist id="backend-presets"><option value="qq-unified"/,
  );
});

test("effort choices follow the adapter and the model catalog read from the backend", async (t) => {
  const c = await consoleFor(t);
  c.run("var choices = (...a) => backendEffortOptions(...a).map(([v]) => v);");
  const choices = (args) => plain(c.run(`choices(${args})`));
  assert.deepEqual(choices('"codex", "", "high"'), [
    "",
    "minimal",
    "low",
    "medium",
    "high",
    "xhigh",
  ]);
  assert.deepEqual(choices('"openai", "m", ""'), [
    "",
    "minimal",
    "low",
    "medium",
    "high",
  ]);
  assert.deepEqual(choices('"dsh", "", "high"'), ["low", "medium", "high"]);
  // A stored blank stays selectable on DSH so an untouched save keeps it.
  assert.deepEqual(choices('"dsh", "", ""'), ["", "low", "medium", "high"]);
  assert.deepEqual(choices('"codex", "", "turbo"').at(-1), "turbo");

  // Each adapter's catalog shape becomes one list of models with efforts.
  const dsh = c.run(`rememberModels("dsh-fixed", {
    groups: [
      { id: "deepseek-official", name: "DeepSeek", models: [
        { id: "deepseek-chat", name: "DeepSeek Chat", reasoning: { efforts: [{ id: "high", name: "高" }, { id: "max", name: "最高" }], defaultEffort: "high" } },
        { id: "deepseek-lite", name: "Lite" },
      ] },
      { id: "acme", name: "Acme <gw>", models: [{ id: "acme-1", name: "Acme 1" }] },
    ],
  })`);
  assert.deepEqual(plain(dsh.models), [
    {
      id: "deepseek-chat",
      name: "DeepSeek Chat",
      provider: "deepseek-official",
      efforts: ["high", "max"],
    },
    {
      id: "deepseek-lite",
      name: "Lite",
      provider: "deepseek-official",
      efforts: [],
    },
    { id: "acme-1", name: "Acme 1", provider: "acme", efforts: [] },
  ]);
  const codex = c.run(`rememberModels("codex-x", [
    { id: "gpt-5-codex", model: "gpt-5-codex", displayName: "GPT-5 Codex", supportedReasoningEfforts: [{ reasoningEffort: "low" }, { reasoningEffort: "high" }] },
  ])`);
  assert.deepEqual(plain(codex.models[0].efforts), ["low", "high"]);
  const openai = c.run(
    'rememberModels("api", { data: [{ id: "m", object: "model" }] })',
  );
  assert.equal(openai.models[0].id, "m");

  // With the catalog read, the model's own efforts replace the common ones,
  // the models and providers are offered, and a picked value saves as is.
  const form = c.open("backends", "dsh-fixed");
  assert.match(
    form,
    /<option value="high" >high · 高<\/option><option value="max" selected>max · 最高<\/option><\/select>/,
  );
  assert.match(
    form,
    /<datalist id="backend-models"><option value="deepseek-chat" label="DeepSeek Chat · deepseek-official">/,
  );
  assert.match(form, /<option value="acme" label="Acme &lt;gw&gt;">/);
  assert.match(form, /已读取 3 个模型/);
  const values = formValues(form);
  values.set("model", "deepseek-lite");
  values.set("effort", "high");
  await c.save(values);
  const saved = c.runtime.config.backends.find((b) => b.id === "dsh-fixed");
  assert.equal(saved.model, "deepseek-lite");
  assert.equal(saved.effort, "high");
  // A blank picked for Codex is saved blank; Codex then runs at "high".
  const blank = formValues(c.open("backends", "codex-x"));
  blank.set("effort", "");
  await c.save(blank);
  assert.equal(
    c.runtime.config.backends.find((b) => b.id === "codex-x").effort,
    "",
  );
});

test("QQ account and backend cards keep one shape with the facts cut, not wrapped", async (t) => {
  const c = await consoleFor(t);
  const rows = (html) => (html.match(/<dt>/g) || []).length;
  for (const id of ["dsh-fixed", "codex-x", "api", "fixture"]) {
    const card = c.run(`backendCard(find("backends", ${JSON.stringify(id)}))`);
    assert.equal(rows(card), 7, id);
    assert.match(
      card,
      /<div class="card-actions link-actions">.*检测连接.*恢复连接.*自动恢复<\/button><\/div><div>.*编辑.*模型目录/,
    );
  }
  const dsh = c.run('backendCard(find("backends", "dsh-fixed"))');
  assert.match(dsh, /<h3 title="DSH &lt;桌面&gt;">DSH &lt;桌面&gt;<\/h3>/);
  assert.match(
    dsh,
    /<dt>模型<\/dt><dd class="mono" title="deepseek-chat · deepseek-official">/,
  );
  assert.match(dsh, /<dt>Preset<\/dt><dd class="mono" title="qq-unified-2">/);
  assert.match(
    dsh,
    /data-do="backend-discover"[^>]*>选择实例<\/button><\/div><\/div>/,
  );
  const api = c.run('backendCard(find("backends", "api"))');
  assert.match(api, /<dt>思考强度<\/dt><dd title="后端默认（未发送）">/);
  assert.match(
    api,
    /<dt>密钥变量<\/dt><dd class="mono" title="QQ_TEST_OPENAI_KEY">/,
  );
  for (const { id } of c.runtime.config.connections) {
    const card = c.run(
      `connectionCard(find("connections", ${JSON.stringify(id)}))`,
    );
    assert.equal(rows(card), 5, id);
    assert.match(card, /<div class="link-notes"><p class="link-note"/);
  }
  c.run(
    'status.connections.find((x) => x.id === "qq-docker").connected = false',
  );
  const docker = c.run('connectionCard(find("connections", "qq-docker"))');
  assert.match(docker, /<span class="pill ">未启用<\/span>/);
  assert.match(docker, /<dt>部署方式<\/dt><dd title="Docker NapCat">/);
  assert.match(docker, /<dt>自动重连<\/dt><dd title="关闭">/);
  assert.match(docker, /启动 QQ 进程/);
});
