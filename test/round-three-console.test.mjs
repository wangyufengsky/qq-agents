import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { config as makeConfig } from "./helpers.mjs";
import { validateConfig } from "../src/core/config.mjs";

test("console saves role and optional conversation budgets and explicit scheduler all-day quiet", async () => {
  const nodes = new Map(),
    cfg = makeConfig(1);
  const $ = (s) => {
    if (!nodes.has(s)) nodes.set(s, {});
    return nodes.get(s);
  };
  let saved;
  const sandbox = vm.createContext({
    $,
    config: cfg,
    revision: "synthetic",
    tab: "schedule",
    status: { mode: "isolated", globalPaused: true },
    esc: (v) => String(v ?? ""),
    tag: () => "",
    // Same markup as the app.js helper: collapsed fields keep their names.
    advanced: (title, html) =>
      `<details class="adv"><summary>${title}</summary><div class="form-grid">${html}</div></details>`,
    structuredClone,
    find: (table, id) => sandbox.config[table].find((x) => x.id === id),
    document: { querySelectorAll: () => [] },
    FormData: class {
      constructor(values) {
        return new Map(Object.entries(values));
      }
    },
    action: (fn) => fn(),
    load: async () => {},
    notice() {},
    api: async (url, payload) => {
      if (url.startsWith("/api/schedules")) return { tasks: [], history: [] };
      assert.equal(url, "/api/config");
      saved = validateConfig(payload.config);
      sandbox.config = saved;
      return {};
    },
  });
  vm.runInContext(
    fs.readFileSync(new URL("../public/parity.js", import.meta.url), "utf8"),
    sandbox,
  );
  await vm.runInContext(
    'parityAgentId = "agent-0"; renderSchedules()',
    sandbox,
  );
  assert.match($("#parity-body").innerHTML, /角色总投递上限／分钟/);
  const submit = (id, values) =>
    $(id).onsubmit({ preventDefault() {}, target: values });
  const values = {
    observe: "300",
    quiet: "10",
    batch: "4",
    batchMax: "12",
    reply: "30",
    wakeHour: "60",
    sendMinute: "2",
    sendHour: "10",
    conversationSendMinute: "1",
    conversationSendHour: "",
    keywords: "",
    speakers: "",
  };
  await submit("#behavior-form", values);
  assert.equal(saved.agents[0].behavior.batchWindowMs, 4000);
  assert.equal(saved.agents[0].behavior.batchMaxMs, 12000);
  assert.equal(saved.agents[0].behavior.maxSendPerMinute, 2);
  assert.equal(saved.agents[0].behavior.maxSendPerHour, 10);
  assert.equal(saved.agents[0].behavior.conversationMaxSendPerMinute, 1);
  assert.equal(saved.agents[0].behavior.conversationMaxSendPerHour, undefined);
  await submit("#behavior-form", { ...values, conversationSendMinute: "" });
  assert.equal(
    saved.agents[0].behavior.conversationMaxSendPerMinute,
    undefined,
  );
  await submit("#schedule-settings", {
    enabled: "on",
    quietEnabled: "on",
    quietAllDay: "on",
    totalPerDay: "50",
    perTaskPerDay: "12",
    perGroupPerDay: "10",
    missedGraceMin: "10",
    jitterMin: "0",
    timezone: "UTC",
    quietStart: "08:00",
    quietEnd: "08:00",
    holidays: "",
  });
  assert.equal(saved.agents[0].scheduler.quietAllDay, true);
});

test("console offers scoped recovery and only submits damage removal after confirmation", async () => {
  const fileId = "a".repeat(64),
    calls = [],
    repair = { dataset: { repair: fileId } },
    remove = { dataset: { removeDamaged: fileId } };
  const library = {
    innerHTML: "",
    insertAdjacentHTML(_where, html) {
      this.innerHTML += html;
    },
    querySelectorAll: (s) =>
      s.includes("data-repair") ? [repair, remove] : [],
  };
  let confirmed = false;
  const sandbox = vm.createContext({
    $: () => library,
    tab: "permissions",
    URLSearchParams,
    esc: (v) => String(v ?? ""),
    action: (fn) => fn(),
    notice() {},
    prompt: () => "recovered.txt",
    confirm: () => confirmed,
    api: async (url, payload) => {
      if (payload) {
        calls.push(JSON.parse(JSON.stringify(payload)));
        return {};
      }
      return {
        storedFiles: 1,
        usedBytes: 12,
        items: [],
        corruptCount: 1,
        corrupt: [{ fileId, code: "FILE_METADATA_CORRUPT" }],
        usageComplete: true,
        nextOffset: null,
        nextCorruptOffset: null,
      };
    },
  });
  vm.runInContext(
    fs.readFileSync(new URL("../public/files-ui.js", import.meta.url), "utf8"),
    sandbox,
  );
  await vm.runInContext(
    'fileAgentId = "agent-a"; loadFileLibrary("agent-a")',
    sandbox,
  );
  assert.match(library.innerHTML, /损坏条目已隔离/);
  await repair.onclick();
  assert.deepEqual(calls[0], {
    agentId: "agent-a",
    fileId,
    action: "repair",
    name: "recovered.txt",
  });
  await remove.onclick();
  assert.equal(calls.length, 1);
  confirmed = true;
  await remove.onclick();
  assert.deepEqual(calls[1], { agentId: "agent-a", fileId, action: "remove" });
});
