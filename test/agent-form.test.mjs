import test from "node:test";
import { defaultAgentCapabilities } from "../src/core/default-config.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { TOOL_NAMES } from "../src/tools/index.mjs";
import { FILE_TOOL_NAMES } from "../src/tools/file-tools.mjs";
import { appDefinitions } from "../src/apps/tools.mjs";

const agentForm = vm.runInNewContext(
  fs.readFileSync(new URL("../public/agent-form.js", import.meta.url), "utf8") +
    "\n;agentForm",
);

test("every tool belongs to exactly one agent editor group", () => {
  for (const name of TOOL_NAMES) {
    const owners = agentForm.groups.filter((g) => Object.hasOwn(g.tools, name));
    assert.equal(owners.length, 1, `${name} is in ${owners.length} groups`);
  }
  const listed = [...agentForm.groups].flatMap((g) => Object.keys(g.tools));
  assert.deepEqual(
    listed.filter((name) => !TOOL_NAMES.includes(name)),
    [],
    "groups list tools that no longer exist",
  );
  for (const g of agentForm.groups)
    for (const [name, label] of Object.entries(g.tools))
      assert.ok(label && label !== name, `${name} needs a Chinese label`);
  assert.equal(agentForm.groupOf("not_a_tool"), "other");
});

test("managed groups match the tools their pages rewrite", () => {
  const managed = (policy) =>
    Object.keys(
      agentForm.groups.find((g) => g.managedBy?.policy === policy).tools,
    ).sort();
  assert.deepEqual(managed("files"), [...FILE_TOOL_NAMES].sort());
  assert.deepEqual(managed("apps"), Object.keys(appDefinitions).sort());
});

// The editor itself: app.js supplies the shared parts (ids, range, select…),
// agent-form.js the form. formOf() stands in for the browser: it reads the
// built markup the way a form submission would.
function editor(config, toolNames = TOOL_NAMES) {
  const element = {
    showModal() {},
    addEventListener() {},
    querySelectorAll: () => [],
    classList: { add() {}, remove() {}, toggle() {} },
    dataset: {},
    style: {},
  };
  const sandbox = vm.createContext({
    document: {
      querySelector: () => element,
      querySelectorAll: () => [],
      addEventListener() {},
      body: { classList: { remove() {}, toggle() {} } },
    },
    sessionStorage: { getItem: () => "" },
    localStorage: { getItem: () => null, setItem() {} },
    setInterval() {},
    setTimeout() {},
    clearTimeout() {},
    fetch: () => new Promise(() => {}),
    URLSearchParams,
    structuredClone,
  });
  for (const file of ["app.js", "agent-form.js"])
    vm.runInContext(
      fs.readFileSync(new URL(`../public/${file}`, import.meta.url), "utf8"),
      sandbox,
    );
  sandbox.fixture = {
    config,
    tools: toolNames,
    defaults: defaultAgentCapabilities(),
  };
  vm.runInContext(
    "config = fixture.config; tools = fixture.tools; agentDefaults = fixture.defaults; status = { mode: 'isolated' };",
    sandbox,
  );
  return (code) => vm.runInContext(code, sandbox);
}

test("the add-role form uses server capability defaults and preserves them on save", async () => {
  const run = editor(await sampleConfig());
  run("agentForm.bind = () => {}; openEditor('agents');");
  const row = run("editing.row");
  assert.deepEqual(Array.from(row.tools), TOOL_NAMES);
  const html = run(
    "agentForm.build(editing.row, input('id', '稳定 ID', '', 'required'))",
  );
  const parsed = run("agentForm.parse.bind(agentForm)")(
    formOf(html, { id: "agent-c", name: "测试三" }),
    row,
  ).row;
  for (const key of Object.keys(defaultAgentCapabilities()))
    assert.deepEqual(
      JSON.parse(JSON.stringify(parsed[key])),
      defaultAgentCapabilities()[key],
      key,
    );
});

