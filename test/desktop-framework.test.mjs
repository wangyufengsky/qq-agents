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
  const closed = [];
  backend.runDesktop = async (p) => {
    p.beforeInput();
    if (!p.binding.windowId)
      return p.callTool("desktop_room_decide", { action: "accept" });
    await new Promise((resolve) => pending.push({ resolve, signal: p.signal }));
    p.signal.throwIfAborted();
    p.callTool("desktop_room_decide", { action: "say", text: "桌面回复" });
  };
  backend.closeSocialSessions = async ({ windowId }) => closed.push(windowId);
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
  await command("send", "新桌面消息");
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
  assert(closed.length > 0);
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
