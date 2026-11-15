import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { DesktopPersonal } from "../src/home/desktop-personal.mjs";

function fixture() {
  const client = randomUUID(),
    roomEpoch = randomUUID(),
    visitId = randomUUID();
  const visit = {},
    calls = [],
    capabilities = new Map();
  let handler = async (params) => {
    calls.push(params);
    await params.onRunStarted();
    await params.callTool("desktop_room_decide", {
      action: "say",
      text: "收到",
    });
  };
  const agent = {
    id: "fish",
    name: "鱼",
    backendId: "backend",
    behavior: { turnTimeoutMs: 5000 },
  };
  const runtime = {
    agent: () => agent,
    config: {
      agents: [agent],
      backends: [],
      desktopHome: { observationRetentionDays: 7 },
    },
    capabilities,
    blockers: () => [],
    trackWork: (p) => p,
    assertSafeOutput: () => {},
    makeContext: (id, conversation, options) => {
      const ctx = {
        ...options,
        token: randomUUID(),
        inputEpoch: "1",
        privateRead: new Set(),
      };
      capabilities.set(ctx.token, ctx);
      return ctx;
    },
    callTool: (ctx, name, args) => ctx.decide(args),
    backendConnections: { adapter: () => ({ runDesktop: (p) => handler(p) }) },
  };
  const host = {
    runtime,
    client: { id: client },
    live: { room: { epoch: roomEpoch }, visits: new Map([["fish", visit]]) },
    observation: { maintain() {}, summaries: { list: () => [] } },
    connected: () => true,
    body: { visitId: () => visitId },
    visit: () => ({ beginDesktop: () => () => {} }),
  };
  return {
    personal: new DesktopPersonal(host),
    host,
    calls,
    input: { client, roomEpoch, agentId: "fish", visitId },
    setHandler: (fn) => {
      handler = fn;
    },
  };
}

test("personal turns use isolated sessions and keep follow-ups scoped to a visit", async () => {
  const f = fixture(),
    marker = "personal-marker-123";
  const first = await f.personal.drop({ ...f.input, text: marker });
  assert.equal(first.status, "completed");
  await f.personal.drop({ ...f.input, text: "继续" });
  assert.match(f.calls[1].prompt, /personal-marker-123/);
  assert.equal(f.calls[0].managedContext, undefined);
  assert.notEqual(f.calls[0].binding.runId, f.calls[1].binding.runId);
  assert.equal(f.personal.history(f.input).messages.length, 4);
  assert.throws(
    () => f.personal.history({ ...f.input, roomEpoch: randomUUID() }),
    /DESKTOP_VISIT_UNAVAILABLE/,
  );
  assert.throws(
    () => f.personal.history({ ...f.input, client: randomUUID() }),
    /DESKTOP_VISIT_UNAVAILABLE/,
  );
  assert.throws(
    () => f.personal.history({ ...f.input, agentId: "other" }),
    /DESKTOP_VISIT_UNAVAILABLE/,
  );
  f.host.live.visits.delete("fish");
  f.personal.sweep();
  assert.equal(f.personal.entries.size, 0);
});

test("a late reply is discarded after the target leaves", async () => {
  const f = fixture();
  let started;
  const ready = new Promise((resolve) => {
    started = resolve;
  });
  f.setHandler(async (params) => {
    await params.onRunStarted();
    started();
    await new Promise((resolve) =>
      params.signal.addEventListener("abort", resolve, { once: true }),
    );
  });
  const pending = f.personal.drop({ ...f.input, text: "private" });
  await ready;
  f.host.live.visits.delete("fish");
  f.personal.sweep();
  await assert.rejects(pending, /DESKTOP_VISIT_UNAVAILABLE/);
  assert.equal(f.personal.entries.size, 0);
});