const unescape = (s) =>
  s.replace(
    /&(amp|lt|gt|quot|#39);/g,
    (_, e) => ({ amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'" })[e],
  );
const attrs = (tag) =>
  Object.fromEntries(
    [...tag.matchAll(/([\w:-]+)(?:="([^"]*)")?/g)].map(([, k, v]) => [
      k,
      v === undefined ? "" : unescape(v),
    ]),
  );
/** The FormData a browser would submit for this markup; `set` overrides. */
function formOf(html, set = {}) {
  const f = new FormData();
  for (const [, tag] of html.matchAll(/<input\b([^>]*)>/g)) {
    const a = attrs(tag);
    if (!a.name || "disabled" in a) continue;
    if (a.type === "checkbox") {
      if ("checked" in a) f.append(a.name, "on");
    } else f.append(a.name, a.value ?? "");
  }
  for (const [, tag, body] of html.matchAll(
    /<select\b([^>]*)>([\s\S]*?)<\/select>/g,
  )) {
    const options = [...body.matchAll(/<option\b([^>]*)>/g)].map(([, o]) =>
      attrs(o),
    );
    f.append(
      attrs(tag).name,
      (options.find((o) => "selected" in o) || options[0]).value,
    );
  }
  for (const [, tag, body] of html.matchAll(
    /<textarea\b([^>]*)>([\s\S]*?)<\/textarea>/g,
  ))
    f.append(attrs(tag).name, unescape(body));
  for (const [k, v] of Object.entries(set))
    if (v === undefined) f.delete(k);
    else f.set(k, v);
  return f;
}

async function sampleConfig() {
  const { validateConfig } = await import("../src/core/config.mjs");
  const { defaultConfig } = await import("../src/core/default-config.mjs");
  const c = defaultConfig();
  c.backends[0].toolServers = [
    { id: "asr", command: "asr-mcp", allowedTools: ["transcribe"] },
  ];
  Object.assign(c.agents[0], {
    name: "小满",
    model: "deepseek-chat",
    effort: "max",
    aliases: ["满满", "小满同学"],
    ownerIds: ["30000009"],
    allow: {
      groups: ["20000001", "20000002", "20000002"],
      users: ["30000001", "30000002"],
    },
    wake: { participation: 0.025, cooldownMs: 2500, questions: true },
    voice: {
      asr: {
        enabled: true,
        serverId: "asr",
        tool: "transcribe",
        arguments: { language: "zh" },
      },
    },
    silence: [{ start: "23:00", end: "07:00", days: [0, 6], timezone: "UTC" }],
  });
  c.agents[1].effort = "high";
  return validateConfig(c);
}
// What the editor saves for a row: parse() always drops these two.
const saved = (row) => {
  const { enabled, toolServers, ...rest } = row;
  (void enabled, void toolServers);
  return JSON.parse(JSON.stringify(rest));
};

test("an untouched role editor saves the role exactly as stored", async () => {
  const config = await sampleConfig(),
    run = editor(config);
  for (const [i, shown] of [
    // The slider snaps 0.025 to its 0.01 step; bind() records that position.
    [0, "0.03"],
    [1, String(config.agents[1].wake.participation)],
  ]) {
    const html = run(
      `agentForm.build(config.agents[${i}], input("id", "稳定 ID", config.agents[${i}].id, "readonly"))`,
    );
    const f = formOf(html, { participation: shown, participationShown: shown });
    const { row, githubCredential } = run("agentForm.parse.bind(agentForm)")(
      f,
      structuredClone(config.agents[i]),
    );
    assert.deepEqual(JSON.parse(JSON.stringify(row)), saved(config.agents[i]));
    assert.equal(githubCredential, undefined);
  }
});

test("built-in framework readers are shown as capabilities without misleading switches", async () => {
  const run = editor(await sampleConfig());
  const html = run("agentForm.toolGroupsMarkup(config.agents[0])");
  assert.match(html, /内建只读能力/);
  for (const name of ["framework_read", "deployment_info", "diagnostics_read"])
    assert.ok(!html.includes(`name="tool:${name}"`));
});

test("role editor fields keep the saved list and value shapes", async () => {
  const config = await sampleConfig(),
    run = editor(config),
    a = config.agents[0],
    html = run(`agentForm.build(config.agents[0], "")`),
    parse = (set) =>
      JSON.parse(
        JSON.stringify(
          run("agentForm.parse.bind(agentForm)")(
            formOf(html, set),
            structuredClone(a),
          ).row,
        ),
      );
  // Numbers are chips over the same comma list; offers come from fillIds().
  assert.match(
    html,
    /data-ids="group"[^]*name="groups" value="20000001,20000002"/,
  );
  assert.match(
    html,
    /data-ids="person"[^]*name="users" value="30000001,30000002"/,
  );
  assert.match(html, /data-ids="person"[^]*name="ownerIds" value="30000009"/);
  assert.doesNotMatch(html, /逗号分隔|data-conversations/);
  // A list left as shown keeps its repeat; an edited one is what was sent.
  assert.deepEqual(parse({}).allow.groups, [
    "20000001",
    "20000002",
    "20000002",
  ]);
  assert.deepEqual(parse({ groups: "20000001,20000002,20000003" }).allow, {
    groups: ["20000001", "20000002", "20000003"],
    users: ["30000001", "30000002"],
  });
  assert.deepEqual(
    parse({ users: "", ownerIds: "30000009,30000008" }).allow.users,
    [],
  );
  assert.deepEqual(parse({ ownerIds: "30000009,30000008" }).ownerIds, [
    "30000009",
    "30000008",
  ]);
  // Aliases are chips too and send the comma list the text field sent.
  assert.match(html, /name="aliases" value="满满, 小满同学"/);
  assert.deepEqual(parse({}).aliases, ["满满", "小满同学"]);
  assert.deepEqual(parse({ aliases: "小满同学, 阿满" }).aliases, [
    "小满同学",
    "阿满",
  ]);
  // Participation is a percentage slider over the stored 0–1 value.
  assert.match(
    html,
    /<input type="range" data-range="participation" min="0" max="1" step="0.01" value="0.025" data-unit="%"><input type="hidden" name="participation" value="0.025"><output>3%<\/output>/,
  );
  assert.equal(
    parse({ participation: "0.03", participationShown: "0.03" }).wake
      .participation,
    0.025,
  );
  assert.equal(
    parse({ participation: "0.1", participationShown: "0.03" }).wake
      .participation,
    0.1,
  );
  assert.equal(parse({ participation: "0.25" }).wake.participation, 0.25);
  // Effort is a dropdown that keeps a saved value it does not list.
  assert.match(
    html,
    /<select name="effort"><option value="" >继承后端（高（high））<\/option>/,
  );
  assert.match(html, /<option value="max" selected>max（当前值）<\/option>/);
  assert.equal(parse({}).effort, "max");
  assert.equal(parse({ effort: "" }).effort, "");
  assert.equal(parse({ effort: "low" }).effort, "low");
  // Model stays free text with offers and the inherited default as hint.
  assert.match(
    html,
    /name="model" value="deepseek-chat" list="agent-model-list"/,
  );
  assert.equal(parse({ model: "" }).model, "");
});

test("effort levels follow the backend and a read model catalog", async () => {
  const config = await sampleConfig(),
    run = editor(config),
    levels = (backend, value, list) =>
      Array.from(
        run("agentForm.effortOptions.bind(agentForm)")(backend, value, list),
        ([v]) => v,
      );
  assert.deepEqual(levels({ type: "dsh", effort: "high" }, ""), [
    "",
    "low",
    "medium",
    "high",
  ]);
  assert.deepEqual(levels({ type: "codex" }, "high"), [
    "",
    "minimal",
    "low",
    "medium",
    "high",
    "xhigh",
  ]);
  assert.deepEqual(levels({ type: "openai" }, "max"), [
    "",
    "minimal",
    "low",
    "medium",
    "high",
    "max",
  ]);
  assert.deepEqual(levels({ type: "dsh" }, "", ["high", "max"]), [
    "",
    "high",
    "max",
  ]);
  const models = (catalog, provider) =>
    JSON.parse(
      JSON.stringify(
        run("agentForm.catalogModels.bind(agentForm)")(catalog, provider),
      ),
    );
  // DSH: provider groups with per-model reasoning metadata.
  assert.deepEqual(
    models(
      {
        groups: [
          {
            id: "deepseek",
            name: "DeepSeek",
            models: [
              {
                id: "deepseek-chat",
                name: "DeepSeek Chat",
                reasoning: { efforts: [{ id: "high", name: "High" }] },
              },
            ],
          },
          { id: "other", name: "Other", models: [{ id: "x", name: "X" }] },
        ],
      },
      "deepseek",
    ),
    [{ id: "deepseek-chat", name: "DeepSeek Chat", efforts: ["high"] }],
  );
  // Codex: model/list rows with supported efforts.
  assert.deepEqual(
    models([
      {
        id: "m1",
        model: "gpt-5-codex",
        displayName: "GPT-5 Codex",
        supportedReasoningEfforts: [
          { reasoningEffort: "low", description: "" },
          { reasoningEffort: "high", description: "" },
        ],
      },
    ]),
    [{ id: "gpt-5-codex", name: "GPT-5 Codex", efforts: ["low", "high"] }],
  );
  // OpenAI-compatible: /models ids only.
  assert.deepEqual(models([{ id: "qwen-plus", object: "model" }]), [
    { id: "qwen-plus", name: "", efforts: [] },
  ]);
});

test("a new role starts with empty number lists that still take typed numbers", async () => {
  const config = await sampleConfig(),
    run = editor(config);
  run(`fixture.row = {
    id: "", paused: true, enabled: false,
    wake: { mentions: true, names: true, private: true, participation: 0.05, peers: true, cooldownMs: 1500 },
    allow: { groups: [], users: [] }, tools: ["qq_send"], silence: [], toolServers: [], maxSendsPerTurn: 3,
  }`);
  const html = run(
    `agentForm.build(fixture.row, input("id", "稳定 ID", "", "required"))`,
  );
  assert.equal(
    (html.match(/<span class="ids-empty">还没有<\/span>/g) || []).length,
    4,
  );
  assert.match(
    html,
    /data-models disabled title="保存角色后可读取后端的模型目录"/,
  );
  const { row } = run("agentForm.parse.bind(agentForm)")(
    formOf(html, {
      id: "agent-c",
      name: "测试三",
      groups: "20000005",
      ownerIds: "30000007",
      aliases: "三三",
      participationShown: "0.05",
    }),
    run("fixture.row"),
  );
  assert.deepEqual(
    JSON.parse(
      JSON.stringify({
        allow: row.allow,
        ownerIds: row.ownerIds,
        aliases: row.aliases,
        effort: row.effort,
        model: row.model,
        participation: row.wake.participation,
      }),
    ),
    {
      allow: { groups: ["20000005"], users: [] },
      ownerIds: ["30000007"],
      aliases: ["三三"],
      effort: "",
      model: "",
      participation: 0.05,
    },
  );
});
