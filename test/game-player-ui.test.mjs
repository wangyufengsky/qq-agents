import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";

function browser(snapshot, { authenticated = true, binding = null } = {}) {
  const nodes = new Map(),
    listeners = new Map(),
    calls = [],
    timers = [];
  const element = () => ({
    value: "12345678",
    children: [],
    dataset: {},
    classList: { toggle() {} },
    setAttribute() {},
    replaceChildren() {
      this.children = [];
    },
    append(child) {
      this.children.push(child);
    },
  });
  const node = (id) => {
    if (!nodes.has(id)) nodes.set(id, element());
    return nodes.get(id);
  };
  node("main").dataset = { room: "room", authenticated: String(authenticated) };
  node("board").children = Array.from({ length: 225 }, (_, index) =>
    Object.assign(element(), { dataset: { index } }),
  );
  let resolve;
  const response = new Promise((done) => {
    resolve = done;
  });
  const context = {
    document: {
      hidden: false,
      querySelector: () => node("main"),
      getElementById: node,
      createElement: element,
      addEventListener: (name, fn) => listeners.set(name, fn),
    },
    window: { addEventListener() {} },
    sessionStorage: {
      getItem: (key) =>
        key.endsWith(":binding") && binding ? JSON.stringify(binding) : null,
      setItem() {},
      removeItem() {},
    },
    fetch: async (path) => {
      calls.push(path);
      const data = calls.length === 1 ? await response : snapshot;
      return { ok: true, json: async () => JSON.parse(JSON.stringify(data)) };
    },
    AbortSignal,
    crypto: { randomUUID: () => "action" },
    history: { replaceState() {} },
    location: { href: "http://example.test/rooms/room" },
    URL,
    setTimeout: (fn) => {
      timers.push(fn);
      return timers.length;
    },
    clearTimeout() {},
  };
  vm.runInNewContext(
    readFileSync(new URL("../public/game-play.js", import.meta.url), "utf8"),
    context,
  );
  return { node, calls, timers, listeners, context, resolve };
}
const flush = async () => {
  for (let i = 0; i < 60; i++) await Promise.resolve();
};
test("DOM exposes owner start above board, identity and Chinese execution state", async () => {
  const snap = {
    revision: 1,
    viewer: "human",
    owner: true,
    lifecycle: "waiting",
    execution: { status: "queued" },
  };
  const b = browser(snap);
  b.resolve(snap);
  await flush();
  assert.equal(b.node("controls").children[0].textContent, "开始对局");
  assert.match(b.node("identity").textContent, /已验证原 QQ 身份/);
  assert.equal(b.node("ai-status").textContent, "AI 状态：排队中");
  assert.equal(b.node("resign").disabled, true);
});
test("DOM serializes foreground sync with action and explains off-turn resignation", async () => {
  const snap = {
    revision: 2,
    viewer: "human",
    owner: true,
    lifecycle: "active",
    view: { board: Array(225).fill(0), canAct: false, color: "black" },
  };
  const b = browser(snap);
  b.listeners.get("visibilitychange")();
  assert.equal(b.calls.length, 1);
  b.resolve(snap);
  await flush();
  assert.match(b.node("resign-help").textContent, /当前是对方回合/);
  assert.equal(b.node("resign").disabled, true);
  assert.equal(b.node("confirm").disabled, true);
});

test("DOM ignores a poll response older than the visible authoritative revision", async () => {
  const snapshot = {
    revision: 7,
    viewer: "human",
    owner: true,
    lifecycle: "waiting",
  };
  const b = browser(snapshot);
  b.resolve(snapshot);
  await flush();
  assert.equal(b.node("revision").textContent, "版本 7");
  snapshot.revision = 6;
  await b.timers.at(-1)();
  await flush();
  assert.equal(b.node("revision").textContent, "版本 7");
});

test("background poll leaves confirmation clickable and a late poll cannot replace committed action", async () => {
  const snapshot = {
    revision: 2,
    viewer: "human",
    owner: true,
    lifecycle: "active",
    view: { board: Array(225).fill(0), canAct: true, color: "black" },
  };
  const b = browser(snapshot);
  b.resolve(snapshot);
  await flush();
  let finishPoll,
    delayed = true;
  const submitted = [];
  const newer = JSON.parse(JSON.stringify(snapshot));
  newer.revision = 3;
  newer.view.board[0] = 1;
  newer.view.canAct = false;
  b.context.fetch = async (path, options) => {
    if (path.endsWith("/view") && delayed) {
      delayed = false;
      return new Promise((resolve) => {
        finishPoll = () => resolve({ ok: true, json: async () => snapshot });
      });
    }
    if (path.includes("/actions/"))
      return {
        ok: false,
        status: 409,
        json: async () => ({ error: "ACTION_UNCONFIRMED" }),
      };
    if (path.endsWith("/actions")) {
      submitted.push(JSON.parse(options.body));
      return { ok: true, json: async () => ({ revision: 3 }) };
    }
    return { ok: true, json: async () => newer };
  };
  b.node("board").children[0].onclick();
  assert.equal(b.node("confirm").disabled, false);
  const poll = b.timers.at(-1)();
  await flush();
  assert.equal(b.node("confirm").disabled, false);
  b.node("confirm").onclick();
  await flush();
  assert.equal(submitted.length, 1);
  assert.equal(submitted[0].action.type, "game.place");
  assert.equal(b.node("revision").textContent, "版本 3");
  finishPoll();
  await poll;
  await flush();
  assert.equal(b.node("revision").textContent, "版本 3");
  assert.equal(b.node("status").textContent, "操作已确认。");
});