test("private marker never reaches public desktop input or another role", async (t) => {
  const { config, fixture } = await import("./helpers.mjs");
  const cfg = config(2);
  cfg.desktopHome.enabled = true;
  const { runtime } = fixture(t, { cfg });
  const host = runtime.desktopVisits,
    client = randomUUID(),
    publicInputs = [];
  t.after(() => host.reset());
  host.command({ client, action: "sync", data: true });
  for (const id of ["agent-0", "agent-1"]) {
    const role = host.live.room.roles.find((item) => item.id === id);
    host.live.room.members[id] = "invited";
    host.live.admit(role);
    runtime.backendConnections.adapter(runtime.agent(id)).runDesktop = async (
      params,
    ) => {
      params.beforeInput();
      if (!params.managedContext) {
        await params.onRunStarted();
        await params.callTool("desktop_room_decide", {
          action: "say",
          text: "私密收到",
        });
        return;
      }
      publicInputs.push({ id, prompt: params.prompt });
      params.onInputSubmitted();
      await params.callTool("desktop_room_decide", { action: "silent" });
    };
  }
  const visitId = host.body.visitId(host.live.visits.get("agent-0"));
  const input = {
    client,
    roomEpoch: host.live.room.epoch,
    agentId: "agent-0",
    visitId,
  };
  const marker = "distinct-private-marker-789";
  const summaryMarker = "restricted-summary-marker-123";
  host.observation.summaries.save(
    "agent-0",
    { id: randomUUID(), summary: summaryMarker },
    7,
  );
  const personalInputs = [];
  const original = runtime.backendConnections.adapter(
    runtime.agent("agent-0"),
  ).runDesktop;
  runtime.backendConnections.adapter(runtime.agent("agent-0")).runDesktop =
    async (params) => {
      if (!params.managedContext) personalInputs.push(params.prompt);
      return original(params);
    };
  await host.personal.drop({ ...input, text: marker });
  assert.match(personalInputs[0], /restricted-summary-marker-123/);
  host.command({ client, action: "send", data: "公开消息" });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.ok(publicInputs.length);
  assert.ok(
    publicInputs.every(
      ({ prompt }) =>
        !prompt.includes(marker) && !prompt.includes(summaryMarker),
    ),
  );
  assert.ok(!JSON.stringify(host.roomSnapshot()).includes(marker));
  assert.ok(!JSON.stringify(host.archive.history()).includes(marker));
  const other = {
    ...input,
    agentId: "agent-1",
    visitId: host.body.visitId(host.live.visits.get("agent-1")),
  };
  assert.deepEqual(host.personal.history(other).messages, []);
  const otherInputs = [];
  runtime.backendConnections.adapter(runtime.agent("agent-1")).runDesktop =
    async (params) => {
      otherInputs.push(params.prompt);
      await params.callTool("desktop_room_decide", { action: "silent" });
    };
  await host.personal.drop({ ...other, text: "你好" });
  assert.ok(otherInputs.every((prompt) => !prompt.includes(summaryMarker)));
});

test("image upload requires target image entitlement", async () => {
  const f = fixture();
  f.host.runtime.config.agents[0].files = { enabled: false, receive: false };
  await assert.rejects(
    f.personal.drop({
      ...f.input,
      attachment: {
        name: "picture.png",
        data: Buffer.from("not an image").toString("base64"),
      },
    }),
    /DESKTOP_ATTACHMENT_UNAVAILABLE/,
  );
  assert.equal(f.calls.length, 0);
});

test("personal attachment rejects non-images and mismatched image bytes", async (t) => {
  const { config, fixture } = await import("./helpers.mjs");
  const cfg = config(1);
  cfg.desktopHome.enabled = true;
  cfg.desktopHome.toolRoles = ["agent-0"];
  cfg.agents[0].behavior.imageInput.enabled = true;
  cfg.agents[0].files = {
    ...cfg.agents[0].files,
    enabled: true,
    receive: true,
  };
  const { runtime } = fixture(t, { cfg });
  const host = runtime.desktopVisits,
    client = randomUUID();
  t.after(() => host.reset());
  host.command({ client, action: "sync", data: true });
  const role = host.live.room.roles[0];
  host.live.room.members[role.id] = "invited";
  host.live.admit(role);
  const input = {
    client,
    roomEpoch: host.live.room.epoch,
    agentId: role.id,
    visitId: host.body.visitId(host.live.visits.get(role.id)),
  };
  for (const name of ["notes.txt", "fake.png"]) {
    await assert.rejects(
      host.personal.drop({
        ...input,
        attachment: {
          name,
          data: Buffer.from("plain content").toString("base64"),
        },
      }),
      /DESKTOP_ATTACHMENT_INVALID/,
    );
  }
  assert.deepEqual(host.personal.history(input).messages, []);
});

