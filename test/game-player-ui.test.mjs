import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";

function browser(snapshot) {
  const nodes = new Map(),
    listeners = new Map(),
    calls = [],
    timers = [];
  const element = () => ({
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
  node("main").dataset = { room: "room", authenticated: "true" };
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
    sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
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
