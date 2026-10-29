import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { randomBytes } from "node:crypto";
import { fixture, config, context, temp } from "./helpers.mjs";
import { createServer } from "../src/server.mjs";
import { MemoryStore } from "../src/memory/store.mjs";
import { exportToFile } from "../src/memory/export.mjs";
import { restoreExport } from "../src/memory/migrate.mjs";
import { mindDefinitions } from "../src/tools/mind.mjs";

// Moods, person cards and diaries point at each other by ID only.
const scope = "group:20000";
const HOUR = 3600000;
let n = 0;
const said = (m, body, senderId = "30000", extra = {}) =>
  m.append({
    dedupe: "link-" + ++n,
    conversation: scope,
    kind: "message.received",
    body,
    senderId,
    ...extra,
  });
const diaryRow = (m, id) =>
  m.db.prepare("SELECT metadata FROM diaries WHERE id=?").get(id);
const revisionMeta = (m, id) =>
  m.db
    .prepare(
      "SELECT revision,metadata FROM diary_revisions WHERE id=? ORDER BY revision",
    )
    .all(id)
    .map((r) => [r.revision, JSON.parse(r.metadata).moodId ?? null]);

test("a diary notes the mood it was written in, and a revision keeps it", async (t) => {
  const f = fixture(t),
    m = f.store.bind("agent-0"),
    ctx = context(f.runtime),
    call = (name, args) => f.runtime.callTool(ctx, name, args);
  // No mood yet: nothing to note, and the field is simply absent.
  const plain = await call("diary_write", {
    title: "平常的一天",
    body: "无事",
  });
  assert.equal(
    Object.hasOwn(JSON.parse(diaryRow(m, plain.id).metadata), "moodId"),
    false,
  );
  const cake = said(m, "今天的蛋糕是你最爱的口味");
  const happy = await call("mood_set", {
    mood: "开心",
    intensity: 3,
    reason: "群友带了蛋糕",
    evidence: [cake.id],
  });
  const diary = await call("diary_write", {
    title: "蛋糕",
    body: "吃到了最爱的蛋糕",
    people: ["30000"],
  });
  // The agent sees it when it reads the diary back.
  const read = await call("memory_read", { id: diary.id });
  assert.equal(JSON.parse(read.chunk).metadata.moodId, happy.id);
  // Only the reference, never a copy of the mood itself.
  assert.doesNotMatch(diaryRow(m, diary.id).metadata, /开心|群友带了蛋糕/);

  // Revised after the mood changed: it still names the mood it was written in.
  const calm = await call("mood_set", {
    mood: "平静",
    intensity: 1,
    reason: "吃饱了",
  });
  await call("diary_revise", {
    id: diary.id,
    expectedRevision: 1,
    title: "蛋糕",
    body: "吃到了最爱的蛋糕，后来很平静",
  });
  assert.deepEqual(revisionMeta(m, diary.id), [
    [1, happy.id],
    [2, happy.id],
  ]);
  // An older diary without one gains none on revision.
  await call("diary_revise", {
    id: plain.id,
    expectedRevision: 1,
    title: "平常的一天",
    body: "还是无事",
  });
  assert.deepEqual(revisionMeta(m, plain.id), [
    [1, null],
    [2, null],
  ]);
  const later = await call("diary_write", { title: "晚上", body: "很安静" });
  assert.equal(JSON.parse(diaryRow(m, later.id).metadata).moodId, calm.id);

  // A cleared or expired mood is not in effect.
  await call("mood_set", { clear: true, reason: "回到平常" });
  const cleared = await call("diary_write", { title: "之后", body: "平常" });
  assert.equal(JSON.parse(diaryRow(m, cleared.id).metadata).moodId, undefined);
  m.identity.setMood(
    { mood: "困", intensity: 2, reason: "熬夜", hours: 1 },
    { writtenIn: scope, now: Date.now() - 2 * HOUR },
  );
  const expired = await call("diary_write", { title: "补觉", body: "睡醒" });
  assert.equal(JSON.parse(diaryRow(m, expired.id).metadata).moodId, undefined);
});

