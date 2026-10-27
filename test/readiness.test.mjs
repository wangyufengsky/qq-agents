import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import vm from "node:vm";
import { validateConfig } from "../src/core/config.mjs";
import { defaultConfig } from "../src/core/default-config.mjs";
import { readiness } from "../src/core/readiness.mjs";
import { createServer } from "../src/server.mjs";
import { config, fixture } from "./helpers.mjs";

const status = (
  cfg,
  { connected = true, backend = "ready", blockers } = {},
) => ({
  connections: cfg.connections.map((c) => ({ id: c.id, connected })),
  backends: cfg.backends.map((b) => ({ id: b.id, state: backend })),
  agents: cfg.agents.map((a) => ({ id: a.id, blockers: blockers || [] })),
});
const byId = (steps) => Object.fromEntries(steps.map((s) => [s.id, s]));

test("shipped defaults list every gate in order and mark placeholders", () => {
  const cfg = validateConfig(defaultConfig());
  const r = readiness(
    cfg,
    status(cfg, { connected: false, backend: "unchecked" }),
  );
  assert.deepEqual(
    r.steps.map((s) => s.id),
    [
      "live-flag",
      "mode",
      "account",
      "connection-enabled",
      "connection-connected",
      "whitelist",
      "global-pause",
      "agent-pause",
      "backend",
    ],
  );
  assert.equal(r.ready, false);
  assert.equal(r.focusAgentId, "agent-a");
  assert.ok(r.steps.every((s) => !s.done));
  const s = byId(r.steps);
  assert.equal(s.account.detail.accountId, "10001");
  assert.equal(s.account.connectionId, "napcat-a");
  assert.equal(s.backend.backendId, "dsh-desktop");
  // An unchecked backend is advisory; the other gates actually block.
  assert.equal(s.backend.blocking, false);
  assert.ok(r.steps.filter((x) => x.id !== "backend").every((x) => x.blocking));
  assert.deepEqual(r.placeholders, {
    agents: ["agent-a", "agent-b"],
    connections: ["napcat-a", "napcat-b"],
  });
  assert.equal(r.agents.length, 2);
});

test("a fully configured agent is ready and nothing blocks", () => {
  // Fixture accounts start at 10000; a second one would be the shipped 10001.
  const cfg = config(1);
  const r = readiness(cfg, status(cfg), { allowLive: true });
  assert.equal(r.ready, true);
  assert.ok(r.steps.every((s) => s.done && !s.blocking));
  assert.deepEqual(r.placeholders, { agents: [], connections: [] });
  assert.equal(readiness(cfg, status(cfg)).ready, false);
  assert.equal(
    byId(readiness(cfg, status(cfg)).steps)["live-flag"].blocking,
    true,
  );
});

test("each gate flips its own step", () => {
  const cfg = config(1);
  cfg.mode = "isolated";
  cfg.globalPaused = true;
  cfg.agents[0].paused = true;
  cfg.agents[0].allow = { groups: [], users: [] };
  cfg.connections[0].enabled = false;
  const s = byId(
    readiness(cfg, status(cfg, { connected: false, backend: "disconnected" }), {
      allowLive: true,
    }).steps,
  );
  for (const id of [
    "mode",
    "connection-enabled",
    "connection-connected",
    "whitelist",
    "global-pause",
    "agent-pause",
    "backend",
  ])
    assert.equal(s[id].blocking, true, id);
  assert.equal(s["live-flag"].done, true);
  assert.equal(s.account.done, true);
  assert.deepEqual(s.whitelist.detail, { groups: 0, users: 0 });
  assert.equal(s.backend.detail.state, "disconnected");
});

test("a connected placeholder account counts as verified", () => {
  const cfg = config(1);
  cfg.connections[0].accountId = "10001";
  assert.equal(byId(readiness(cfg, status(cfg)).steps).account.done, true);
  const offline = readiness(cfg, status(cfg, { connected: false }));
  assert.equal(byId(offline.steps).account.done, false);
  assert.deepEqual(offline.placeholders.connections, ["qq-0"]);
});

test("focus follows the agent closest to speaking and extra gates are listed", () => {
  const cfg = config(2);
  cfg.agents[0].paused = true;
  cfg.agents[0].allow = { groups: [], users: [] };
  const r = readiness(cfg, status(cfg), { allowLive: true });
  assert.equal(r.focusAgentId, "agent-1");
  assert.equal(r.ready, true);
  assert.deepEqual(
    r.agents.map((a) => a.ready),
    [false, true],
  );
  const quiet = readiness(
    cfg,
    status(cfg, { blockers: ["GLOBAL_PAUSED", "QUIET_HOURS"] }),
    { allowLive: true },
  );
  const other = quiet.steps.filter((s) => s.id === "other");
  assert.deepEqual(
    other.map((s) => s.detail.code),
    ["QUIET_HOURS"],
  );
  assert.equal(quiet.ready, false);
});

test("no agents still yields a checklist", () => {
  const cfg = config(1);
  cfg.agents = [];
  const r = readiness(cfg, status(cfg));
  assert.equal(r.focusAgentId, null);
  assert.ok(r.steps.some((s) => s.id === "agent" && s.blocking));
});

