import http from "node:http";
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { fixture, config, context } from "./helpers.mjs";
import { GameHost, gameName } from "../src/games/framework/host.mjs";
import { cleanRemark } from "../src/games/core/kernel.mjs";
import {
  avatarPath,
  avatarType,
  fetchQqAvatar,
} from "../src/games/framework/avatar.mjs";
import { secret } from "../src/games/core/value.mjs";

const png = Buffer.concat([
  Buffer.from("89504e470d0a1a0a", "hex"),
  Buffer.alloc(32, 1),
]);

function setup(t, run = async () => {}, edit = () => {}, options = {}) {
  const cfg = config(1);
  cfg.games.enabled = true;
  cfg.agents[0].games.enabled = true;
  edit(cfg);
  const f = fixture(t, { cfg, run });
  f.runtime.games = new GameHost(f.runtime, { launch: false, ...options });
  const h = f.runtime.games;
  h.ensure();
  return { ...f, h, k: h.kernel };
}
async function create(f) {
  const event = f.store.bind("agent-0").append({
    kind: "message.received",
    conversation: "private:30000",
    senderId: "30000",
    direction: "in",
    body: "下五子棋",
    observedAt: f.runtime.now(),
    payload: { trustedInput: true },
    dedupe: randomUUID(),
  });
  return f.h.create(context(f.runtime, "agent-0", "private:30000"), {
    eventId: event.id,
    requestId: randomUUID(),
    gameType: "gomoku",
    options: {},
  });
}
function act(f, roomId, type, payload = {}, extra = {}) {
  const room = f.k.store.room(roomId);
  return f.k.act(roomId, f.k.actor(room.owner), {
    actionId: randomUUID(),
    expectedRevision: room.revision,
    action: { type, payload },
    ...extra,
  });
}
async function aiTurn(f) {
  const { roomId } = await create(f);
  const room = f.k.store.room(roomId),
    owner = f.k.actor(room.owner),
    inv = f.h.identity.invite(
      roomId,
      owner,
      room.participants[0].participantId,
    ),
    browser = secret(),
    proof = f.h.identity.request(roomId, inv.bindingId, inv.invite, browser),
    { code } = f.h.identity.confirm(
      roomId,
      inv.bindingId,
      proof.challenge,
      owner,
    );
  f.h.identity.exchange(roomId, inv.bindingId, browser, code);
  act(f, roomId, "room.start");
  act(f, roomId, "game.place", { x: 7, y: 7 });
  return { roomId, id: f.k.store.room(roomId).decision.decisionId };
}

test("remarks are flattened, bounded and drop links or markup", () => {
  assert.equal(cleanRemark(" 主人\n上当\t啦！ "), "主人 上当 啦！");
  assert.equal(Array.from(cleanRemark("哈".repeat(80))).length, 30);
  for (const text of [
    "看 https://x.test",
    "去 www.example 玩",
    "加群 qq.com 吧",
    "<b>hi</b>",
    "[CQ:at,qq=1]",
    "",
    "\n\t",
  ])
    assert.equal(cleanRemark(text), "");
});