test("a free-time log notes the mood in effect, by ID only", async (t) => {
  const cfg = config(1);
  Object.assign(cfg.agents[0].subject, {
    enabled: true,
    groups: ["20000"],
    intervalMs: 60000,
  });
  cfg.agents[0].behavior.preSleepWaitMs = 0;
  const f = fixture(t, {
    cfg,
    run: async (p) => {
      p.saveSession({ id: "s" + ++n, backend: "fixture" });
      if (p.conversation === "@subject")
        await p.callTool("subject_log", {
          did: "rested",
          summary: "歇一会",
          restReason: "quiet",
        });
    },
  });
  const m = f.store.bind("agent-0");
  const logs = () =>
    m.db
      .prepare(
        "SELECT payload FROM events WHERE agent_id='agent-0' AND kind='subject.log' ORDER BY seq",
      )
      .all()
      .map((r) => JSON.parse(r.payload));
  await f.runtime.wake("agent-0", "@subject");
  assert.equal(Object.hasOwn(logs()[0], "moodId"), false);
  const bored = m.identity.setMood(
    { mood: "无聊", intensity: 2, reason: "群里没人说话" },
    { writtenIn: scope, now: f.runtime.now() },
  );
  m.setState("@subject", { ...m.state("@subject"), nextCheckAt: 0 });
  await f.runtime.wake("agent-0", "@subject");
  assert.equal(logs()[1].moodId, bored.id);
  assert.doesNotMatch(JSON.stringify(logs()[1]), /无聊/);
});

test("export and restore keep moodId, and older records without it still read and revise", async (t) => {
  const root = temp(t),
    store = new MemoryStore(path.join(root, "memory.sqlite")),
    a = store.bind("agent-a");
  t.after(() => store.close());
  const old = a.diaryWrite({ title: "以前", body: "没有心情的日记" });
  const mood = a.identity.setMood(
    { mood: "开心", intensity: 3, reason: "导出前" },
    { writtenIn: scope, now: Date.now() },
  );
  const diary = a.diaryWrite({ title: "有心情", body: "写于开心时" });
  a.diaryRevise({
    id: diary.id,
    expectedRevision: 1,
    title: "有心情",
    body: "修订过",
  });
  a.append({
    dedupe: "log",
    conversation: "@subject",
    kind: "subject.log",
    direction: "internal",
    body: "歇一会",
    payload: { did: "rested", summary: "歇一会", moodId: mood.id },
  });
  const file = path.join(root, "agent-a.json");
  await exportToFile(store, "agent-a", file);
  const data = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(data.version, 2);

  const target = new MemoryStore(path.join(root, "restored.sqlite"));
  t.after(() => target.close());
  restoreExport(target.bind("agent-a"), data);
  const b = target.bind("agent-a");
  assert.equal(b.readRecord({ id: diary.id }).metadata.moodId, mood.id);
  assert.deepEqual(revisionMeta(b, diary.id), [
    [1, mood.id],
    [2, mood.id],
  ]);
  assert.equal(
    JSON.parse(
      b.db.prepare("SELECT payload FROM events WHERE kind='subject.log'").get()
        .payload,
    ).moodId,
    mood.id,
  );
  assert.equal(b.identity.moodHistory()[0].id, mood.id);
  // The restored references still resolve, and the old diary is untouched.
  assert.equal(b.readRecord({ id: old.id }).metadata.moodId, undefined);
  b.diaryRevise({
    id: old.id,
    expectedRevision: 1,
    title: "以前",
    body: "恢复后修订",
  });
  b.diaryRevise({
    id: diary.id,
    expectedRevision: 2,
    title: "有心情",
    body: "恢复后再修订",
  });
  assert.equal(b.readRecord({ id: old.id }).metadata.moodId, undefined);
  assert.equal(b.readRecord({ id: diary.id }).metadata.moodId, mood.id);
});

