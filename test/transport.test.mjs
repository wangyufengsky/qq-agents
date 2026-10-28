import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { EventEmitter } from "node:events";
import { WebSocketServer } from "ws";
import { OneBot, normalizeEvent } from "../src/transport/onebot.mjs";
import { Lifecycle } from "../src/transport/lifecycle.mjs";
import { MediaStore } from "../src/tools/media.mjs";
import { ExternalTools } from "../src/backends/external.mjs";
import { temp, config, raw, fixture, context } from "./helpers.mjs";
async function onebot(t, { account = 10000, rejectSend = false } = {}) {
  const calls = [],
    server = http.createServer(async (req, res) => {
      let b = "";
      for await (const c of req) b += c;
      calls.push({ path: req.url, body: JSON.parse(b || "{}") });
      res.setHeader("content-type", "application/json");
      const data =
        req.url === "/get_login_info"
          ? { user_id: account }
          : req.url === "/get_status"
            ? { online: true, good: true }
            : { message_id: 40000 };
      res.end(
        JSON.stringify(
          rejectSend && req.url.startsWith("/send_")
            ? { status: "failed", retcode: 100 }
            : { status: "ok", retcode: 0, data },
        ),
      );
    });
  const ws = new WebSocketServer({ server });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  const c = {
    ...config().connections[0],
    httpUrl: `http://127.0.0.1:${port}`,
    wsUrl: `ws://127.0.0.1:${port}`,
  };
  t.after(async () => {
    ws.clients.forEach((c) => c.terminate());
    await new Promise((r) => ws.close(r));
    await new Promise((r) => server.close(r));
  });
  return { c, calls, ws };
}
test("OneBot HTTP/WS fixture verifies identity, receives event and sends literal structured segments", async (t) => {
  const { c, calls, ws } = await onebot(t),
    bot = new OneBot(c);
  t.after(() => bot.close());
  await bot.connect();
  const event = new Promise((r) => bot.once("event", r));
  ws.clients.forEach((s) => s.send(JSON.stringify(raw())));
  assert.equal((await event).message_id, 1);
  const result = await bot.send("group:20000", [
    { type: "text", data: { text: "[CQ:at,qq=30000] literal" } },
  ]);
  assert.equal(result.messageId, "40000");
  const sent = calls.find((x) => x.path === "/send_group_msg").body;
  assert.equal(sent.auto_escape, true);
  assert.equal(sent.message[0].type, "text");
});
test("OneBot reports a dropped websocket and can connect again", async (t) => {
  const { c, ws } = await onebot(t),
    bot = new OneBot(c),
    faults = [];
  t.after(() => bot.close());
  bot.on("fault", (code) => faults.push(code));
  await bot.connect();
  const down = new Promise((r) => bot.once("status", r));
  ws.clients.forEach((s) => s.terminate());
  await down;
  assert.equal(bot.connected, false);
  assert.deepEqual(faults, ["CONNECTION_LOST"]);
  await bot.connect();
  assert.equal(bot.connected, true);
  // Replacing a live socket must not report it lost or mark the new one down.
  await bot.connect();
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(bot.connected, true);
  assert.deepEqual(faults, ["CONNECTION_LOST"]);
});

test("OneBot cancels a pending socket and ignores stale callbacks while persistently handling errors", async () => {
  const sockets = [],
    created = [];
  class Socket extends EventEmitter {
    constructor() {
      super();
      sockets.push(this);
      created.shift()?.();
    }
    close() {
      this.emit("close");
    }
  }
  const bot = new OneBot(config(1).connections[0], {
    WebSocketImpl: Socket,
    fetchImpl: async (url) =>
      new Response(
        JSON.stringify({
          status: "ok",
          retcode: 0,
          data: url.endsWith("get_login_info")
            ? { user_id: 10000 }
            : { online: true },
        }),
      ),
  });
  const opened = new Promise((resolve) => created.push(resolve));
  const pending = bot.connect();
  const cancelled = assert.rejects(pending, /CONNECTION_CANCELLED/);
  await opened;
  bot.close();
  sockets[0].emit("open");
  await cancelled;
  assert.equal(bot.connected, false);
  const nextSocket = new Promise((resolve) => created.push(resolve));
  const next = bot.connect();
  await nextSocket;
  sockets[1].emit("open");
  await next;
  const faults = [];
  bot.on("fault", (code) => faults.push(code));
  sockets[1].emit("error", Error("synthetic first error"));
  assert.equal(bot.connected, false);
  assert.deepEqual(faults, ["ONEBOT_WS_ERROR"]);
  assert.doesNotThrow(() =>
    sockets[1].emit("error", Error("synthetic second error")),
  );
  bot.close();
});
test("OneBot refuses a different logged-in account before websocket connection", async (t) => {
  const { c } = await onebot(t, { account: 999 });
  const bot = new OneBot(c);
  await assert.rejects(bot.connect(), /MISMATCH/);
  assert.equal(bot.connected, false);
  bot.close();
});
test("OneBot API failure is not interpreted as a successful send", async (t) => {
  const { c } = await onebot(t, { rejectSend: true }),
    bot = new OneBot(c);
  await assert.rejects(
    bot.send("private:30000", [{ type: "text", data: { text: "test" } }]),
    /REJECTED/,
  );
  bot.close();
});

