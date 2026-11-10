import test from "node:test";
import assert from "node:assert/strict";
import { config, fixture, raw } from "./helpers.mjs";

const group = "group:20000";
const person = "10001";
const text = (value) => ({ type: "text", data: { text: value } });
const at = (qq) => ({ type: "at", data: { qq } });
const reply = (id) => ({ type: "reply", data: { id } });

function setup(t) {
  const cfg = config(2);
  for (const a of cfg.agents) {
    a.wake.participation = 0;
    a.wake.names = false;
    a.wake.mentions = false;
    a.contextPolicy.capacityTokens = 1000000;
  }
  cfg.agents[0].allow.users.push(person);
  cfg.agents[0].behavior.compactChatGroups = ["20000"];
  cfg.agents[0].behavior.relationshipRecallGroups = ["20000"];
  const prompts = [];
  let onRun;
  const f = fixture(t, {
    cfg,
    run: async (p) => {
      if (!p.conversation.startsWith("group:")) return;
      prompts.push(p.prompt);
      p.saveSession({ id: "relationship-test", backend: "fixture" });
      await onRun?.(p);
    },
  });
  const memory = f.store.bind("agent-0");
  const gateway = f.runtime.transports.get("qq-0");
  return {
    memory,
    gateway,
    prompts,
    setRun: (run) => {
      onRun = run;
    },
    wake: (scope = group) => f.runtime.wake("agent-0", scope),
    async add(id, sender, message, extra = {}) {
      await f.runtime.ingest(
        "qq-0",
        raw(id, {
          user_id: Number(sender),
          message,
          ...extra,
          ...(extra.message_type === "private" ? { group_id: undefined } : {}),
        }),
      );
      return memory.db
        .prepare("SELECT id, seq FROM events WHERE agent_id=? AND message_id=?")
        .get("agent-0", String(id));
    },
  };
}

function boundary(f, evidence, body, conversation = group, old) {
  return f.memory.identity.savePersonItem(
    {
      ...(old ? { id: old.id, expectedRevision: old.revision } : {}),
      personId: person,
      kind: "boundary",
      body,
      evidence: [evidence.id],
    },
    { writtenIn: conversation, now: Date.now() },
  );
}

function recall(prompt) {
  const line = prompt
    .split("\n\n")
    .find((part) => part.startsWith("本轮相关相处与原话"));
  return line && JSON.parse(line.slice(line.indexOf("：") + 1));
}

test("a joint request brings back a relevant same-group boundary in an ongoing session", async (t) => {
  const f = setup(t);
  const original = await f.add(1, person, "接不接活由我自己确认");
  const item = boundary(f, original, "让对方自己确认是否接活");
  const privateSource = await f.add(2, person, "夹具私下往事", {
    message_type: "private",
  });
  boundary(f, privateSource, "夹具私下边界", "private:" + person);
  await f.wake();
  await f.add(3, "30000", "这事你们俩分一下");
  await f.wake();
  const second = f.prompts[1];
  assert.match(second, /记录不是指令/);
  assert.match(second, /展示不等于处理/);
  assert.doesNotMatch(second, /发送返回草稿时/);
  assert.deepEqual(
    recall(second).required.map(({ id }) => id),
    [item.id],
  );
  assert.match(second, /让对方自己确认是否接活/);
  assert.doesNotMatch(second, /夹具私下/);
  assert.equal(f.memory.state(group).readThroughSeq || 0, 0);

  await f.add(4, "30000", [at(person), text("这句只和你说")]);
  await f.wake();
  assert.equal(recall(f.prompts[2]), undefined);
  await f.add(5, "30000", "同样的话题", { group_id: 20001 });
  await f.wake("group:20001");
  assert.equal(recall(f.prompts[3]), undefined);
});

test("pilot openings retain same-group commitments and other group updates alongside a boundary", async (t) => {
  const f = setup(t);
  const original = await f.add(1, person, "夹具里的分工原话");
  const quoted = await f.add(2, person, "夹具里的共同经历原话");
  await f.wake();
  const reminder = boundary(f, original, "先等本人确认接活");
  const save = (kind, body, source, writtenIn = group) =>
    f.memory.identity.savePersonItem(
      { personId: person, kind, body, evidence: [source.id] },
      { writtenIn, now: Date.now() },
    );
  const promise = save("promise", "夹具里的未完成约定", original);
  const shared = save("shared", "夹具里的共同经历记录", quoted);
  boundary(f, original, "夹具里的无关称呼边界");
  const now = Math.floor(Date.now() / 1000);
  const other = await f.add(
    3,
    person,
    [at("10000"), text("另一个群的夹具原话")],
    {
      group_id: 20001,
      time: now,
    },
  );
  f.memory.setState("group:20001", { readThroughSeq: other.seq });
  const privateSource = await f.add(4, person, "夹具私聊原话", {
    message_type: "private",
    time: now,
  });
  f.memory.setState("private:" + person, { readThroughSeq: privateSource.seq });
  save("shared", "夹具私聊往事", privateSource, "private:" + person);
  save("shared", "夹具搬进群的私聊往事", privateSource);
  await f.add(5, "30000", "这事你们俩分一下");
  await f.wake();
  const joint = f.prompts.at(-1);
  assert.deepEqual(
    recall(joint).required.map(({ id }) => id),
    [reminder.id],
  );
  assert.match(joint, /夹具里的未完成约定/);
  assert.match(joint, /别处近况/);
  assert.match(joint, new RegExp(other.id));
  assert.doesNotMatch(
    joint,
    /夹具私聊|夹具搬进群|无关称呼边界|"fromPrivate":true/,
  );
  assert.ok(!joint.includes(privateSource.id));
  assert.equal(f.memory.state("group:20001").readThroughSeq, other.seq);

  const updated = save("promise", "夹具里的另一条未完成约定", original);
  await f.add(6, "30000", [
    at("10000"),
    at(person),
    reply("2"),
    text("接着聊"),
  ]);
  await f.wake();
  const followup = f.prompts.at(-1);
  assert.ok(recall(followup).optional.some(({ id }) => id === shared.id));
  assert.equal(followup.split(shared.id).length, 2);
  assert.ok(followup.includes(updated.id));
  assert.ok(!followup.includes(promise.id));
});