test("image permission is checked at model input and again before delivery", async (t) => {
  const { readFile } = await import("node:fs/promises");
  const { config, fixture } = await import("./helpers.mjs");
  const cfg = config(1);
  cfg.desktopHome.enabled = true;
  cfg.desktopHome.toolRoles = ["agent-0"];
  cfg.agents[0].behavior.imageInput.enabled = true;
  const { runtime } = fixture(t, { cfg });
  const host = runtime.desktopVisits,
    client = randomUUID();
  t.after(() => host.reset());
  host.command({ client, action: "sync", data: true });
  const role = host.live.room.roles[0];
  host.live.room.members[role.id] = "invited";
  host.live.admit(role);
  const input = {
    client,
    roomEpoch: host.live.room.epoch,
    agentId: role.id,
    visitId: host.body.visitId(host.live.visits.get(role.id)),
    attachment: {
      name: "door.png",
      data: (
        await readFile(
          new URL("art/door.png", new URL("../desktop/home/", import.meta.url)),
        )
      ).toString("base64"),
    },
  };
  const agent = runtime.agent(role.id),
    backend = runtime.backendConnections.adapter(agent);
  backend.runDesktop = async (p) => {
    agent.behavior.imageInput.enabled = false;
    p.beforeInput();
  };
  await assert.rejects(
    host.personal.drop(input),
    /DESKTOP_ATTACHMENT_UNAVAILABLE/,
  );
  agent.behavior.imageInput.enabled = true;
  backend.runDesktop = async (p) => {
    p.beforeInput();
    await p.onRunStarted();
    await p.callTool("desktop_room_decide", { action: "say", text: "收到" });
    agent.behavior.imageInput.maxBytes = 1;
  };
  await assert.rejects(
    host.personal.drop(input),
    /DESKTOP_ATTACHMENT_UNAVAILABLE/,
  );
  assert.deepEqual(
    host.personal.history({
      client,
      roomEpoch: input.roomEpoch,
      agentId: role.id,
      visitId: input.visitId,
    }).messages,
    [],
  );
});

test("temporary blockers cancel active work without deleting private history", async () => {
  const f = fixture();
  await f.personal.drop({ ...f.input, text: "retain" });
  let blocked = false;
  f.host.runtime.blockers = () => (blocked ? ["paused"] : []);
  let started;
  const ready = new Promise((resolve) => {
    started = resolve;
  });
  f.setHandler(async (p) => {
    await p.onRunStarted();
    started();
    await new Promise((resolve) =>
      p.signal.addEventListener("abort", resolve, { once: true }),
    );
  });
  const pending = f.personal.drop({ ...f.input, text: "pending" });
  await ready;
  blocked = true;
  f.personal.sweep();
  await assert.rejects(pending, /DESKTOP_VISIT_UNAVAILABLE/);
  assert.equal(f.personal.history(f.input).messages[0].text, "retain");
});