async function serve(t, { allowLive, mode = "isolated" } = {}) {
  const cfg = config(1);
  cfg.mode = mode;
  cfg.globalPaused = true;
  const f = fixture(t, { cfg }),
    token = randomBytes(32).toString("hex"),
    app = createServer({ runtime: f.runtime, token, allowLive });
  const port = await app.listen();
  t.after(() => app.close());
  const call = async (url, data) => {
    const r = await fetch(`http://127.0.0.1:${port}${url}`, {
      method: data ? "POST" : "GET",
      headers: { "x-admin-token": token, "content-type": "application/json" },
      ...(data ? { body: JSON.stringify(data) } : {}),
    });
    return { status: r.status, body: await r.json() };
  };
  return { ...f, call };
}

test("status exposes readiness next to allowLive", async (t) => {
  const { call } = await serve(t, { allowLive: false });
  const { body } = await call("/api/status");
  assert.equal(body.allowLive, false);
  const s = byId(body.readiness.steps);
  assert.equal(s["live-flag"].done, false);
  assert.equal(s.mode.done, false);
  assert.equal(s["global-pause"].done, false);
  assert.equal(body.readiness.focusAgentId, "agent-0");
});

test("mode API refuses live without --live and always allows isolated", async (t) => {
  const { call, runtime, configStore } = await serve(t, {
    allowLive: false,
    mode: "isolated",
  });
  const before = configStore.revision;
  const refused = await call("/api/mode", { mode: "live", revision: before });
  assert.equal(refused.status, 400);
  assert.equal(refused.body.error, "RESTART_WITH_LIVE_FLAG_REQUIRED");
  assert.equal(runtime.config.mode, "isolated");
  assert.equal(configStore.revision, before);
  const invalid = await call("/api/mode", { mode: "chaos", revision: before });
  assert.equal(invalid.body.error, "INVALID_MODE");
  // Isolated is a safety control: even a stale revision is honoured.
  const same = await call("/api/mode", { mode: "isolated", revision: "stale" });
  assert.equal(same.status, 200);
  assert.equal(same.body.mode, "isolated");
});

test("mode API goes live on the reviewed revision and back to isolated", async (t) => {
  const { call, runtime, configStore } = await serve(t, { allowLive: true });
  const stale = await call("/api/mode", { mode: "live", revision: "stale" });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.error, "CONFIG_CONFLICT");
  assert.equal(runtime.config.mode, "isolated");
  const live = await call("/api/mode", {
    mode: "live",
    revision: configStore.revision,
  });
  assert.equal(live.status, 200);
  assert.equal(live.body.mode, "live");
  assert.equal(live.body.revision, configStore.revision);
  assert.equal(configStore.value.mode, "live");
  assert.equal(
    byId((await call("/api/status")).body.readiness.steps).mode.done,
    true,
  );
  // Pause state is not touched by a mode switch.
  assert.equal(runtime.config.globalPaused, true);
  const back = await call("/api/mode", { mode: "isolated", revision: "stale" });
  assert.equal(back.status, 200);
  assert.equal(configStore.value.mode, "isolated");
  assert.equal(
    (await call("/api/status")).body.connections.every((c) => !c.connected),
    true,
  );
});

function consoleSandbox(initial) {
  const nodes = new Map();
  const node = (s) => {
    if (!nodes.has(s))
      nodes.set(s, {
        innerHTML: "",
        classList: { toggle() {}, remove() {} },
        addEventListener() {},
        querySelectorAll: () => [],
        insertAdjacentHTML(where, html) {
          this.innerHTML =
            where === "afterbegin"
              ? html + this.innerHTML
              : this.innerHTML + html;
        },
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
    fetch: async () => new Response("{}"),
    initial,
  });
  for (const file of ["onboarding-ui.js", "app.js"])
    vm.runInContext(
      fs.readFileSync(new URL("../public/" + file, import.meta.url), "utf8"),
      sandbox,
    );
  vm.runInContext(
    'config=initial.config;status=initial.status;tab="overview";render();',
    sandbox,
  );
  return node("#content").innerHTML;
}

test("overview renders the checklist above the role cards in every state", async (t) => {
  for (const allowLive of [false, true]) {
    const { call, runtime } = await serve(t, { allowLive });
    const html = consoleSandbox({
      config: runtime.config,
      status: (await call("/api/status")).body,
    });
    assert.ok(html.indexOf("上线清单") >= 0, "checklist present");
    assert.ok(html.indexOf("上线清单") < html.indexOf('id="home-roles"'));
    assert.equal(html.includes('data-mode="live" disabled'), !allowLive);
  }
  const cfg = config(1);
  const html = consoleSandbox({
    config: cfg,
    status: {
      ...status(cfg),
      mode: "live",
      allowLive: true,
      globalPaused: false,
      recentErrors: [],
      disclosureRequests: [],
      agents: [{ id: "agent-0", activeTurns: 0, blockers: [] }],
      readiness: readiness(cfg, status(cfg), { allowLive: true }),
    },
  });
  assert.ok(html.includes("已就绪"));
  assert.ok(!html.includes('class="checklist"'));
});
