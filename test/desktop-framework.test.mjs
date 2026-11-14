import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { createServer } from "../src/server.mjs";
import { validateConfig } from "../src/core/config.mjs";
import { desktopToken } from "../src/home/desktop-auth.mjs";
import { config, fixture, raw, settle } from "./helpers.mjs";

const check = () => new Promise(setImmediate);
const invitationId = (prompt) =>
  /"desktopInvitation":\{"id":"([a-f0-9-]+)"/.exec(prompt)?.[1];
const acceptInvitation = (p) =>
  p.callTool("desktop_invitation_decide", {
    id: invitationId(p.prompt),
    action: "accept",
  });

test("management policy drives the authenticated desktop room and hot revocation", async (t) => {
  const qq = [];
  let qqActivity;
  const cfg = config(1);
  cfg.agents[0].subject.enabled = true;
  const f = fixture(t, {
    cfg,
    run: async (p) => {
      if (p.conversation === "@subject") return acceptInvitation(p);
      qq.push(p.conversation);
      qqActivity = f.runtime.desktopVisits.command({ client, action: "sync" })
        .room.roles[0].activity;
    },
  });
  const token = randomBytes(32).toString("hex");
  const app = createServer({ runtime: f.runtime, token, allowLive: true });
  t.after(() => app.close());
  const base = `http://127.0.0.1:${await app.listen()}`;
  const client = randomUUID();
  const act = (action, data, key = desktopToken(token), id = client) =>
    fetch(base + "/api/desktop-home/client", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-desktop-home-token": key,
      },
      body: JSON.stringify({ client: id, action, data }),
    });
  const command = async (...args) => (await act(...args)).json();
  const setPolicy = async (desktopHome) => {
    const headers = {
      "x-admin-token": token,
      "content-type": "application/json",
    };
    const current = await fetch(base + "/api/config", { headers }).then((r) =>
      r.json(),
    );
    const response = await fetch(base + "/api/config", {
      method: "PUT",
      headers,
      body: JSON.stringify({
        config: { ...current.config, desktopHome },
        revision: current.revision,
      }),
    });
    assert.equal(response.status, 200);
  };
  assert.equal((await act("sync", undefined, token)).status, 401);
  assert.equal(
    (
      await fetch(base + "/api/config", {
        headers: { "x-admin-token": desktopToken(token) },
      })
    ).status,
    401,
  );
  assert.deepEqual(await command("sync"), { enabled: false, closed: true });
  await setPolicy({ enabled: true, maxTurns: 3, refreshMinutes: 2 });
  const backend = f.runtime.backendConnections.adapter(
    f.runtime.agent("agent-0"),
  );
  const pending = [];
  const sessions = [];
  backend.runDesktop = async (p) => {
    p.beforeInput();
    p.onInputSubmitted?.();
    const context = p.managedContext;
    const session = context.session ?? {
      backend: "codex",
      id: "fixture-" + randomUUID(),
    };
    if (!context.session) context.saveSession(session);
    sessions.push(session.id);
    await new Promise((resolve) => pending.push({ resolve, signal: p.signal }));
    p.signal.throwIfAborted();
    await p.callTool("desktop_room_decide", {
      action: "say",
      text: "桌面回复",
    });
  };
  assert.equal((await command("sync")).room.maxTurns, 3);
  assert.equal(
    (await command("sync", undefined, desktopToken(token), randomUUID())).busy,
    true,
  );
  await command("invite", "agent-0");
  await check();
  assert.equal((await command("sync")).room.roles[0].state, "here");
  assert.equal(sessions.length, 0);
  await command("send", "本地桌面消息");
  assert.equal(pending.length, 1);
  assert.equal((await command("sync")).room.roles[0].activity, "chat");
  assert(sessions[0]);
  pending[0].resolve();
  await check();
  const replied = (await command("sync")).room;
  assert.equal(replied.budget, 2);
  assert.equal(replied.minutes, 2);
  assert(replied.messages.some(({ text }) => text === "桌面回复"));
  await setPolicy({ enabled: true, maxTurns: 5, refreshMinutes: 0 });
  const updated = (await command("sync")).room;
  assert.equal(updated.roles[0].state, "here");
  assert.equal(updated.maxTurns, 5);
  assert.equal(updated.nextRefill, null);
  const claim = f.runtime.desktopVisits.claimQq("agent-0", "private:30000");
  assert(claim);
  await command("send", "QQ 优先时的桌面消息");
  await check();
  claim.release();
  assert.equal(sessions.length, 1);
  assert.equal(
    f.store.bind("agent-0").state("@desktop").session.id,
    sessions[0],
  );
  await command("send", "新桌面消息");
  assert.equal(sessions[1], sessions[0]);
  await f.runtime.ingest(
    "qq-0",
    raw(22, {
      group_id: undefined,
      message_type: "private",
      sub_type: "friend",
    }),
  );
  assert.equal(pending[1].signal.aborted, true);
  assert.equal(qq.length, 0);
  pending[1].resolve();
  await settle(f.runtime);
  assert.deepEqual(qq, ["private:30000"]);
  assert.equal(qqActivity, "qq");
  assert.equal((await command("sync")).room.roles[0].state, "here");
  await setPolicy({ enabled: false, maxTurns: 5, refreshMinutes: 0 });
  assert.deepEqual(await command("sync"), { enabled: false, closed: true });
  assert.equal(
    f.store.bind("agent-0").state("@desktop").lifecycle.reason,
    "cancelled",
  );
});

