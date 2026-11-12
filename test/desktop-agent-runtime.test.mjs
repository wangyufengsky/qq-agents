import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { runNativeSocial } from "../src/backends/native-social.mjs";
import { deriveRelayToken } from "../src/core/relay-auth.mjs";
import { desktopToken } from "../src/home/desktop-auth.mjs";
import { createServer } from "../src/server.mjs";
import { config, fixture } from "./helpers.mjs";

function desktop(t) {
  const cfg = config(1);
  cfg.desktopHome.enabled = true;
  cfg.agents[0].appearance = "测试外形";
  cfg.agents[0].model = "role-model";
  cfg.agents[0].effort = "high";
  const { runtime, store } = fixture(t, { cfg });
  const host = runtime.desktopVisits;
  const client = randomUUID();
  host.command({ client, action: "sync" });
  const makeBackend = runtime.backendFactory;
  runtime.backendFactory = (effective, agent) =>
    Object.assign(makeBackend(effective, agent), { config: effective });
  const backend = runtime.backendConnections.adapter(runtime.agent("agent-0"));
  backend.runDesktop = (params) =>
    runNativeSocial(backend, params, async () => {}, "desktop");
  const memory = store.bind("agent-0");
  const run = (extra) =>
    host.run(
      { actor: "agent-0", kind: "chat", people: [], messages: [], ...extra },
      new AbortController().signal,
    );
  return { runtime, memory, backend, run, host, client };
}

test("desktop dialogue records the current Self and effective role model without QQ", async (t) => {
  const { runtime, memory, backend, run } = desktop(t);
  runtime.transports.get("qq-0").close();
  const seen = [];
  let nextSession = 0;
  backend.run = async (params) => {
    await params.beforeInputSubmitted();
    params.onInputSubmitted();
    params.onBackendTurn({ turnId: "native-" + seen.length });
    const session = params.session ?? {
      backend: "codex",
      id: "native-session-" + ++nextSession,
    };
    params.saveSession(session);
    seen.push({ ...params, session, tools: [...params.tools] });
    assert.equal(backend.config.model, "role-model");
    assert.equal(backend.config.effort, "high");
    await assert.rejects(params.callTool("qq_send", {}), /SOCIAL_TOOL_DENIED/);
    await params.callTool("desktop_room_decide", { action: "silent" });
  };
  await run();
  await run();
  assert.equal(seen[0].session.id, seen[1].session.id);
  assert.equal(seen[1].instructions, undefined);
  memory.identity.writeVersion(
    {
      body: "最新的桌面角色设定",
      reason: "合成测试资料",
      expectedVersion: memory.identity.current().version,
      actor: "administrator",
    },
    runtime.now(),
  );
  await run();
  assert.notEqual(seen[2].session.id, seen[0].session.id);
  assert.match(seen[2].instructions, /最新的桌面角色设定/);
  assert.deepEqual(
    seen[2].tools.map(({ name }) => name),
    ["desktop_room_decide"],
  );
  assert.equal(seen[2].conversation, "@desktop");
  const turns = memory.identity.list("model_turns");
  assert.equal(turns.length, 3);
  assert(
    turns.every(
      ({ functionalAgentKey, inputStage, status }) =>
        functionalAgentKey === "agent-0/desktop/@desktop" &&
        inputStage !== "not-submitted" &&
        status === "completed-no-send",
    ),
  );
  assert(
    memory.identity
      .list("session_history")
      .some(({ reason }) => reason === "self-version-change"),
  );
  assert.equal(runtime.capabilities.size, 0);
});

