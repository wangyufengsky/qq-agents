import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { setImmediate } from "node:timers/promises";
import { deriveRelayToken } from "../src/core/relay-auth.mjs";
import { createServer } from "../src/server.mjs";
import { DshBackend } from "../src/backends/dsh.mjs";
import { runNativeSocial } from "../src/backends/native-social.mjs";
import {
  sessionContract,
  sessionSignature,
} from "../src/backends/session-contract.mjs";
import { SessionUnavailableFailure } from "../src/backends/turn-failure.mjs";
import { beginDesktopContext } from "../src/home/desktop-context.mjs";
import { DESKTOP_CONVERSATION } from "../src/home/desktop-decision.mjs";
import { scopedCatalog } from "../src/tools/catalog.mjs";
import { defaultGardenSettings } from "../src/home/garden-rules.mjs";
import { config, fixture } from "./helpers.mjs";

test("desktop events share the native session and stable tool declarations", async (t) => {
  const cfg = config(1);
  cfg.desktopHome.enabled = true;
  cfg.agents[0].appearance = "测试角色";
  cfg.agents[0].behavior.imageInput.enabled = false;
  cfg.agents[0].subject.users = ["30000"];
  const { runtime, store } = fixture(t, { cfg });
  const agent = runtime.agent("agent-0");
  const memory = store.bind(agent.id);
  const seen = [];
  let forceCapacityGuard = false;
  let screenAllowed = false;
  let createIntent = true;
  t.mock.method(runtime.desktopVisits.fullDesktop, "view", () => {
    if (!screenAllowed) throw Error("DESKTOP_SCREEN_UNAVAILABLE");
    return { observed: true };
  });
  const backend = {
    config: runtime.config.backends.find(({ id }) => id === agent.backendId),
    sessionSignature(tools) {
      return sessionSignature(this, tools);
    },
    async run(params) {
      await params.beforeInputSubmitted();
      params.onInputSubmitted();
      seen.push({
        conversation: params.conversation,
        session: params.session,
        tools: structuredClone(params.tools),
        prompt: params.prompt,
      });
      params.saveSession(
        params.session ?? {
          backend: this.config.type,
          id: "shared-desktop-session",
          signature: this.sessionSignature(params.tools),
        },
      );
      if (forceCapacityGuard)
        params.onUsage({
          source: "measured",
          contextTokens: 1000,
          capacityTokens: 1000,
        });
      await params.callTool("intent_list", {});
      if (createIntent) {
        createIntent = false;
        const intent = await params.callTool("intent_create", {
          target: "private:30000",
          topic: "下次继续聊",
          reason: "延续已有话题",
          expiresAt: runtime.now() + 60_000,
        });
        assert.equal(intent.createdIn, DESKTOP_CONVERSATION);
      }
      if (screenAllowed)
        assert.deepEqual(await params.callTool("desktop_screen_view", {}), {
          observed: true,
        });
      else
        await assert.rejects(
          params.callTool("desktop_screen_view", {}),
          /DESKTOP_SCREEN_UNAVAILABLE/,
        );
      assert.deepEqual(
        await params.callTool("desktop_room_decide", {
          action: "say",
          text: "桌边见。",
        }),
        { action: "say" },
      );
      if (agent.tools.includes("memory_search"))
        await params.callTool("memory_search", { query: "桌面" });
      else
        await assert.rejects(
          params.callTool("memory_search", { query: "桌面" }),
          /TOOL_DISABLED/,
        );
      if (runtime.config.board.enabled) await params.callTool("board_read", {});
      else
        await assert.rejects(
          params.callTool("board_read", {}),
          /TOOL_DISABLED/,
        );
    },
  };
  const enter = async (kind, extra = {}) => {
    const controller = new AbortController();
    const ctx = runtime.makeContext(agent.id, DESKTOP_CONVERSATION, {
      controller,
      assertCurrent() {},
      decide(args) {
        return { action: args.action };
      },
      unified: true,
      kind,
    });
    ctx.desktopScreenObserved = Boolean(extra.observation);
    const exchange = beginDesktopContext(
      runtime,
      ctx,
      agent,
      backend,
      { kind, people: [], messages: [], ...extra },
      controller.signal,
    );
    const catalog = scopedCatalog(runtime, ctx, {
      names: ["desktop_body_control"],
    }).tools;
    assert.deepEqual(
      catalog[0].inputSchema,
      exchange.tools.find(
        ({ function: tool }) => tool.name === "desktop_body_control",
      ).function.parameters,
    );
    assert(catalog[0].description.includes("wave"));
    assert.equal(
      exchange.tools.some(({ function: tool }) => tool.name === "qq_send"),
      false,
    );
    await runNativeSocial(
      backend,
      {
        ...exchange,
        budget: null,
        signal: controller.signal,
        binding: { runId: ctx.turnId },
        beforeInput() {},
        onRunStarted() {},
        maxToolResultBytes: 65536,
      },
      async () => {},
      "desktop",
    );
    await exchange.finish();
    runtime.capabilities.delete(ctx.token);
  };
  await enter("chat");
  runtime.config.board.enabled = !runtime.config.board.enabled;
  agent.tools = [];
  screenAllowed = true;
  await enter("activity");
  await enter("activity", { observation: true });
  await enter("chat");
  assert(seen.every((item) => item.conversation === DESKTOP_CONVERSATION));
  assert.equal(seen[0].session, undefined);
  for (const item of seen.slice(1)) {
    assert.deepEqual(item.tools, seen[0].tools);
    assert.equal(item.session.id, "shared-desktop-session");
  }
  assert.equal(
    memory.state(DESKTOP_CONVERSATION).session.id,
    "shared-desktop-session",
  );
  assert.deepEqual(memory.identity.list("session_history"), []);
  forceCapacityGuard = true;
  await enter("activity");
  assert.equal(memory.state(DESKTOP_CONVERSATION).session, null);
  assert.equal(
    memory.identity.list("session_history")[0].reason,
    "capacity-guard",
  );
  forceCapacityGuard = false;
  await enter("chat", {
    continuity: [{ speaker: "小猫", text: "回到在场时留下的话题" }],
  });
  assert.equal(seen.at(-1).session, null);
  assert.match(seen.at(-1).prompt, /回到在场时留下的话题/);
});