test("person_notes shows recent diaries about each person behind the recall boundary", async (t) => {
  const f = fixture(t),
    m = f.store.bind("agent-0"),
    ctx = context(f.runtime);
  const e = said(m, "以后叫我阿明就行");
  await f.runtime.callTool(ctx, "person_note", {
    personId: "30000",
    call: "阿明",
    body: "群里的老朋友",
    evidence: [e.id],
  });
  const ids = [];
  for (const title of ["第一篇", "第二篇", "第三篇", "第四篇"]) {
    ids.push(m.diaryWrite({ title, body: "和阿明聊天", people: ["30000"] }).id);
    await new Promise((r) => setTimeout(r, 2));
  }
  m.diaryWrite({ title: "别人", body: "无关", people: ["30001"] });
  // The newest diaries about him are protected; they are skipped, not shown.
  await new Promise((r) => setTimeout(r, 2));
  const ops = m.diaryWrite(
    { title: "运维记录", body: "受保护", people: ["30000"] },
    "ai-diary",
    null,
    true,
  ).id;
  await new Promise((r) => setTimeout(r, 2));
  const repo = m.diaryWrite(
    { title: "私有仓库", body: "受保护", people: ["30000"] },
    "ai-diary",
    null,
    false,
    ["fixture/private"],
  ).id;
  const read = await f.runtime.callTool(ctx, "person_notes", {
    personIds: ["30000"],
  });
  assert.deepEqual(
    read.items[0].diaries.map((d) => d.title),
    ["第四篇", "第三篇", "第二篇"],
  );
  assert.deepEqual(Object.keys(read.items[0].diaries[0]).sort(), [
    "id",
    "title",
    "updatedAt",
  ]);
  // What it showed counts as read; what it withheld does not.
  for (const id of ids.slice(1)) assert(ctx.privateRead.has(id));
  for (const id of [ids[0], ops, repo]) assert(!ctx.privateRead.has(id));
  // Plain diaries read this way do not block writing the shared card.
  await f.runtime.callTool(ctx, "person_note", {
    personId: "30000",
    call: "阿明",
    body: "群里的老朋友，爱聊天",
    evidence: [e.id],
    expectedRevision: 1,
  });
  // Listing every card does not pull in diaries.
  const fresh = context(f.runtime, "agent-0", "private:30000");
  const list = await f.runtime.callTool(fresh, "person_notes", {});
  assert.equal(list.items[0].diaries, undefined);
  for (const id of ids) assert(!fresh.privateRead.has(id));
});

test("mood_set points at the agent's own stickers and picks none itself", () => {
  const [description] = mindDefinitions.mood_set;
  assert.match(description, /sticker_list/);
  assert.match(description.trim(), /sticker_list[^。]*。$/);
});