test("AI remark commits with the move without an extra revision; humans cannot remark", async (t) => {
  let tools;
  const f = setup(
    t,
    async (p) => {
      tools = p.tools;
      assert.match(p.instructions, /remark/);
      assert.match(p.instructions, /台词风格：俏皮/);
      const data = JSON.parse(p.prompt);
      await p.callTool("game_act", {
        roomId: data.scope.roomId,
        actionId: data.actionId,
        expectedRevision: data.snapshot.revision,
        action: { type: "game.place", payload: { x: 8, y: 7 } },
        remark: "主人上当！\n这步我等很久了",
      });
    },
    (cfg) => {
      cfg.agents[0].games.remarkStyle = "俏皮";
    },
  );
  const { roomId, id } = await aiTurn(f);
  const before = f.k.store.room(roomId).revision;
  f.h.jobs.receive(id);
  await f.h.worker.run(id);
  const room = f.k.store.room(roomId),
    ai = room.participants.find((p) => p.kind === "ai");
  assert.ok(
    tools.find((x) => x.name === "game_act").inputSchema.properties.remark,
  );
  assert.equal(room.revision, before + 1);
  assert.deepEqual(room.remarks, [
    {
      participantId: ai.participantId,
      revision: room.revision,
      text: "主人上当！ 这步我等很久了",
    },
  ]);
  assert.equal(room.state.remarks, undefined);
  const view = f.k.view(roomId, f.k.actor(room.owner));
  assert.deepEqual(view.remarks, room.remarks);
  assert.throws(
    () => act(f, roomId, "game.place", { x: 0, y: 0 }, { remark: "我也说" }),
    /REMARK_DENIED/,
  );
  // Remarks never become chat history or QQ output.
  assert.equal(
    JSON.stringify(f.runtime.transports.get("qq-0").sent).includes("主人上当"),
    false,
  );
  assert.equal(
    f.store.db
      .prepare(
        "SELECT count(*) AS n FROM events WHERE body LIKE '%主人上当%' OR payload LIKE '%主人上当%'",
      )
      .get().n,
    0,
  );
});

test("a link-bearing remark is dropped but the legal move still commits", async (t) => {
  const f = setup(t, async (p) => {
    const data = JSON.parse(p.prompt);
    await p.callTool("game_act", {
      roomId: data.scope.roomId,
      actionId: data.actionId,
      expectedRevision: data.snapshot.revision,
      action: { type: "game.place", payload: { x: 8, y: 7 } },
      remark: "来 https://evil.test 看",
    });
  });
  const { roomId, id } = await aiTurn(f);
  f.h.jobs.receive(id);
  await f.h.worker.run(id);
  const room = f.k.store.room(roomId);
  assert.equal(room.state.board[7 * 15 + 8], 2);
  assert.equal(room.remarks, undefined);
});

test("disabled remarks remove the field from the AI tool schema", async (t) => {
  let seen;
  const f = setup(
    t,
    async (p) => {
      seen = p;
      const data = JSON.parse(p.prompt);
      await assert.rejects(
        p.callTool("game_act", {
          roomId: data.scope.roomId,
          actionId: data.actionId,
          expectedRevision: data.snapshot.revision,
          action: { type: "game.place", payload: { x: 8, y: 7 } },
          remark: "不该出现",
        }),
      );
    },
    (cfg) => {
      cfg.agents[0].games.remarks = false;
    },
  );
  const { id } = await aiTurn(f);
  f.h.jobs.receive(id);
  await f.h.worker.run(id);
  assert.equal(
    seen.tools.find((x) => x.name === "game_act").inputSchema.properties.remark,
    undefined,
  );
  assert.equal(/remark/.test(seen.instructions), false);
});

test("the AI seat uses the public game name, else the agent name, never the QQ account", async (t) => {
  assert.equal(gameName({ name: "阿檀", games: { publicName: "" } }), "阿檀");
  assert.equal(
    gameName({ name: "阿檀", games: { publicName: "檀\n棋手" } }),
    "檀 棋手",
  );
  assert.equal(
    Array.from(gameName({ name: "长".repeat(60), games: {} })).length,
    24,
  );
  assert.equal(gameName({ name: "", games: {} }), "AI 对手");
  const f = setup(t, undefined, (cfg) => {
    cfg.agents[0].games.publicName = "小檀";
  });
  const { roomId } = await create(f);
  const labels = f.k.store.room(roomId).participants.map((p) => p.label);
  assert.deepEqual(labels, ["玩家", "小檀"]);
  assert.equal(JSON.stringify(labels).includes("10000"), false);
});