test("only the local administrator can launch and close the desktop window", async (t) => {
  const f = fixture(t, { cfg: config(1) });
  const token = randomBytes(32).toString("hex");
  const starts = [];
  const launcher = {
    state: "idle",
    open(port) {
      starts.push(port);
      this.state = "opening";
    },
    connected() {
      this.state = "open";
    },
    cancel() {
      this.state = "idle";
    },
  };
  const server = createServer({
    runtime: f.runtime,
    token,
    allowLive: true,
    desktopLauncher: launcher,
  });
  t.after(() => server.close());
  const port = await server.listen();
  const base = "http://127.0.0.1:" + port;
  const control = (enabled, key = token, origin = base) =>
    fetch(base + "/api/desktop-home", {
      method: "POST",
      headers: {
        "x-admin-token": key,
        "content-type": "application/json",
        origin,
      },
      body: JSON.stringify({ enabled }),
    });
  assert.equal((await control(true, "")).status, 401);
  assert.equal((await control(true, desktopToken(token))).status, 401);
  assert.equal((await control(true, token, "http://example.test")).status, 403);
  assert.equal(f.runtime.config.desktopHome.enabled, false);
  assert.deepEqual(starts, []);
  assert.deepEqual(await (await control(true)).json(), {
    enabled: true,
    canLaunch: true,
    window: "opening",
  });
  assert.deepEqual(starts, [port]);
  const client = randomUUID();
  const sync = () =>
    fetch(base + "/api/desktop-home/client", {
      method: "POST",
      headers: {
        "x-desktop-home-token": desktopToken(token),
        "content-type": "application/json",
      },
      body: JSON.stringify({ client, action: "sync" }),
    }).then((response) => response.json());
  assert.equal((await sync()).room.maxTurns, 6);
  assert.equal((await (await control(true)).json()).window, "open");
  assert.deepEqual(starts, [port]);
  assert.deepEqual(await (await control(false)).json(), {
    enabled: false,
    canLaunch: true,
    window: "idle",
  });
  assert.deepEqual(await sync(), { enabled: false, closed: true });
  assert.equal(f.runtime.config.desktopHome.enabled, false);
});

test("administrator invitations wait for the subject and fence cancelled decisions", async (t) => {
  const cfg = config(1);
  cfg.desktopHome.enabled = true;
  cfg.agents[0].subject.enabled = true;
  const turns = [];
  const f = fixture(t, {
    cfg,
    run: async (p) => {
      const gate = Promise.withResolvers();
      turns.push({ gate, p });
      const action = await gate.promise;
      if (action) {
        await p.callTool("desktop_invitation_decide", {
          id: invitationId(p.prompt),
          action,
        });
      }
    },
  });
  let now = Date.now();
  f.runtime.clock = () => new Date(now);
  t.after(() => {
    for (const { gate } of turns) gate.resolve();
  });
  const host = f.runtime.desktopVisits;
  const client = randomUUID();
  const command = (action, data) => host.command({ client, action, data });
  const member = () => command("sync").room.roles[0].state;
  const drain = async () => {
    await Promise.allSettled([...f.runtime.work]);
    await check();
  };
  command("sync");
  const busy = f.runtime.wake("agent-0", "@subject");
  await check();
  command("invite", "agent-0");
  assert.equal(member(), "invited");
  assert.equal(turns.length, 1);
  assert.equal(invitationId(turns[0].p.prompt), undefined);
  turns[0].gate.resolve();
  await busy;
  command("sync");
  await check();
  assert.equal(turns[1].p.conversation, "@subject");
  assert(invitationId(turns[1].p.prompt));

  command("invite", "agent-0");
  await check();
  assert.equal(member(), "home");
  await assert.rejects(
    acceptInvitation(turns[1].p),
    /DESKTOP_VISIT_UNAVAILABLE/,
  );
  turns[1].gate.resolve();
  await drain();

  command("invite", "agent-0");
  await check();
  turns[2].gate.resolve("decline");
  await drain();
  assert.equal(member(), "home");

  command("invite", "agent-0");
  await check();
  assert(invitationId(turns[3].p.prompt));
  for (let index = 0; index < 30; index++) {
    now += 10_000;
    command("sync");
  }
  await check();
  assert.equal(member(), "home");
  await assert.rejects(
    acceptInvitation(turns[3].p),
    /DESKTOP_VISIT_UNAVAILABLE/,
  );
  turns[3].gate.resolve();
  await drain();
  assert.equal(command("sync").room.budget, 6);
  assert.equal(f.store.bind("agent-0").state("@desktop").session, undefined);
});