test("joining as ready owner explicitly prompts start rather than waiting for another host", async () => {
  const snapshot = {
    revision: 1,
    viewer: "human",
    owner: true,
    lifecycle: "waiting",
    readyToStart: true,
  };
  const b = browser(snapshot, {
    authenticated: false,
    binding: {
      bindingId: "binding",
      challenge: "challenge",
      expiresAt: Date.now() + 60000,
    },
  });
  b.resolve({ joined: true });
  await b.node("exchange").onclick();
  await flush();
  assert.equal(b.node("status").textContent, "双方已就绪，点击开始对局。");
  assert.equal(b.node("summary").textContent, "双方已就绪，点击开始对局。");
});

test("the selectable binding contains only the command accepted by QQ", () => {
  const b = browser(
    {},
    {
      authenticated: false,
      binding: {
        bindingId: "binding",
        challenge: "challenge",
        expiresAt: Date.now() + 60000,
      },
    },
  );
  assert.equal(
    b.node("binding").textContent,
    "确认游戏 room binding challenge",
  );
  assert.match(b.node("status").textContent, /群游戏也须私聊/);
});

function persona(overrides = {}) {
  const board = Array(225).fill(0);
  return {
    revision: 4,
    viewer: "human",
    owner: true,
    lifecycle: "active",
    participants: [
      { participantId: "human", seat: 0, kind: "human", label: "玩家" },
      { participantId: "ai", seat: 1, kind: "ai", label: "阿檀" },
    ],
    presentation: { avatars: { ai: "/avatars/" + "a".repeat(32) + ".jpg" } },
    remarks: [
      { participantId: "ai", revision: 2, text: "先试试水" },
      { participantId: "ai", revision: 4, text: "主人上当！" },
    ],
    view: { board, canAct: true, color: "black", lastMove: { x: 8, y: 7 } },
    ...overrides,
  };
}

test("opponent name, hash avatar and the current move's remark are shown; the log lists all remarks", async () => {
  const snap = persona();
  const b = browser(snap);
  b.resolve(snap);
  await flush();
  assert.equal(b.node("opponent-name").textContent, "阿檀");
  assert.equal(b.node("opponent-avatar").src, snap.presentation.avatars.ai);
  assert.equal(b.node("opponent-avatar").hidden, false);
  assert.equal(b.node("opponent-initial").hidden, true);
  assert.equal(b.node("me-chip").className, "chip b");
  assert.equal(b.node("ai-chip").className, "chip w");
  assert.equal(b.node("me-side").className, "side on");
  assert.equal(b.node("say").hidden, false);
  assert.equal(b.node("say-text").textContent, "主人上当！");
  assert.deepEqual(
    b.node("remarks").children.map((x) => x.textContent),
    ["主人上当！", "先试试水"],
  );
});

test("a stale remark hides the bubble, unknown avatar paths fall back to the initial, and mute hides remarks", async () => {
  const snap = persona({
    revision: 5,
    presentation: { avatars: { ai: "https://evil.test/a.png" } },
  });
  const b = browser(snap);
  b.resolve(snap);
  await flush();
  assert.equal(b.node("say").hidden, true);
  assert.equal(b.node("opponent-avatar").hidden, true);
  assert.equal(b.node("opponent-initial").hidden, false);
  assert.equal(b.node("opponent-initial").textContent, "阿");
  b.node("mute").onclick();
  assert.equal(b.node("remarks").hidden, true);
  assert.equal(b.node("mute").textContent, "显示台词");
});

test("the bubble shows thinking on the AI turn and the confirm button names the selected point", async () => {
  const snap = persona({
    revision: 5,
    execution: { status: "running" },
    view: {
      board: Array(225).fill(0),
      canAct: false,
      color: "black",
      lastMove: null,
    },
  });
  const b = browser(snap);
  b.resolve(snap);
  await flush();
  assert.equal(b.node("ai-side").className, "side r on");
  assert.equal(b.node("say").hidden, false);
  assert.match(b.node("say-text").textContent, /阿檀 正在想/);
  const mine = persona({ revision: 6, remarks: [] });
  const c = browser(mine);
  c.resolve(mine);
  await flush();
  c.node("board").children[16].onclick();
  assert.equal(c.node("confirm").textContent, "落子 B2");
  assert.equal(c.node("zoom").children.length, 25);
});

test("a finished game highlights the five-stone line through the last move", async () => {
  const board = Array(225).fill(0);
  for (let x = 3; x <= 7; x++) board[7 * 15 + x] = 1;
  const snap = persona({
    lifecycle: "finished",
    remarks: [],
    view: {
      board,
      canAct: false,
      color: "black",
      lastMove: { x: 7, y: 7 },
      result: { kind: "win", winners: ["human"], reasonCode: "FIVE" },
    },
  });
  const b = browser(snap);
  b.resolve(snap);
  await flush();
  const winning = b
    .node("board")
    .children.filter((c) => / win/.test(c.className))
    .map((c) => c.dataset.index);
  assert.deepEqual(
    winning.sort((a, c) => a - c),
    [108, 109, 110, 111, 112],
  );
});
