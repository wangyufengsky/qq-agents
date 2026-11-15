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
    config: { agents: [agent], backends: [] },
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
  await host.personal.drop({ ...input, text: marker });
  host.command({ client, action: "send", data: "公开消息" });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.ok(publicInputs.length);
  assert.ok(publicInputs.every(({ prompt }) => !prompt.includes(marker)));
  assert.ok(!JSON.stringify(host.roomSnapshot()).includes(marker));
  assert.ok(!JSON.stringify(host.archive.history()).includes(marker));
  const other = {
    ...input,
    agentId: "agent-1",
    visitId: host.body.visitId(host.live.visits.get("agent-1")),
  };
  assert.deepEqual(host.personal.history(other).messages, []);
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