test("desktop relay admits only current authenticated decision tools and allows ordinary Self evidence", async (t) => {
  const { runtime, memory, backend, run } = desktop(t);
  const token = randomBytes(32).toString("hex");
  const app = createServer({ runtime, token, allowLive: true });
  t.after(() => app.close());
  const base = `http://127.0.0.1:${await app.listen()}`;
  const submit = (path, data, capability, relay = true) =>
    fetch(base + path, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-agent-capability": capability,
        ...(relay && {
          "x-agent-relay-token": deriveRelayToken(token),
          "x-agent-output-request": randomUUID(),
          "x-agent-output-protocol": "stdio-v1",
        }),
      },
      body: JSON.stringify(data),
    });
  const source = memory.append({
    dedupe: "desktop-private-evidence",
    conversation: "private:30000",
    kind: "message.received",
    body: "桌边其他角色不能读取的聊天资料",
    payload: {},
  });
  const current = memory.identity.initialize(
    runtime.agent("agent-0"),
    runtime.now(),
  );
  memory.identity.writeVersion(
    {
      body: "根据私聊形成的特征",
      reason: "合成来源",
      expectedVersion: current.version,
      evidence: [source.id],
      actor: "administrator",
    },
    runtime.now(),
  );
  let capability;
  const native = backend.runDesktop;
  backend.runDesktop = (params) => {
    capability = params.socialContextToken;
    return native(params);
  };
  backend.run = async (params) => {
    assert.match(params.instructions, /根据私聊形成的特征/);
    await params.beforeInputSubmitted();
    params.saveSession({ backend: "codex", id: "fixture-desktop" });
    const catalog = "/agent/catalog";
    const tools = "/agent/tools";
    assert.equal((await submit(catalog, {}, capability, false)).status, 403);
    const listed = await submit(catalog, {}, capability).then((r) => r.json());
    assert.deepEqual(
      JSON.parse(listed.content[0].text).tools.map(({ name }) => name),
      ["desktop_room_decide"],
    );
    const call = (name, args, relay) =>
      submit(tools, { name, arguments: args }, capability, relay).then((r) =>
        r.json(),
      );
    assert.match(
      JSON.stringify(
        await call("desktop_room_decide", { action: "silent" }, false),
      ),
      /MCP_RELAY_AUTH_REQUIRED/,
    );
    assert.match(
      JSON.stringify(await call("memory_read", { id: source.id })),
      /TOOL_DISABLED/,
    );
    const turn = memory.identity.list("model_turns")[0];
    assert.equal(turn.inputStage, "not-submitted");
    const accepted = await call("desktop_room_decide", {
      action: "say",
      text: "普通角色设定可以正常用于聊天",
    });
    assert.match(JSON.stringify(accepted), /recorded/);
  };
  assert.deepEqual(await run(), {
    action: "say",
    text: "普通角色设定可以正常用于聊天",
  });
  assert.match(
    JSON.stringify(
      await submit("/agent/catalog", {}, capability).then((r) => r.json()),
    ),
    /INVALID_CAPABILITY/,
  );
});

test("desktop maintenance drains admitted work and closes admission", async (t) => {
  const { runtime, backend, memory, run, host, client } = desktop(t);
  const token = randomBytes(32).toString("hex");
  const app = createServer({ runtime, token, allowLive: true });
  t.after(() => app.close());
  const base = `http://127.0.0.1:${await app.listen()}`;
  const request = (action, data, key = desktopToken(token)) =>
    fetch(base + "/api/desktop-home/client", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-desktop-home-token": key,
      },
      body: JSON.stringify({ client, action, data }),
    });
  const started = Promise.withResolvers();
  const release = Promise.withResolvers();
  backend.run = async (params) => {
    await params.beforeInputSubmitted();
    params.onInputSubmitted();
    params.saveSession({ backend: "codex", id: "desktop-maintenance" });
    started.resolve();
    await release.promise;
    await params.callTool("desktop_room_decide", { action: "silent" });
  };
  const ongoing = run();
  await started.promise;
  assert.equal(runtime.maintenance.begin().pending, 1);
  const room = host.live;
  try {
    host.client.expiresAt = runtime.now() + 10_000;
    const priorLease = host.client.expiresAt;
    assert.equal((await request("disconnect", undefined, token)).status, 401);
    assert.equal((await request("sync", undefined, token)).status, 401);
    assert.equal(host.client.expiresAt, priorLease);
    const sync = await request("sync");
    assert.equal(sync.status, 200);
    assert.equal((await sync.json()).enabled, true);
    assert(host.client.expiresAt > priorLease);
    assert.equal((await request("send", "维护期间不受理的新消息")).status, 200);
    assert.equal(host.live, room);
    assert.deepEqual(host.live.room.messages, []);
    await assert.rejects(run(), /DESKTOP_VISIT_UNAVAILABLE/);
  } finally {
    release.resolve();
  }
  assert.deepEqual(await ongoing, { action: "silent" });
  assert.equal(runtime.maintenance.snapshot().pending, 0);
  assert.equal(memory.state("@desktop").session.id, "desktop-maintenance");
});

test("desktop dialogue omits protected material from the latest Self", async (t) => {
  const { runtime, memory, backend, run } = desktop(t);
  const event = memory.append({
    dedupe: "desktop-protected-source",
    conversation: "@work:fixture",
    kind: "external.read",
    body: "测试用受保护资料",
    payload: { protectedOperations: true },
  });
  const current = memory.identity.initialize(
    runtime.agent("agent-0"),
    runtime.now(),
  );
  const version = memory.identity.writeVersion(
    {
      body: "来自受保护资料的内容",
      reason: "测试受保护来源",
      expectedVersion: current.version,
      evidence: [event.id],
      // Simulate a restored Self version predating current write protection.
      evidenceSnapshot: {
        entryIds: [event.id],
        references: [{ id: event.id, metadata: { protectedOperations: true } }],
      },
      actor: "administrator",
    },
    runtime.now(),
  );
  backend.run = async (params) => {
    assert.match(params.instructions, /当前版本含受保护来源/);
    assert.doesNotMatch(params.instructions, /来自受保护资料的内容/);
    await params.beforeInputSubmitted();
    params.onInputSubmitted();
    params.saveSession({ backend: "codex", id: "desktop-protected-self" });
    await params.callTool("desktop_room_decide", { action: "silent" });
  };
  await run();
  assert.equal(
    memory.identity.list("model_turns")[0].selfVersion,
    version.version,
  );
});
