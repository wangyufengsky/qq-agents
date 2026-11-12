import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { runNativeSocial } from "../src/backends/native-social.mjs";
import { deriveRelayToken } from "../src/core/relay-auth.mjs";
import { desktopToken } from "../src/home/desktop-auth.mjs";
import { createServer } from "../src/server.mjs";
import { config, context, fixture } from "./helpers.mjs";

test("browser control requires the desktop client grant and a current desktop tool context", async (t) => {
  const agentId = "agent-0";
  const tool = "desktop_browser_control";
  const approved = "https://approved.example";
  const url = approved + "/fixture";
  const navigate = { action: "navigate", url };
  const cfg = config(1);
  cfg.desktopHome.enabled = true;
  cfg.desktopHome.toolRoles = [agentId];
  cfg.desktopHome.browserControl = { enabled: true };
  cfg.agents[0].network.autonomous = true;
  const { runtime } = fixture(t, { cfg });
  const recalled = runtime.memory.bind(agentId).append({
    dedupe: "browser-prior-chat",
    conversation: "group:20000",
    connectionId: "qq-0",
    kind: "message.received",
    direction: "in",
    status: "observed",
    body: "Synthetic ordinary chat recollection",
    payload: {},
  });
  const host = runtime.desktopVisits;
  const token = randomBytes(32).toString("hex");
  const desktopKey = desktopToken(token);
  const relayKey = deriveRelayToken(token);
  const server = createServer({ runtime, token, allowLive: true });
  t.after(() => server.close());
  const base = `http://127.0.0.1:${await server.listen()}`;
  const client = randomUUID();
  const post = (route, body, headers) =>
    fetch(base + route, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
  const command = (action, data, key = desktopKey, id = client) =>
    post(
      "/api/desktop-home/client",
      { client: id, action, data },
      { "x-desktop-home-token": key },
    );
  const call = (capability, name, args) =>
    post(
      "/agent/tools",
      { name, arguments: args },
      {
        "x-agent-capability": capability,
        "x-agent-relay-token": relayKey,
        "x-agent-output-request": randomUUID(),
        "x-agent-output-protocol": "stdio-v1",
      },
    ).then((response) => response.json());

  const calls = [];
  host.browser.driver = {
    async open(origin) {
      calls.push(["open", origin]);
      return {
        async navigate(url) {
          calls.push(["navigate", url]);
          return {
            url,
            title: "Fixture page",
            text: "Synthetic browser observation",
            elements: [],
          };
        },
        async close() {
          calls.push(["close"]);
        },
      };
    },
  };
  const { room } = await command("sync").then((r) => r.json());
  const role = host.live.room.roles[0];
  host.live.room.members[agentId] = "invited";
  host.live.admit(role);
  const grant = {
    roomEpoch: room.roomEpoch,
    grantId: randomUUID(),
    agentId,
    origin: approved,
  };
  assert.equal((await command("browser-grant", grant, token)).status, 401);
  const foreignClient = await command(
    "browser-grant",
    grant,
    desktopKey,
    randomUUID(),
  );
  assert.equal((await foreignClient.json()).busy, true);
  const granted = await command("browser-grant", grant);
  assert.equal(granted.status, 200);
  assert.deepEqual((await granted.json()).room.browserControl, {
    eligible: [agentId],
    grantedAgentId: agentId,
  });

  const qq = context(runtime, agentId, "private:30000");
  try {
    assert.equal((await call(qq.token, tool, navigate)).isError, true);
    assert.deepEqual(calls, []);
  } finally {
    runtime.capabilities.delete(qq.token);
  }

  let capability;
  const backend = runtime.backendConnections.adapter(runtime.agent(agentId));
  backend.runDesktop = (params) => {
    capability = params.socialContextToken;
    return runNativeSocial(backend, params, async () => {}, "desktop");
  };
  backend.run = async (params) => {
    await params.beforeInputSubmitted();
    params.saveSession({ backend: "codex", id: "fixture-browser-session" });
    const invoke = (args) => call(capability, tool, args);
    assert(params.tools.some(({ name }) => name === tool));
    const wrong = await invoke({
      ...navigate,
      url: "https://foreign.example/",
    });
    assert.equal(wrong.isError, true);
    assert.deepEqual(calls, []);

    const encoded = Array.from(
      capability,
      (char) => "%" + char.charCodeAt(0).toString(16),
    ).join("");
    const attemptedDisclosure = await invoke({
      ...navigate,
      url: approved + "/fixture?search=" + encoded,
    });
    assert.equal(attemptedDisclosure.isError, true);
    assert.match(
      attemptedDisclosure.content[0].text,
      /SENSITIVE_OUTPUT_BLOCKED/,
    );
    assert.deepEqual(calls, []);

    const memory = await call(capability, "memory_read", { id: recalled.id });
    assert(!memory.isError);
    assert.match(
      memory.content[0].text,
      /Synthetic ordinary chat recollection/,
    );
    const desktopContext = runtime.capabilities.get(capability);
    assert(desktopContext.privateRead.has(recalled.id));
    const opened = await invoke(navigate);
    assert(!opened.isError);
    const page = JSON.parse(opened.content[0].text);
    assert.equal(page.url, url);
    assert.equal(page.source, "untrusted-public-web");
    assert.equal(page.text, "Synthetic browser observation");

    desktopContext.privateRead.add("operations:fixture");
    const protectedNavigation = await invoke(navigate);
    assert.equal(protectedNavigation.isError, true);
    assert.match(
      protectedNavigation.content[0].text,
      /PRIVATE_RECOLLECTION_EXTERNAL_CALL_BLOCKED/,
    );
    assert.deepEqual(calls, [
      ["open", approved],
      ["navigate", url],
    ]);
    desktopContext.privateRead.delete("operations:fixture");

    const closed = await invoke({ action: "close" });
    assert(!closed.isError);
    assert.deepEqual(JSON.parse(closed.content[0].text), { closed: true });
    assert.equal((await invoke({ action: "observe" })).isError, true);

    const revoked = await command("browser-revoke", {
      roomEpoch: grant.roomEpoch,
      grantId: grant.grantId,
    });
    assert.equal(revoked.status, 200);
    assert.equal(
      (await revoked.json()).room.browserControl.grantedAgentId,
      null,
    );
    assert.equal((await invoke(navigate)).isError, true);
    await call(capability, "desktop_room_decide", { action: "silent" });
  };
  const decision = await host.run(
    { actor: agentId, kind: "chat", people: [], messages: [] },
    new AbortController().signal,
  );
  assert.equal(decision.action, "silent");
  assert.deepEqual(calls, [["open", approved], ["navigate", url], ["close"]]);
  assert(
    !JSON.stringify(host.archive.history()).includes(
      "Synthetic browser observation",
    ),
  );
});