test("desktop opening records a DSH catalogue migration only after input acceptance", async (t) => {
  const cfg = config(1);
  cfg.desktopHome.enabled = true;
  cfg.backends[0].preset = "qq-unified";
  const { runtime, store, root } = fixture(t, { cfg });
  const agent = runtime.agent("agent-0");
  const memory = store.bind(agent.id);
  const backend = new DshBackend(runtime.config.backends[0], agent, { root });
  t.after(() => backend.close());
  const begin = (unified) => {
    const controller = new AbortController();
    const ctx = runtime.makeContext(agent.id, DESKTOP_CONVERSATION, {
      controller,
      assertCurrent() {},
      decide() {},
      unified,
      kind: "chat",
    });
    return beginDesktopContext(
      runtime,
      ctx,
      agent,
      backend,
      {
        kind: "chat",
        people: [],
        messages: [],
      },
      controller.signal,
    );
  };

  const legacy = begin(false);
  const specs = (exchange) =>
    exchange.tools.map(({ function: tool }) => ({
      name: tool.name,
      inputSchema: tool.parameters,
    }));
  const session = {
    backend: "dsh",
    id: "old-desktop-session",
    signature: backend.sessionSignature(specs(legacy)),
  };
  legacy.managedContext.saveSession(session);
  legacy.onInputSubmitted();
  await legacy.finish();

  const upgraded = begin(true);
  assert.equal(upgraded.managedContext.session.id, session.id);
  assert.notEqual(upgraded.managedContext.session.signature, session.signature);
  assert.deepEqual(memory.state(DESKTOP_CONVERSATION).session, session);
  upgraded.onInputSubmitted();
  assert.deepEqual(
    memory.state(DESKTOP_CONVERSATION).session,
    upgraded.managedContext.session,
  );
  assert.deepEqual(
    memory.state(DESKTOP_CONVERSATION).backendContract,
    sessionContract(backend, specs(upgraded)),
  );
  assert.deepEqual(memory.identity.list("session_history"), []);
  await upgraded.finish();
});

