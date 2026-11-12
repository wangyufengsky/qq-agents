import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { createServer } from "../src/server.mjs";
import { desktopToken } from "../src/home/desktop-auth.mjs";
import { config, fixture, raw, settle } from "./helpers.mjs";

const check = () => new Promise(setImmediate);

test("management policy drives the authenticated desktop room and hot revocation", async (t) => {
  const qq = [];
  const f = fixture(t, {
    cfg: config(1),
    run: async (p) => qq.push(p.conversation),
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
    const context = p.managedContext;
    const session = context.session ?? {
      backend: "codex",
      id: "fixture-" + randomUUID(),
    };
    if (!context.session) context.saveSession(session);
    sessions.push(session.id);
    if (p.prompt.includes("管理员邀请"))
      return p.callTool("desktop_room_decide", { action: "accept" });
    await new Promise((resolve) => pending.push({ resolve, signal: p.signal }));
    p.signal.throwIfAborted();
    p.callTool("desktop_room_decide", { action: "say", text: "桌面回复" });
  };
  assert.equal((await command("sync")).room.maxTurns, 3);
  assert.equal(
    (await command("sync", undefined, desktopToken(token), randomUUID())).busy,
    true,
  );
  await command("invite", "agent-0");
  await check();
  assert.equal((await command("sync")).room.roles[0].state, "here");
  await command("send", "本地桌面消息");
  assert.equal(pending.length, 1);
  assert(sessions[0]);
  assert.equal(sessions[1], sessions[0]);
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
  assert.equal(sessions.length, 2);
  assert.equal(
    f.store.bind("agent-0").state("@desktop").session.id,
    sessions[0],
  );
  await command("send", "新桌面消息");
  assert.equal(sessions[2], sessions[0]);
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

test("desktop reconnects with a stored session and uses normal context retirement", async (t) => {
  const cfg = config(1);
  cfg.desktopHome.enabled = true;
  const f = fixture(t, { cfg });
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
    const action = p.prompt.includes("管理员邀请") ? "accept" : "silent";
    await p.callTool("desktop_room_decide", { action });
  };
  const first = randomUUID(),
    second = randomUUID();
  host.command({ client: first, action: "sync" });
  host.command({ client: first, action: "invite", data: "agent-0" });
  await drain();
  assert.equal(memory.state("@desktop").session.id, "desktop-1");
  host.command({ client: first, action: "disconnect" });
  host.command({ client: second, action: "sync" });
  host.command({ client: second, action: "invite", data: "agent-0" });
  await drain();
  assert.deepEqual(refs, ["desktop-1", "desktop-1"]);
  assert.equal(host.live.room.members["agent-0"], "here");
  fill = true;
  host.command({ client: second, action: "send", data: "使用接近容量" });
  await drain();
  assert.equal(refs.length, 3);
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