test("avatar bytes are typed by signature and only accepted from QQ image hosts", async () => {
  assert.equal(avatarType(png), "image/png");
  assert.equal(
    avatarType(Buffer.from("ffd8ffe000104a4649460001", "hex")),
    "image/jpeg",
  );
  assert.equal(avatarType(Buffer.from("<svg onload=x>     ")), null);
  assert.match(
    avatarPath({ type: "image/png", body: png }),
    /^\/avatars\/[a-f0-9]{32}\.png$/,
  );
  const reply =
    (body, url = "https://thirdqq.qlogo.cn/x", headers = {}) =>
    async (target) => {
      assert.equal(target, "https://q1.qlogo.cn/g?b=qq&nk=10000&s=100");
      return Object.defineProperty(new Response(body, { headers }), "url", {
        value: url,
      });
    };
  assert.deepEqual(await fetchQqAvatar("10000", { fetch: reply(png) }), {
    type: "image/png",
    body: png,
  });
  assert.equal(
    await fetchQqAvatar("10000", { fetch: reply(png, "https://evil.test/a") }),
    null,
  );
  assert.equal(await fetchQqAvatar("10000", { fetch: reply("<html>") }), null);
  assert.equal(
    await fetchQqAvatar("10000", {
      fetch: reply(Buffer.concat([png, Buffer.alloc(300000)])),
    }),
    null,
  );
  assert.equal(
    await fetchQqAvatar("10000", {
      fetch: async () => {
        throw Error("offline");
      },
    }),
    null,
  );
  assert.equal(await fetchQqAvatar("../x", { fetch: reply(png) }), null);
});

test("the host caches avatars, retries failures hourly and only fetches for live game agents", async (t) => {
  let calls = 0,
    ok = false;
  const f = setup(t, undefined, undefined, {
    fetchAvatar: async () => {
      calls++;
      return ok ? { type: "image/png", body: png } : null;
    },
  });
  const sent = [];
  f.h.child = { connected: true, send: (m) => sent.push(m) };
  f.h.ready = true;

  let now = f.runtime.now();
  f.runtime.now = () => now;
  const settle = () => Promise.all([...f.runtime.jobs]);
  f.h.refreshAvatars();
  await settle();
  assert.equal(calls, 1);
  assert.deepEqual(sent.at(-1), {
    avatar: { agentId: "agent-0", remove: true },
  });
  f.h.refreshAvatars();
  await settle();
  assert.equal(calls, 1);
  ok = true;
  now += 3600000;
  f.h.refreshAvatars();
  await settle();
  assert.equal(calls, 2);
  assert.equal(sent.at(-1).avatar.type, "image/png");
  assert.equal(
    Buffer.from(sent.at(-1).avatar.body, "base64").equals(png),
    true,
  );
  f.runtime.config.agents[0].games.avatar = "none";
  f.h.refreshAvatars();
  assert.deepEqual(sent.at(-1), {
    avatar: { agentId: "agent-0", remove: true },
  });
  f.runtime.config.agents[0].games.avatar = "qq";
  f.runtime.config.mode = "isolated";
  f.h.refreshAvatars();
  await settle();
  assert.equal(calls, 2);
  // The fake child has no process to stop during fixture shutdown.
  f.h.child = null;
});

test("the game child serves a pushed avatar by hash with an image-only CSP allowance", async (t) => {
  const f = setup(t);
  await f.h.close();
  const probe = http.createServer();
  await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  f.runtime.config.games.port = port;
  const host = (f.runtime.games = new GameHost(f.runtime, {
    fetchAvatar: async () => ({ type: "image/png", body: png }),
  }));
  host.ensure();
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error("CHILD_START_TIMEOUT")), 10000);
    host.child.once("message", () => {
      clearTimeout(timer);
      resolve();
    });
  });
  const path = avatarPath({ type: "image/png", body: png });
  let response;
  for (let i = 0; i < 100; i++) {
    response = await fetch(`http://127.0.0.1:${port}${path}`);
    if (response.status === 200) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "image/png");
  assert.match(
    response.headers.get("content-security-policy"),
    /img-src 'self'/,
  );
  assert.equal(Buffer.from(await response.arrayBuffer()).equals(png), true);
  await host.close();
});