test("OneBot preserves sanitized packet capability rejection without leaking gateway details", async () => {
  for (const [detail, reason] of [
    ["packetBackend不可用：已禁用PacketBackend", "PACKET_BACKEND_DISABLED"],
    ["packetBackend发包能力不可用", "PACKET_BACKEND_UNAVAILABLE"],
  ]) {
    const bot = new OneBot(config().connections[0], {
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            status: "failed",
            retcode: 400,
            message: detail + " private-runtime-detail",
          }),
        ),
    });
    await assert.rejects(
      bot.call("send_poke", { user_id: 30000 }),
      (e) =>
        e.message === "ONEBOT_REJECTED" &&
        e.reason === reason &&
        !JSON.stringify(e).includes("private-runtime-detail"),
    );
  }
});
test("normalization retains original segments and recalled message identity", () => {
  const e = normalizeEvent(
    raw(12, { post_type: "notice", notice_type: "group_recall" }),
    config().connections[0],
  );
  assert.equal(e.messageId, "12");
  assert.equal(e.status, "recalled");
  assert.equal(e.conversation, "group:20000");
});
test("native lifecycle only stops a process spawned by this manager, without shell expansion", async (t) => {
  const root = temp(t),
    calls = [];
  let child;
  const lifecycle = new Lifecycle(root, {
    spawnProcess: (command, args, options) => {
      calls.push({ command, args, options });
      child = new EventEmitter();
      child.exitCode = null;
      child.kill = (signal) => {
        calls.push({ signal });
        child.exitCode = 0;
        child.emit("exit");
      };
      queueMicrotask(() => child.emit("spawn"));
      return child;
    },
  });
  const c = {
    id: "qq-new",
    deployment: "native",
    process: { command: "fixture-qq", args: ["literal;$(ignored)"], env: {} },
  };
  await lifecycle.start(c);
  assert.equal(calls[0].options.shell, false);
  assert.ok(calls[0].options.cwd.startsWith(root));
  await assert.rejects(lifecycle.stop("unowned"), /NOT_OWNED/);
  await lifecycle.stop(c.id);
  assert.equal(calls[1].signal, "SIGTERM");
});
test("Docker lifecycle requires ownership label and never removes containers or volumes", async (t) => {
  const root = temp(t),
    calls = [];
  let labeled = false;
  const manager = new Lifecycle(root, {
    execCommand: async (command, args) => {
      calls.push({ command, args });
      return {
        stdout:
          args[0] === "inspect"
            ? JSON.stringify(
                labeled ? { "qq-bridge-unified.instance": "qq-a" } : {},
              )
            : "",
      };
    },
  });
  const c = { id: "qq-a", deployment: "docker", container: "test-container" };
  await assert.rejects(manager.start(c), /OWNERSHIP/);
  assert.ok(!calls.some((x) => x.args[0] === "start"));
  labeled = true;
  await manager.start(c);
  await manager.stop(c.id);
  assert.deepEqual(
    calls.filter((x) => x.args[0] !== "inspect").map((x) => x.args[0]),
    ["start", "stop"],
  );
});