test("desktop reconnects with a stored session and uses normal context retirement", async (t) => {
  const cfg = config(1);
  cfg.desktopHome.enabled = true;
  cfg.agents[0].subject.enabled = true;
  const f = fixture(t, { cfg, run: acceptInvitation });
  const host = f.runtime.desktopVisits;
  const memory = f.store.bind("agent-0");
  const backend = f.runtime.backendConnections.adapter(
    f.runtime.agent("agent-0"),
  );
  const drain = async () => {
    await Promise.allSettled([...f.runtime.work]);
    await check();
  };
  let count = 0;
  let fill = false;
  const refs = [];
  backend.runDesktop = async (p) => {
    p.beforeInput();
    p.onInputSubmitted?.();
    const context = p.managedContext;
    const session = context.session ?? {
      backend: "codex",
      id: "desktop-" + ++count,
    };
    context.saveSession(session);
    refs.push(session.id);
    if (fill)
      context.onUsage({
        source: "measured",
        contextTokens: 99_000,
        capacityTokens: 100_000,
      });
    await p.callTool("desktop_room_decide", { action: "silent" });
  };
  const first = randomUUID(),
    second = randomUUID();
  host.command({ client: first, action: "sync" });
  host.command({ client: first, action: "invite", data: "agent-0" });
  await drain();
  assert.equal(memory.state("@desktop").session, undefined);
  host.command({ client: first, action: "send", data: "第一轮桌边聊天" });
  await drain();
  assert.equal(memory.state("@desktop").session.id, "desktop-1");
  host.command({ client: first, action: "disconnect" });
  host.command({ client: second, action: "sync" });
  host.command({ client: second, action: "invite", data: "agent-0" });
  await drain();
  assert.deepEqual(refs, ["desktop-1"]);
  assert.equal(host.live.room.members["agent-0"], "here");
  fill = true;
  host.command({ client: second, action: "send", data: "使用接近容量" });
  await drain();
  assert.deepEqual(refs, ["desktop-1", "desktop-1"]);
  const retired = memory.state("@desktop");
  assert.equal(retired.session, null);
  assert.equal(retired.lifecycle.reason, "capacity-guard");
  assert(
    memory.identity
      .list("session_history")
      .some(
        (row) =>
          row.session.id === "desktop-1" && row.reason === "capacity-guard",
      ),
  );
  fill = false;
  host.command({ client: second, action: "send", data: "继续聊天" });
  await drain();
  assert.equal(memory.state("@desktop").session.id, "desktop-2");
});

test("desktop portraits follow backend models and rest follows the role clock", (t) => {
  const cfg = config(3);
  cfg.desktopHome.enabled = true;
  const [first, second, third] = cfg.agents;
  const base = cfg.backends[0];
  cfg.backends = [
    {
      ...base,
      id: "deep",
      type: "dsh",
      preset: "qq-unified",
      model: "deepseek-v4",
    },
    { ...base, id: "code", type: "codex", model: "gpt-5.4" },
    {
      ...base,
      id: "google",
      type: "antigravity",
      command: "agy",
      model: "gemini-3-pro",
    },
  ];
  Object.assign(first, { id: "dragon", backendId: "deep" });
  Object.assign(second, { id: "cat", backendId: "code" });
  Object.assign(third, {
    id: "fish",
    backendId: "google",
    model: "models/gemini-3-flash",
  });
  first.behavior.rhythm = {
    enabled: true,
    timezone: "Asia/Shanghai",
    sleep: { start: "23:00", end: "07:00" },
  };
  const { runtime } = fixture(t, { cfg: validateConfig(cfg) });
  let now = "2026-11-12T18:00:00Z";
  runtime.clock = () => new Date(now);
  const host = runtime.desktopVisits;
  const client = randomUUID();
  const sync = () => host.command({ client, action: "sync" }).room.roles;
  const roles = sync();
  assert.deepEqual(
    roles.map(({ id, art, activity }) => [id, art, activity]),
    [
      ["dragon", "fish", "sleep"],
      ["cat", "dragon", "idle"],
      ["fish", "cat", "idle"],
    ],
  );
  now = "2026-11-13T00:00:00Z";
  assert.equal(sync()[0].activity, "idle");
});