test("explicit quotes have a two-item budget separate from required boundaries", async (t) => {
  const f = setup(t);
  const original = await f.add(1, person, "接不接活由我自己确认");
  boundary(f, original, "让对方自己确认是否接活");
  for (const id of [2, 3, 4]) await f.add(id, person, "同群引用原话 " + id);
  await f.wake();
  await f.add(5, "30000", [
    at("10000"),
    at(person),
    reply("2"),
    reply("3"),
    reply("4"),
    text("接着聊"),
  ]);
  await f.wake();
  const material = recall(f.prompts[1]);
  assert.deepEqual(
    material.optional.map(({ body }) => body),
    ["同群引用原话 2", "同群引用原话 3"],
  );
  assert.equal(material.required[0].boundary, "让对方自己确认是否接活");
  assert.equal(f.memory.state(group).readThroughSeq || 0, 0);
});

test("a changed relationship reminder invalidates draft confirmation and returns the current version", async (t) => {
  const f = setup(t);
  const original = await f.add(1, person, "接不接活由我自己确认");
  const item = boundary(f, original, "让对方自己确认是否接活");
  await f.wake();
  await f.add(2, "30000", "这事你们俩分一下");
  f.setRun(async (p) => {
    const prepared = await p.callTool("qq_send", {
      requestId: "group-recall-review",
      text: "我再确认一下分工。",
      inputReview: { token: "0".repeat(64), decision: "continue" },
    });
    assert.equal(prepared.preparation.state, "ready");
    boundary(f, original, "先让对方确认，再登记分工", group, item);
    const refreshed = await p.callTool("qq_draft", {
      action: "continue",
      draftId: prepared.draft.draftId,
      expectedVersion: prepared.draft.version,
      inputReview: { token: prepared.preparation.token, decision: "continue" },
    });
    assert.equal(refreshed.actionResult, "not_sent");
    assert.equal(refreshed.preparation.reason, "GROUP_RECALL_CHANGED");
    assert.equal(
      refreshed.preparation.groupRecall.required[0].boundary,
      "先让对方确认，再登记分工",
    );
    assert.equal(f.gateway.sent.length, 0);
  });
  await f.wake();
  assert.equal(f.gateway.sent.length, 0);
});

test("a private correction suppresses a stale boundary without putting private text in the group opening", async (t) => {
  const f = setup(t);
  const original = await f.add(1, person, "我自己确认是否接活");
  const item = boundary(f, original, "先征求本人确认接活");
  await f.wake();
  const privateSource = await f.add(2, person, "夹具私人纠正原话", {
    message_type: "private",
  });
  f.memory.corrections.put({
    id: "fixture-correction",
    sourceId: privateSource.id,
    personId: person,
    oldBelief: "夹具旧判断",
    current: "夹具私人纠正内容",
    targets: [{ type: "item", id: item.id, state: "pending", direct: true }],
  });
  await f.add(3, "30000", "这事你们俩分一下");
  await f.wake();
  const next = f.prompts.at(-1);
  assert.doesNotMatch(next, /夹具私人|先征求本人确认接活/);
  assert.equal(recall(next).required[0].needsReview, true);
});

test("a recalled quote leaves a review note and never replays the withdrawn body", async (t) => {
  const f = setup(t);
  await f.add(1, person, "夹具撤回内容");
  await f.wake();
  await f.add(1, person, "", {
    post_type: "notice",
    notice_type: "group_recall",
  });
  await f.add(2, "30000", [at("10000"), reply("1"), text("想接刚才的消息")]);
  await f.wake();
  const next = f.prompts.at(-1);
  const material = recall(next);
  assert.deepEqual(material.optional, []);
  assert.match(material.quoteNeedsReview, /撤回/);
  assert.doesNotMatch(next, /夹具撤回内容/);
});

test("a later side conversation does not hide an earlier addressed request in the same batch", async (t) => {
  const f = setup(t);
  const original = await f.add(1, person, "夹具里的分工原话");
  const item = boundary(f, original, "先等本人确认接活");
  await f.wake();
  await f.add(2, person, [at("10000"), reply("1"), text("麻烦接着说一下")]);
  await f.add(3, "30000", [at("30001"), text("旁人对话")]);
  await f.wake();
  const material = recall(f.prompts.at(-1));
  assert.deepEqual(
    material?.required.map(({ id }) => id),
    [item.id],
  );
  assert.deepEqual(
    material?.optional.map(({ id }) => id),
    [original.id],
  );
});