test("native shutdown waits for exit after SIGKILL and reports a failed kill safely", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  for (const fails of [false, true]) {
    const manager = new Lifecycle(temp(t));
    const child = new EventEmitter();
    child.exitCode = null;
    child.kill = (signal) => {
      if (signal === "SIGKILL" && fails) throw Error("synthetic kill failure");
      return true;
    };
    manager.owned.set("synthetic", { type: "native", child });
    let stopped = false;
    const stopping = manager.stop("synthetic");
    const result = fails
      ? assert.rejects(stopping, /PROCESS_STOP_FAILED/)
      : stopping.then(() => {
          stopped = true;
        });
    assert.doesNotThrow(() => t.mock.timers.tick(5001));
    await new Promise(setImmediate);
    if (!fails) {
      assert.equal(stopped, false);
      child.emit("exit", null, "SIGKILL");
    }
    await result;
  }
});
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a/pkAAAAASUVORK5CYII=",
  "base64",
);
test("image assets and sticker notes are isolated by agent and send as bytes", (t) => {
  const media = new MediaStore(temp(t)),
    saved = media.put("a", png, "image/png", { conversation: "private:30000" });
  assert.equal(media.read("a", saved.id).type, "image");
  assert.throws(() => media.read("b", saved.id), /NOT_FOUND/);
  media.collect("a", saved.id, { title: "测试表情", tags: ["测试"] });
  assert.equal(media.list("a", "测试").length, 1);
  assert.equal(media.list("b").length, 0);
  assert.match(media.segment("a", saved.id).data.file, /^base64:\/\//);
});
test("media rejects arbitrary file paths, nonimages, oversized data and unsafe URLs", async (t) => {
  const media = new MediaStore(temp(t));
  assert.throws(() => media.read("a", "../../secret"), /INVALID_MEDIA_ID/);
  assert.throws(
    () => media.put("a", Buffer.from("not image"), "image/png"),
    /INVALID_IMAGE/,
  );
  assert.throws(
    () => media.put("a", Buffer.alloc(9 * 1024 * 1024), "image/png"),
    /INVALID_IMAGE/,
  );
  await assert.rejects(
    media.fromMessage("a", {
      id: "x",
      payload: {
        segments: [
          { type: "image", data: { url: "http://127.0.0.1:9/secret" } },
        ],
      },
    }),
  );
});
test("external MCP rejects unconfigured servers/tools before spawning", async () => {
  const external = new ExternalTools([
    {
      id: "one",
      command: "must-not-run",
      args: [],
      env: {},
      allowedTools: ["image_generate"],
    },
  ]);
  await assert.rejects(
    external.call("other", "image_generate", {}),
    /DISABLED/,
  );
  await assert.rejects(external.call("one", "shell", {}), /DISABLED/);
  assert.equal(external.clients.size, 0);
});
test("external image MCP protocol registers owned media then sends through audited outbox", async (t) => {
  const cfg = config();
  cfg.agents[0].tools.push("external_tool");
  const { runtime, root, store } = fixture(t, { cfg });
  runtime.media = new MediaStore(root + "/media");
  const external = new ExternalTools([
    {
      id: "synthetic",
      command: process.execPath,
      args: ["test/image-mcp-fixture.mjs"],
      env: {},
      allowedTools: ["image_generate"],
    },
  ]);
  runtime.backends.set("agent-0", { external, close: () => external.close() });
  const ctx = context(runtime);
  const result = await runtime.callTool(ctx, "external_tool", {
    serverId: "synthetic",
    tool: "image_generate",
    arguments: {},
  });
  const media = JSON.parse(result.content[0].text).generatedMedia;
  assert.equal(media.mimeType, "image/png");
  await runtime.callTool(ctx, "qq_send", {
    requestId: "image-1",
    mediaId: media.id,
  });
  assert.equal(store.bind("agent-0").delivery("image-1").status, "sent");
  assert.equal(
    runtime.transports.get("qq-0").sent[0].segments[0].type,
    "image",
  );
});

test("OneBot forward group/private endpoints carry observed node IDs and real response IDs", async (t) => {
  const { c, calls } = await onebot(t),
    bot = new OneBot(c);
  t.after(() => bot.close());
  const nodes = [{ type: "node", data: { id: "12345" } }];
  assert.equal(
    (await bot.sendForward("group:20000", nodes)).messageId,
    "40000",
  );
  assert.equal(
    (await bot.sendForward("private:30000", nodes)).messageId,
    "40000",
  );
  assert.deepEqual(
    calls.map((c) => c.path),
    ["/send_group_forward_msg", "/send_private_forward_msg"],
  );
  assert.deepEqual(calls[0].body, { group_id: 20000, messages: nodes });
  assert.deepEqual(calls[1].body, { user_id: 30000, messages: nodes });
});

test("missing or invalid OneBot time is observation time, not trusted scene time", () => {
  const raw = {
    self_id: 10000,
    post_type: "message",
    message_type: "group",
    group_id: 20000,
    user_id: 30000,
    message: "测试",
  };
  for (const time of [undefined, null, "bad", 0, 1e30]) {
    const e = normalizeEvent({ ...raw, time }, { accountId: "10000" });
    assert.equal(e.timeKnown, false);
    assert.ok(Number.isFinite(Date.parse(e.occurredAt)));
  }
  const e = normalizeEvent(
    { ...raw, time: 1700000000 },
    { accountId: "10000" },
  );
  assert.equal(e.timeKnown, true);
  assert.equal(e.occurredAt, "2023-11-14T22:13:20.000Z");
});

function fakeGateway(recovery) {
  const sockets = [];
  class Socket extends EventEmitter {
    constructor() {
      super();
      this.pings = 0;
      this.terminated = false;
      sockets.push(this);
      queueMicrotask(() => this.emit("open"));
    }
    ping() {
      this.pings++;
    }
    terminate() {
      this.terminated = true;
      this.emit("close");
    }
    close() {
      this.emit("close");
    }
  }
  const c = { ...config(1).connections[0], recovery };
  const bot = new OneBot(c, {
    WebSocketImpl: Socket,
    fetchImpl: async (url) =>
      new Response(
        JSON.stringify({
          status: "ok",
          retcode: 0,
          data: url.endsWith("get_login_info")
            ? { user_id: 10000 }
            : { online: true },
        }),
      ),
  });
  const faults = [];
  bot.on("fault", (code) => faults.push(code));
  return { bot, sockets, faults };
}

test("a silent OneBot socket is pinged and then reported lost", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "Date"], now: 0 });
  const { bot, sockets, faults } = fakeGateway({
    ...config(1).connections[0].recovery,
  });
  t.after(() => bot.close());
  await bot.connect();
  const socket = sockets[0];
  t.mock.timers.tick(30000);
  assert.equal(socket.pings, 1);
  // A pong or any frame keeps the socket alive.
  t.mock.timers.tick(30000);
  socket.emit("pong");
  t.mock.timers.tick(60000);
  assert.equal(bot.connected, true);
  socket.emit("message", Buffer.from(JSON.stringify({ self_id: 10000 })));
  t.mock.timers.tick(60000);
  assert.equal(bot.connected, true);
  assert.deepEqual(faults, []);
  t.mock.timers.tick(30000);
  assert.equal(bot.connected, false);
  assert.equal(socket.terminated, true);
  assert.deepEqual(faults, ["ONEBOT_HEARTBEAT_TIMEOUT"]);
  t.mock.timers.tick(300000);
  assert.deepEqual(faults, ["ONEBOT_HEARTBEAT_TIMEOUT"], "reported once");
});