test("restricted results cannot become public replies or revive a retired session", async (t) => {
  const { config, fixture } = await import("./helpers.mjs");
  const cfg = config(1);
  cfg.desktopHome.enabled = true;
  cfg.desktopHome.toolRoles = ["agent-0"];
  cfg.desktopHome.screenView = { enabled: true };
  cfg.agents[0].behavior.imageInput.enabled = true;
  const { runtime } = fixture(t, { cfg });
  const host = runtime.desktopVisits;
  const client = randomUUID();
  t.after(() => host.reset());
  host.command({ client, action: "sync", data: true });
  const role = host.live.room.roles[0];
  host.live.room.members[role.id] = "invited";
  host.live.admit(role);
  const grant = {
    roomEpoch: host.live.room.epoch,
    grantId: randomUUID(),
    agentId: role.id,
  };
  host.screen.change(false, grant);
  const marker = "restricted-frame-derived-marker";
  const memory = runtime.memory.bind(role.id);
  memory.setState("@desktop", {
    ...memory.state("@desktop"),
    session: { backend: "codex", id: "old-public-session" },
  });
  let saveLate;
  runtime.backendConnections.adapter(runtime.agent(role.id)).runDesktop =
    async (params) => {
      assert.equal(params.managedContext.session, null);
      saveLate = params.managedContext.saveSession;
      saveLate({ backend: "codex", id: "restricted-session" });
      const ctx = runtime.capabilities.get(params.socialContextToken);
      ctx.desktopScreenObserved = true;
      ctx.recordDesktopRestrictedGrant(
        "desktop_screen_view",
        host.screen.grantFor(role.id),
        host.screen,
      );
      params.onInputSubmitted();
      await params.callTool("desktop_room_decide", {
        action: "say",
        text: marker,
      });
    };
  const result = await host.run(
    { actor: role.id, kind: "chat", people: [], messages: [] },
    new AbortController().signal,
  );
  assert.equal(result.action, "silent");
  const privateHistory = host.personal.history({
    client,
    roomEpoch: host.live.room.epoch,
    agentId: role.id,
    visitId: host.body.visitId(host.live.visits.get(role.id)),
  });
  assert.ok(JSON.stringify(privateHistory).includes(marker));
  assert.equal(memory.state("@desktop").session, null);
  saveLate({ backend: "codex", id: "late-restricted-session" });
  assert.equal(memory.state("@desktop").session, null);
  assert.ok(!JSON.stringify(host.archive.history()).includes(marker));
  assert.ok(!JSON.stringify(host.roomSnapshot()).includes(marker));
  host.screen.change(true, grant);
  const afterRevocation = host.personal.history({
    client,
    roomEpoch: host.live.room.epoch,
    agentId: role.id,
    visitId: host.body.visitId(host.live.visits.get(role.id)),
  });
  assert.ok(!JSON.stringify(afterRevocation).includes(marker));
});

for (const source of ["screen", "native", "browser"]) {
  for (const transition of ["valid", "revoked", "replaced"]) {
    test(`${source} restricted reply uses its original grant after ${transition}`, async (t) => {
      const { config, fixture } = await import("./helpers.mjs");
      const cfg = config(1);
      cfg.desktopHome.enabled = true;
      const { runtime } = fixture(t, { cfg });
      const host = runtime.desktopVisits;
      const client = randomUUID();
      t.after(() => host.reset());
      host.command({ client, action: "sync", data: true });
      const role = host.live.room.roles[0];
      host.live.room.members[role.id] = "invited";
      host.live.admit(role);
      const access = host[source];
      const original = { agentId: role.id };
      let active = original;
      access.grantFor = () => active;
      access.current = (grant) => grant === active;
      const marker = `restricted-${source}-${transition}`;
      runtime.backendConnections.adapter(runtime.agent(role.id)).runDesktop =
        async (params) => {
          const ctx = runtime.capabilities.get(params.socialContextToken);
          if (source === "screen") ctx.desktopScreenObserved = true;
          else {
            ctx.desktopPrivateObservation = true;
            if (source === "browser") ctx.desktopBrowserObserved = true;
          }
          const name = {
            screen: "desktop_screen_view",
            native: "desktop_native_control",
            browser: "desktop_browser_control",
          }[source];
          ctx.recordDesktopRestrictedGrant(name, original, access);
          params.onInputSubmitted();
          if (transition === "revoked") active = null;
          if (transition === "replaced") active = { agentId: role.id };
          await params.callTool("desktop_room_decide", {
            action: "say",
            text: marker,
          });
        };
      const result = await host.run(
        { actor: role.id, kind: "chat", people: [], messages: [] },
        new AbortController().signal,
      );
      assert.equal(result.action, "silent");
      const history = host.personal.history({
        client,
        roomEpoch: host.live.room.epoch,
        agentId: role.id,
        visitId: host.body.visitId(host.live.visits.get(role.id)),
      });
      assert.equal(
        JSON.stringify(history).includes(marker),
        transition === "valid",
      );
      assert.ok(!JSON.stringify(host.roomSnapshot()).includes(marker));
      assert.ok(!JSON.stringify(host.archive.history()).includes(marker));
    });
  }
}