test("always-welcome admits completed subject visits independently without a knock or chat charge", async (t) => {
  const cfg = config(3);
  cfg.desktopHome.enabled = true;
  for (const agent of cfg.agents) agent.subject.enabled = true;
  const switchReady = Promise.withResolvers();
  const switchDone = Promise.withResolvers();
  t.after(switchDone.resolve);
  const { runtime } = fixture(t, {
    cfg,
    run: async (p) => {
      if (p.conversation !== "@subject") return;
      const result = await p.callTool("desktop_visit_request", {});
      assert.equal(result.status, "requested");
      if (!p.prompt.includes("随时欢迎")) return;
      assert(p.prompt.includes("直接入场"));
      if (p.agent.id === "agent-1") {
        switchReady.resolve();
        await switchDone.promise;
      }
    },
  });
  const host = runtime.desktopVisits;
  const client = randomUUID();
  const command = (action, data) => host.command({ client, action, data });
  assert.equal(command("sync").room.doorMode, "off");
  command("door-mode", "always");
  await runtime.wake("agent-0", "@subject");
  let room = command("sync").room;
  assert.equal(room.roles[0].state, "here");
  assert.equal(room.knock, null);
  assert.equal(room.budget, room.maxTurns);
  const first = host.live.visits.get("agent-0");
  assert(first);
  const pending = runtime.wake("agent-1", "@subject");
  assert.equal(
    await Promise.race([switchReady.promise.then(() => "ready"), pending]),
    "ready",
  );
  assert.equal(command("sync").room.roles[1].state, "home");
  command("door-mode", "welcome");
  switchDone.resolve();
  await pending;
  room = command("sync").room;
  assert.equal(room.roles[1].state, "home");
  assert.equal(room.knock, null);

  await runtime.wake("agent-2", "@subject");
  assert.equal(command("sync").room.knock.actor, "agent-2");
  assert.equal(command("sync").room.roles[2].state, "home");
  command("door-mode", "always");
  command("knock-answer", true);
  assert.equal(command("sync").room.roles[2].state, "home");
  runtime.now = () => Date.now() + 31 * 60_000;
  host.client.expiresAt = runtime.now() + 15_000;
  await runtime.wake("agent-2", "@subject");
  room = command("sync").room;
  assert.deepEqual(
    room.roles.map(({ state }) => state),
    ["here", "home", "here"],
  );
  assert.equal(room.knock, null);
  assert.equal(room.budget, room.maxTurns);
  assert.equal(host.live.visits.get("agent-0"), first);
  const newcomer = host.live.visits.get("agent-2");
  assert.equal(newcomer.startCursor, newcomer.cursor);
});

test("always-welcome respects desktop pause and invalidates requests across disconnect", async (t) => {
  const cfg = config(1);
  cfg.desktopHome.enabled = true;
  cfg.agents[0].subject.enabled = true;
  let disconnect = false;
  const { runtime, store } = fixture(t, {
    cfg,
    run: async (p) => {
      const result = await p.callTool("desktop_visit_request", {});
      assert.equal(result.status, "requested");
      if (disconnect) {
        command("disconnect");
        command("sync");
        command("door-mode", "always");
      }
    },
  });
  const client = randomUUID();
  const command = (action, data) =>
    runtime.desktopVisits.command({ client, action, data });
  const epoch = command("sync").room.roomEpoch;
  command("door-mode", "always");
  store.bind("agent-0").setState("@desktop", { paused: true });
  await runtime.wake("agent-0", "@subject");
  assert.equal(command("sync").room.roles[0].state, "home");
  store.bind("agent-0").setState("@desktop", { paused: false });
  runtime.now = () => Date.now() + 31 * 60_000;
  runtime.desktopVisits.client.expiresAt = runtime.now() + 15_000;
  disconnect = true;
  await runtime.wake("agent-0", "@subject");
  const { room } = command("sync");
  assert.notEqual(room.roomEpoch, epoch);
  assert.equal(room.roles[0].state, "home");
  assert.equal(room.knock, null);
});
