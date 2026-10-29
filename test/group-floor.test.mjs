import test from "node:test";
import assert from "node:assert/strict";
import { fixture, config, settle, raw } from "./helpers.mjs";

const text = (t) => ({ type: "text", data: { text: t } });
const at = (qq) => ({ type: "at", data: { qq } });
const reply = (id) => ({ type: "reply", data: { id: String(id) } });

function setup(t) {
  const cfg = config(1);
  Object.assign(cfg.agents[0].wake, { questions: true, participation: 0 });
  // Room for every turn in one session.
  cfg.agents[0].contextPolicy.capacityTokens = 1000000;
  const prompts = [],
    instructions = [];
  const f = fixture(t, {
    cfg,
    run: async (p) => {
      prompts.push(p.prompt);
      instructions.push(p.instructions);
      p.saveSession({ id: "s", backend: "fixture" });
    },
  });
  const ingest = async (id, segments, userId = 30000) => {
    await f.runtime.ingest(
      "qq-0",
      raw(id, { user_id: userId, message: segments }),
    );
    f.runtime.tick();
    await settle(f.runtime);
  };
  return { ...f, prompts, instructions, ingest };
}
const floorIn = (prompt) => {
  const part = prompt.split("\n\n").find((p) => p.startsWith("群聊现场"));
  return part ? JSON.parse(part.slice(part.indexOf("{"))) : null;
};
const ids14 = (m) =>
  m.db
    .prepare(
      "SELECT id FROM events WHERE agent_id='agent-0' AND kind='message.received' AND message_id='14'",
    )
    .get().id;
const turns = (f) =>
  f.store.bind("agent-0").identity.list("model_turns").length;

test("a question put to someone else does not wake the agent; one to the room does", async (t) => {
  const f = setup(t);
  // @ another member only.
  await f.ingest(1, [at("30001"), text(" 你今晚打本吗？")]);
  assert.equal(turns(f), 0);
  // Quoting another member's message.
  await f.ingest(2, [text("今天好累")], 30001);
  assert.equal(turns(f), 0);
  await f.ingest(3, [reply(2), text("怎么了？")]);
  assert.equal(turns(f), 0);
  // To the room, or @all, still wakes.
  await f.ingest(4, [text("有人知道这游戏几点开服吗？")]);
  assert.equal(turns(f), 1);
  await f.ingest(5, [at("all"), text(" 周末谁有空？")]);
  assert.equal(turns(f), 2);
  // @ the agent is a mention, whatever else it says.
  await f.ingest(6, [at("10000"), text(" 你觉得呢？")]);
  const reasons = f.store
    .bind("agent-0")
    .identity.list("model_turns")
    .map((x) => x.reason.join());
  assert.equal(reasons.length, 3);
  assert(reasons.includes("mention"));
});

test("a group turn says who is talking to whom, which questions others answered, and the agent's share", async (t) => {
  const f = setup(t);
  const m = f.store.bind("agent-0");
  // Two of the last messages were the agent's own.
  for (const [i, body] of ["早", "我也在"].entries())
    m.append({
      dedupe: "out" + i,
      conversation: "group:20000",
      connectionId: "qq-0",
      kind: "message.sent",
      direction: "out",
      body,
    });
  await f.ingest(10, [text("这个 boss 怎么打？")], 30002);
  await f.ingest(11, [reply(10), text("先打断它的读条")], 30001);
  await f.ingest(12, [at("30002"), text(" 记得带解控")]);
  await f.ingest(13, [at("10000"), text(" 你也来吗？")]);
  let floor = floorIn(f.prompts.at(-1));
  const ids = Object.fromEntries(
    m.db
      .prepare(
        "SELECT message_id, id FROM events WHERE agent_id='agent-0' AND kind='message.received'",
      )
      .all()
      .map((r) => [r.message_id, r.id]),
  );
  assert.deepEqual(floor.toYou, [ids["13"]]);
  assert.deepEqual(floor.betweenOthers, [
    { id: ids["11"], to: ["30002"] },
    { id: ids["12"], to: ["30002"] },
  ]);
  assert.deepEqual(floor.answeredByOthers, [{ id: ids["10"], by: ["30001"] }]);
  assert.deepEqual(floor.recent, { yours: 2, of: 6 });
  // Quoting the agent's own message is speaking to it.
  m.append({
    dedupe: "mine",
    conversation: "group:20000",
    connectionId: "qq-0",
    kind: "message.sent",
    direction: "out",
    messageId: "900",
    payload: { messageNamespace: "onebot" },
    body: "我先去打本了",
  });
  await f.ingest(14, [reply(900), text("等等我？")], 30001);
  floor = floorIn(f.prompts.at(-1));
  assert.deepEqual(floor.toYou, [ids14(m)]);
  assert.match(f.instructions[0], /问题已经有人答了，就不再补一篇总结/);
});

test("a private chat carries no group floor", async (t) => {
  const f = setup(t);
  await f.runtime.ingest(
    "qq-0",
    raw(20, {
      message_type: "private",
      group_id: undefined,
      user_id: 30000,
      message: [text("在吗？")],
    }),
  );
  f.runtime.tick();
  await settle(f.runtime);
  assert(f.prompts.length >= 1);
  assert.equal(floorIn(f.prompts.at(-1)), null);
});

test("a private question that quotes the user's own message still wakes the agent", async (t) => {
  const f = setup(t);
  // Only the question wake can wake it here.
  f.runtime.config.agents[0].wake.private = false;
  const dm = (id, message) =>
    f.runtime.ingest(
      "qq-0",
      raw(id, {
        message_type: "private",
        group_id: undefined,
        user_id: 30000,
        message,
      }),
    );
  await dm(30, [text("我上次说的那个游戏")]);
  f.runtime.tick();
  await settle(f.runtime);
  assert.equal(turns(f), 0);
  await dm(31, [reply(30), text("你后来玩了吗？")]);
  f.runtime.tick();
  await settle(f.runtime);
  assert.equal(turns(f), 1);
});
