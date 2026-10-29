import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { randomBytes } from "node:crypto";
import { fixture } from "./helpers.mjs";
import { createServer } from "../src/server.mjs";

// Shared console parts every page builds on: folded sections that remember
// what the viewer opened, QQ numbers picked from groups and people the role
// has met, and sliders that show their value.
const T0 = Date.parse("2026-10-29T08:00:00Z");
const at = (s) => new Date(T0 + s * 1000).toISOString();
let n = 0;
const heard = (m, conversation, senderId, s, raw = {}) =>
  m.append({
    dedupe: "kit-" + ++n,
    conversation,
    kind: "message.received",
    senderId,
    body: "说话",
    occurredAt: at(s),
    observedAt: at(s),
    payload: { raw },
  });

function kit(storage = new Map()) {
  const sandbox = vm.createContext({
    document: {
      // app.js wires its controls on load; any element will do here.
      querySelector: () => ({
        addEventListener() {},
        querySelectorAll: () => [],
        classList: { add() {}, remove() {}, toggle() {} },
        dataset: {},
        style: {},
      }),
      querySelectorAll: () => [],
      addEventListener() {},
      body: { classList: { remove() {}, toggle() {} } },
    },
    sessionStorage: { getItem: () => "" },
    localStorage: storage && {
      getItem: (k) => (storage.has(k) ? storage.get(k) : null),
      setItem: (k, v) => storage.set(k, String(v)),
    },
    setInterval() {},
    setTimeout() {},
    clearTimeout() {},
    fetch: () => new Promise(() => {}),
    URLSearchParams,
  });
  vm.runInContext(
    fs.readFileSync(new URL("../public/app.js", import.meta.url), "utf8"),
    sandbox,
  );
  return (code) => vm.runInContext(code, sandbox);
}

test("the role's known groups and people come named, private chats first", async (t) => {
  const f = fixture(t),
    m = f.store.bind("agent-0");
  heard(m, "group:20000", "30000", 0, { group_name: "旧群名" });
  heard(m, "group:20000", "30000", 10, { group_name: "周末<开黑>" });
  heard(m, "group:20001", "30001", 20);
  heard(m, "private:30002", "30002", 30);
  m.person("30000", "阿明同学");
  m.person("30001", "小新");
  m.person("30003", "很久没说话");
  m.identity.savePersonCard(
    {
      personId: "30001",
      call: "新哥",
      body: "群友",
      evidence: [heard(m, "group:20001", "30001", 40).id],
    },
    { writtenIn: "group:20001", now: T0 },
  );
  const known = m.knownTargets();
  assert.deepEqual(
    known.groups.map((g) => [g.id, g.name]),
    [
      ["20001", ""],
      ["20000", "周末<开黑>"],
    ],
  );
  // A private chat first, then people with a card, then everyone else.
  assert.deepEqual(
    known.people.map((p) => [p.id, p.name, p.call ?? null, !!p.private]),
    [
      ["30002", "", null, true],
      ["30001", "小新", "新哥", false],
      ["30000", "阿明同学", null, false],
      ["30003", "很久没说话", null, false],
    ],
  );

  const token = randomBytes(32).toString("hex"),
    app = createServer({ runtime: f.runtime, token });
  const port = await app.listen();
  t.after(() => app.close());
  const get = (q) =>
    fetch(`http://127.0.0.1:${port}/api/known-targets?${q}`, {
      headers: { "x-admin-token": token },
    });
  assert.deepEqual(await (await get("agentId=agent-0")).json(), known);
  assert.equal((await get("agentId=nobody")).ok, false);
});

test("a folded section remembers what this browser opened, and works without storage", () => {
  const storage = new Map(),
    run = kit(storage);
  const closed = run(
    'fold("subject-quota", "检查状态", "<p>内容</p>", { summary: "剩 1 次" })',
  );
  assert.match(
    closed,
    /^<details class="card fold" data-fold="subject-quota"><summary><span class="fold-title">检查状态<\/span><span class="fold-summary">剩 1 次<\/span><\/summary><div class="fold-body"><p>内容<\/p><\/div><\/details>$/,
  );
  assert.match(
    run('fold("x", "t", "", { open: true })'),
    /data-fold="x" open>/,
  );
  // The viewer's choice wins over the default either way.
  storage.set("fold:subject-quota", "1");
  assert.match(run('fold("subject-quota", "t", "")'), / open>/);
  storage.set("fold:x", "0");
  assert.doesNotMatch(run('fold("x", "t", "", { open: true })'), / open>/);
  // Storage that throws (private windows) falls back to the default.
  const refusing = kit(null);
  assert.match(
    refusing(
      'localStorage = { getItem() { throw Error("denied") } }; fold("x", "t", "", { open: true })',
    ),
    / open>/,
  );
});

test("QQ numbers become chips, deduplicated and escaped, with the comma list kept", () => {
  const run = kit();
  const html = run('ids("groups", "群白名单", "20000，20001 20000,,30000")');
  assert.match(
    html,
    /<input type="hidden" name="groups" value="20000,20001,30000">/,
  );
  assert.equal(html.match(/class="ids-chip"/g).length, 3);
  assert.match(html, /data-ids="group"/);
  assert.match(html, /placeholder="输入群号，或从认识的群里选"/);
  assert.match(
    run('ids("owners", "管理员", [], { kind: "person" })'),
    /还没有/,
  );
  assert.match(
    run('ids("owners", "管理员", [], { kind: "person" })'),
    /placeholder="输入 QQ 号，或从认识的人里选"/,
  );
  assert.match(
    run('idChip("30000", "阿<明>")'),
    /<span class="ids-name">阿&lt;明&gt; <small>30000<\/small><\/span>/,
  );
  assert.equal(
    run('knownName({ name: "小新", call: "新哥" })'),
    "小新 · 叫「新哥」",
  );
  assert.equal(run('knownName({ name: "小新", call: "小新" })'), "小新");
});

test("a slider shows its value, as a percentage for 0–1", () => {
  const run = kit();
  assert.equal(run('rangeText("0.35", "%")'), "35%");
  assert.equal(run('rangeText(30, " 秒")'), "30 秒");
  const html = run('range("participation", "参与率", 0.2, { unit: "%" })');
  assert.match(
    html,
    /<input type="range" name="participation" min="0" max="1" step="0.05" value="0.2" data-unit="%"><output>20%<\/output>/,
  );
});