// The console renders these scripts as markup; a stub DOM routes the click.
function consoleScripts(api) {
  const listeners = {},
    rendered = [];
  const sandbox = vm.createContext({
    api,
    tab: "mood",
    $: () => null,
    esc: (x) =>
      String(x ?? "").replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`),
    input: () => "",
    render: () => rendered.push(sandbox.tab),
    CustomEvent,
    document: {
      chips: [],
      querySelectorAll(selector) {
        return selector === "[data-mood-person]" ? this.chips : [];
      },
      addEventListener: (type, fn) => (listeners[type] = fn),
      dispatchEvent: (e) => listeners[e.type]?.(e),
    },
  });
  for (const script of ["mood-ui.js", "people-ui.js"])
    vm.runInContext(
      fs.readFileSync(new URL(`../public/${script}`, import.meta.url), "utf8"),
      sandbox,
    );
  return { sandbox, rendered };
}

test("the console links moods and person cards both ways, read-only", async (t) => {
  const f = fixture(t),
    m = f.store.bind("agent-0");
  m.person("30000", "老王");
  m.person("30002", "路人<b>");
  const e = said(m, "以后叫我阿明就行");
  m.identity.savePersonCard(
    { personId: "30000", call: "阿明", body: "老朋友", evidence: [e.id] },
    { writtenIn: scope, now: Date.now() },
  );
  const sorry = said(m, "对不起，给你买了奶茶");
  const stranger = said(m, "路过", "30002");
  // The agent's own account and its outgoing messages are never "about" anyone.
  const own = said(m, "我自己说的", "10000");
  const out = said(m, "发出去的", "30001", { direction: "out" });
  const t0 = Date.now();
  const angry = m.identity.setMood(
    {
      mood: "生气",
      intensity: 3,
      reason: "被放鸽子",
      evidence: [own.id, out.id],
    },
    { writtenIn: scope, now: t0 },
  );
  const better = m.identity.setMood(
    {
      mood: "消气了",
      intensity: 2,
      reason: "阿明道歉了",
      evidence: [sorry.id, stranger.id],
    },
    { writtenIn: scope, now: t0 + 1 },
  );
  m.identity.setMood(
    { clear: true, reason: "回到平常", evidence: [sorry.id] },
    { writtenIn: scope, now: t0 + 2 },
  );
  const titles = [];
  for (const title of ["一", "二", "三", "四"]) {
    titles.push(title);
    m.diaryWrite({ title, body: "关于阿明", people: ["30000"] });
    await new Promise((r) => setTimeout(r, 2));
  }

  const token = randomBytes(32).toString("hex"),
    app = createServer({ runtime: f.runtime, token });
  const port = await app.listen();
  t.after(() => app.close());
  const api = async (route) =>
    (
      await fetch(`http://127.0.0.1:${port}${route}`, {
        headers: { "x-admin-token": token },
      })
    ).json();
  const data = await api("/api/mind?agentId=agent-0");
  const byId = new Map(data.mood.history.map((x) => [x.id, x]));
  assert.deepEqual(byId.get(angry.id).people, []);
  assert.deepEqual(byId.get(better.id).people, [
    { personId: "30000", call: "阿明", name: "老王", card: true },
    { personId: "30002", call: "", name: "路人<b>", card: false },
  ]);
  const card = data.personCards.find((c) => c.personId === "30000");
  assert.deepEqual(
    card.moods.map((x) => [x.action, x.mood ?? null, x.reason]),
    [
      ["clear", null, "回到平常"],
      ["set", "消气了", "阿明道歉了"],
    ],
  );
  assert.deepEqual(Object.keys(card.moods[1]).sort(), [
    "action",
    "id",
    "intensity",
    "mood",
    "reason",
    "writtenAt",
  ]);
  assert.deepEqual(
    card.diaries.map((d) => d.title),
    ["四", "三", "二"],
  );
  // Nothing about the link is stored on the mood or the card.
  assert.equal(m.identity.moodHistory(1)[0].people, undefined);
  assert.equal(m.identity.personCard("30000").moods, undefined);

  const { sandbox, rendered } = consoleScripts(api);
  sandbox.data = data;
  const log = vm.runInContext("moodMarkup(data.mood, Date.now())", sandbox);
  assert.match(
    log,
    /<button type="button" class="mood-person" data-mood-person="30000"[^>]*>阿明<\/button>/,
  );
  // No card: shown by QQ name, not clickable, and escaped.
  assert.match(log, /<span class="mood-person"[^>]*>路人&#60;b&#62;<\/span>/);
  assert.doesNotMatch(log, /data-mood-person="30002"/);
  const detail = vm.runInContext(
    "personDetail(data.personCards.find((c) => c.personId === '30000'))",
    sandbox,
  );
  assert.match(
    detail,
    /相关心情[\s\S]*消气了[\s\S]*强度 2\/5[\s\S]*阿明道歉了/,
  );
  assert.match(detail, /心情过去了/);
  assert.match(detail, /相关日记[\s\S]*四[\s\S]*三[\s\S]*二/);
  assert.doesNotMatch(detail, /<strong>一<\/strong>/);
  // A card with neither shows neither section.
  assert.doesNotMatch(
    vm.runInContext(
      "personDetail({ personId: '30009', call: '', body: 'x', revision: 1, updatedAt: 0 })",
      sandbox,
    ),
    /相关心情|相关日记/,
  );
  // Clicking a name on the mood timeline opens that card on the people tab.
  sandbox.document.chips = [{ dataset: { moodPerson: "30000" } }];
  vm.runInContext("bindMood(data.mood, Date.now())", sandbox);
  sandbox.document.chips[0].onclick();
  assert.equal(sandbox.tab, "people");
  assert.equal(vm.runInContext("peopleOpen", sandbox), "30000");
  assert.deepEqual(rendered, ["people"]);

  // Still read-only: there is no way to change a mood from the console.
  const change = await fetch(`http://127.0.0.1:${port}/api/mood`, {
    method: "POST",
    headers: { "x-admin-token": token },
    body: JSON.stringify({ agentId: "agent-0", clear: true, reason: "x" }),
  });
  assert.equal(change.ok, false);
});
