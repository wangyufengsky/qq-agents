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
  for (let i = 0; i < 15; i++) await Promise.resolve();
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