test("native and authenticated relay tools wait for the same desktop action queue", async (t) => {
  const cfg = config(1);
  cfg.desktopHome.enabled = true;
  const { runtime } = fixture(t, { cfg });
  const agent = runtime.agent("agent-0");
  const controller = new AbortController();
  const capture = Promise.withResolvers();
  const captureStarted = Promise.withResolvers();
  const relayInput = Promise.withResolvers();
  const calls = [];
  const ctx = runtime.makeContext(agent.id, DESKTOP_CONVERSATION, {
    controller,
    assertCurrent() {},
    decide({ action }) {
      calls.push(action);
      return { action };
    },
    unified: true,
    kind: "chat",
  });
  t.after(() => capture.resolve());
  t.mock.method(runtime.desktopVisits.fullDesktop, "view", async () => {
    calls.push("capture-started");
    captureStarted.resolve();
    await capture.promise;
    calls.push("capture-finished");
    return { status: "observed" };
  });
  const exchange = beginDesktopContext(
    runtime,
    ctx,
    agent,
    {},
    { kind: "chat", people: [], messages: [] },
    controller.signal,
  );
  exchange.onInputSubmitted();
  ctx.desktopConsumeInput = () => relayInput.resolve();
  const token = "desktop-relay-fixture";
  const app = createServer({ runtime, token });
  t.after(() => app.close());
  const url = "http://127.0.0.1:" + (await app.listen());
  const first = exchange.callTool("desktop_screen_view", {});
  await captureStarted.promise;
  const second = fetch(url + "/agent/tools", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-agent-capability": ctx.token,
      "x-agent-relay-token": deriveRelayToken(token),
      "x-agent-output-protocol": "stdio-v1",
      "x-agent-output-request": "queued-desktop-test",
    },
    body: JSON.stringify({
      name: "desktop_room_decide",
      arguments: { action: "say", text: "看完了。" },
    }),
  });
  try {
    await relayInput.promise;
    await setImmediate();
    assert.deepEqual(calls, ["capture-started"]);
  } finally {
    capture.resolve();
    await first;
    const response = await second;
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(Boolean(result.isError), false);
    await exchange.finish();
  }
  assert.deepEqual(calls, ["capture-started", "capture-finished", "say"]);
});

test("an explicit desktop backend change archives the old session and carries forward the room context", async (t) => {
  const cfg = config(1);
  cfg.desktopHome.enabled = true;
  const { runtime, store } = fixture(t, { cfg });
  const agent = runtime.agent("agent-0");
  const memory = store.bind(agent.id);
  const backend = {
    config: runtime.config.backends.find(({ id }) => id === agent.backendId),
    sessionSignature(tools) {
      return sessionSignature(this, tools);
    },
  };
  const controller = new AbortController();
  const ctx = runtime.makeContext(agent.id, DESKTOP_CONVERSATION, {
    controller,
    assertCurrent() {},
    decide() {},
    unified: true,
    kind: "chat",
  });
  const previous = {
    backend: backend.config.type,
    id: "fixture-previous-backend-session",
    signature: backend.sessionSignature([]),
  };
  const { version } = memory.identity.initialize(agent, runtime.now());
  memory.setState(DESKTOP_CONVERSATION, {
    session: previous,
    desktopBackendId: "fixture-previous-backend",
    loadedSelfVersion: version,
  });
  const exchange = beginDesktopContext(
    runtime,
    ctx,
    agent,
    backend,
    {
      kind: "chat",
      people: [],
      messages: [],
      continuity: [{ speaker: "主人", text: "在场时听见的消息。" }],
    },
    controller.signal,
  );
  assert.equal(exchange.managedContext.session, null);
  assert.match(exchange.prompt, /在场时听见的消息/);
  assert.equal(memory.state(DESKTOP_CONVERSATION).session, null);
  const history = memory.identity.list("session_history");
  assert.equal(history.length, 1);
  assert.match(JSON.stringify(history), /fixture-previous-backend-session/);
  await exchange.finish();
});

test("starting a unified desktop context preserves an incompatible prior native reference", (t) => {
  const cfg = config(1);
  cfg.desktopHome.enabled = true;
  const { runtime, store } = fixture(t, { cfg });
  const agent = runtime.agent("agent-0");
  const memory = store.bind(agent.id);
  const controller = new AbortController();
  const backend = {
    config: runtime.config.backends.find(({ id }) => id === agent.backendId),
    sessionSignature(tools) {
      return sessionSignature(this, tools);
    },
  };
  const legacy = {
    backend: backend.config.type,
    id: "existing-desktop-thread",
    signature: backend.sessionSignature([]),
  };
  memory.setState(DESKTOP_CONVERSATION, {
    desktopBackendId: agent.backendId,
    session: legacy,
  });
  const ctx = runtime.makeContext(agent.id, DESKTOP_CONVERSATION, {
    controller,
    assertCurrent() {},
    decide() {},
    unified: true,
    kind: "chat",
  });
  assert.throws(
    () =>
      beginDesktopContext(
        runtime,
        ctx,
        agent,
        backend,
        { kind: "chat", people: [], messages: [] },
        controller.signal,
      ),
    /SESSION_REQUIRES_HANDOFF/,
  );
  assert.deepEqual(memory.state(DESKTOP_CONVERSATION).session, legacy);
  assert.deepEqual(memory.identity.list("session_history"), []);
});