test("the OneBot heartbeat watchdog can be turned off", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "Date"], now: 0 });
  const { bot, sockets, faults } = fakeGateway({
    ...config(1).connections[0].recovery,
    heartbeatTimeoutMs: 0,
  });
  t.after(() => bot.close());
  await bot.connect();
  t.mock.timers.tick(600000);
  assert.equal(sockets[0].pings, 0);
  assert.equal(bot.connected, true);
  assert.deepEqual(faults, []);
});

test("an unreadable OneBot frame is dropped, another account's frame stops the channel", async (t) => {
  const { bot, sockets, faults } = fakeGateway();
  t.after(() => bot.close());
  const events = [];
  bot.on("event", (raw) => events.push(raw));
  await bot.connect();
  sockets[0].emit("message", Buffer.from("not json"));
  sockets[0].emit("message", Buffer.from("[1]"));
  assert.equal(bot.connected, true);
  sockets[0].emit("message", Buffer.from(JSON.stringify({ self_id: 10000 })));
  assert.equal(events.length, 1);
  sockets[0].emit("message", Buffer.from(JSON.stringify({ self_id: 999 })));
  assert.equal(bot.connected, false);
  assert.equal(events.length, 1);
  assert.deepEqual(faults, [
    "INVALID_ONEBOT_EVENT",
    "INVALID_ONEBOT_EVENT",
    "QQ_ACCOUNT_MISMATCH",
  ]);
});