test("private follow-up retains original grant dependency despite concurrent sweep", async () => {
  const f = fixture();
  f.host.notify = () => {};
  let granted = true;
  f.personal.recordRestricted("fish", "restricted-source", () => granted);
  const ready = Promise.withResolvers();
  const resume = Promise.withResolvers();
  f.setHandler(async (params) => {
    await params.onRunStarted();
    ready.resolve();
    await resume.promise;
    await params.callTool("desktop_room_decide", {
      action: "say",
      text: "derived-late",
    });
  });
  const turn = f.personal.drop({ ...f.input, text: "question" });
  await ready.promise;
  granted = false;
  f.personal.sweep();
  resume.resolve();
  await assert.rejects(turn, /DESKTOP_VISIT_UNAVAILABLE/);
  assert.ok(
    !JSON.stringify(f.personal.history(f.input)).includes("derived-late"),
  );
});

test("private follow-up reply inherits source grant while user input does not", async () => {
  const f = fixture();
  f.host.notify = () => {};
  let granted = true;
  f.personal.recordRestricted("fish", "restricted-source", () => granted);
  await f.personal.drop({ ...f.input, text: "ordinary-question" });
  granted = false;
  const history = JSON.stringify(f.personal.history(f.input));
  assert.ok(history.includes("ordinary-question"));
  assert.ok(!history.includes("restricted-source"));
  assert.ok(!history.includes("收到"));
});

test("revoking an unused source does not discard a different source's reply", async (t) => {
  const { config, fixture } = await import("./helpers.mjs");
  const cfg = config(1);
  cfg.desktopHome.enabled = true;
  const { runtime } = fixture(t, { cfg });
  const host = runtime.desktopVisits;
  const client = randomUUID();
  t.after(() => host.reset());
  host.command({ client, action: "sync", data: true });
  const role = host.live.room.roles[0];
  host.live.room.members[role.id] = "invited";
  host.live.admit(role);
  const screenGrant = { agentId: role.id },
    browserGrant = { agentId: role.id };
  let browserCurrent = true;
  host.screen.grantFor = () => screenGrant;
  host.screen.current = (grant) => grant === screenGrant;
  host.browser.grantFor = () => browserGrant;
  host.browser.current = (grant) => grant === browserGrant && browserCurrent;
  runtime.backendConnections.adapter(runtime.agent(role.id)).runDesktop =
    async (params) => {
      const ctx = runtime.capabilities.get(params.socialContextToken);
      ctx.desktopScreenObserved = true;
      ctx.recordDesktopRestrictedGrant(
        "desktop_screen_view",
        screenGrant,
        host.screen,
      );
      params.onInputSubmitted();
      browserCurrent = false;
      await params.callTool("desktop_room_decide", {
        action: "say",
        text: "valid-screen-result",
      });
    };
  await host.run(
    { actor: role.id, kind: "chat", people: [], messages: [] },
    new AbortController().signal,
  );
  const history = host.personal.history({
    client,
    roomEpoch: host.live.room.epoch,
    agentId: role.id,
    visitId: host.body.visitId(host.live.visits.get(role.id)),
  });
  assert.ok(JSON.stringify(history).includes("valid-screen-result"));
});

test("private follow-ups flatten and deduplicate grant dependencies", async () => {
  const f = fixture();
  f.host.notify = () => {};
  let checks = 0;
  f.personal.recordRestricted("fish", "restricted-source", () => {
    checks++;
    return true;
  });
  for (let i = 0; i < 15; i++)
    await f.personal.drop({ ...f.input, text: `question-${i}` });
  assert.ok(checks < 3000, `unexpected repeated dependency checks: ${checks}`);
  const history = f.personal.history(f.input);
  assert.ok(
    history.messages.every((message) =>
      Object.keys(message).every((key) => ["role", "text"].includes(key)),
    ),
  );
  assert.ok(
    f.calls.every(
      ({ prompt }) =>
        !prompt.includes("current") && !prompt.includes("Dependencies"),
    ),
  );
  const last = history.messages.at(-1);
  assert.equal(f.personal.messageDependencies.get(last).length, 1);
});