test("the current garden role can manage the garden from an attended desktop turn", async (t) => {
  const cfg = config(1);
  cfg.desktopHome.enabled = true;
  const { runtime } = fixture(t, { cfg });
  const agent = runtime.agent("agent-0");
  runtime.desktopVisits.command({ client: randomUUID(), action: "sync" });
  const live = runtime.desktopVisits.live;
  assert(live);
  live.room.members[agent.id] = "here";
  live.visits.set(agent.id, {});
  const controller = new AbortController();
  const ctx = runtime.makeContext(agent.id, DESKTOP_CONVERSATION, {
    controller,
    assertCurrent() {},
    decide() {},
    unified: true,
    kind: "activity",
  });
  ctx.backendInputEpoch = ctx.inputEpoch;
  ctx.turnId = randomUUID();
  runtime.running.set(agent.id + "|" + ctx.conversation, ctx);
  try {
    const garden = runtime.home.garden;
    const settings = defaultGardenSettings();
    settings.roles[agent.id] = runtime.home.generation(agent.id);
    garden.initialize(runtime.now(), settings);

    const view = await runtime.callTool(ctx, "garden_read", {});
    assert.equal(view.turnRemaining, settings.turnLimit);
    await runtime.callTool(ctx, "garden_act", {
      requestId: randomUUID(),
      kind: "plant",
      args: { plot: 1, cropId: "clover" },
    });
    assert.equal(garden.read(runtime.now()).plots[0].plant.cropId, "clover");
    live.visits.delete(agent.id);
    await assert.rejects(
      runtime.callTool(ctx, "garden_act", {
        requestId: randomUUID(),
        kind: "plant",
        args: { plot: 2, cropId: "clover" },
      }),
      /GARDEN_ROLE_UNAVAILABLE/,
    );
  } finally {
    runtime.running.delete(agent.id + "|" + ctx.conversation);
    runtime.capabilities.delete(ctx.token);
  }
});

test("desktop interruption preserves the reference unless the provider confirms it is unavailable", async (t) => {
  const cfg = config(1);
  cfg.desktopHome.enabled = true;
  const { runtime, store } = fixture(t, { cfg });
  const agent = runtime.agent("agent-0");
  const memory = store.bind(agent.id);
  const reference = { id: "healthy-desktop-thread", backend: "codex" };
  const backend = {
    async run(params) {
      await params.beforeInputSubmitted();
      assert(params.desktopUnified);
      params.onInputSubmitted();
      params.saveSession(params.session ?? reference);
    },
  };
  const run = async (native, abortDuringPreparation = false) => {
    const controller = new AbortController();
    const ctx = runtime.makeContext(agent.id, DESKTOP_CONVERSATION, {
      controller,
      assertCurrent() {},
      decide() {},
      unified: true,
      kind: "chat",
    });
    const exchange = beginDesktopContext(
      runtime,
      ctx,
      agent,
      backend,
      { kind: "chat", people: [], messages: [] },
      controller.signal,
    );
    let failure;
    try {
      await runNativeSocial(
        native ? { run: (params) => native(params, controller) } : backend,
        {
          ...exchange,
          budget: null,
          signal: controller.signal,
          binding: { runId: ctx.turnId },
          beforeInput() {
            if (abortDuringPreparation)
              controller.abort(Error("DESKTOP_VISIT_UNAVAILABLE"));
          },
          onRunStarted() {},
          maxToolResultBytes: 65536,
        },
        async () => assert.fail("must not archive live desktop threads"),
        "desktop",
      );
    } catch (error) {
      failure = error;
    }
    await exchange.finish(failure);
    runtime.capabilities.delete(ctx.token);
    return failure;
  };

  assert.equal(await run(), undefined);
  assert.deepEqual(memory.state(DESKTOP_CONVERSATION).session, reference);
  assert((await run(undefined, true)) instanceof Error);
  assert.deepEqual(memory.state(DESKTOP_CONVERSATION).session, reference);
  assert(
    (await run(async (params, controller) => {
      await params.beforeInputSubmitted();
      params.onInputSubmitted();
      controller.abort(Error("DESKTOP_VISIT_UNAVAILABLE"));
      throw controller.signal.reason;
    })) instanceof Error,
  );
  assert.deepEqual(memory.state(DESKTOP_CONVERSATION).session, reference);
  assert(
    (await run(async () => {
      throw Error("CODEX_DISCONNECTED");
    })) instanceof Error,
  );
  assert.deepEqual(memory.state(DESKTOP_CONVERSATION).session, reference);
  assert.deepEqual(memory.identity.list("session_history"), []);

  assert(
    (await run(async () => {
      throw new SessionUnavailableFailure("CODEX_SESSION_UNAVAILABLE");
    })) instanceof SessionUnavailableFailure,
  );
  assert.equal(memory.state(DESKTOP_CONVERSATION).session, null);
  assert.equal(
    memory.identity.list("session_history")[0].reason,
    "backend-failure",
  );
});
