import test from "node:test";
import assert from "node:assert/strict";
import { fixture, config, context } from "./helpers.mjs";
import { SessionPreparationFailure } from "../src/backends/turn-failure.mjs";

const group = "group:20000",
  peer = "private:30000";
function setup(t, run) {
  const cfg = config(1);
  cfg.agents[0].contextPolicy.capacityTokens = 1000000;
  const f = fixture(t, { cfg, run });
  f.runtime.clock = () => new Date("2026-11-01T12:00:00Z");
  const memory = f.store.bind("agent-0");
  let seq = 0;
  const message = (conversation, body = "当前群消息") =>
    memory.append({
      dedupe: `elsewhere-${++seq}`,
      conversation,
      kind: "message.received",
      direction: "in",
      senderId: "30000",
      body,
      occurredAt: new Date(f.runtime.now() - 60000 + seq).toISOString(),
      payload: { segments: [{ type: "at", data: { qq: "10000" } }] },
    });
  const privateMessage = () => {
    const event = message(peer, "仅可回查的私聊正文");
    memory.setState(peer, { ...memory.state(peer), readThroughSeq: event.seq });
    return event;
  };
  return { ...f, memory, message, privateMessage };
}
function elsewhere(prompt) {
  const line = prompt.split("\n\n").find((s) => s.startsWith("别处近况（"));
  return line ? JSON.parse(line.slice(line.indexOf("）：") + 2)) : null;
}

test("chat prompts carry a private index once, update it, reset it with the session and leave read/send state intact", async (t) => {
  const prompts = [];
  let lookup = false;
  const f = setup(t, async (p) => {
    prompts.push(p);
    p.saveSession({ id: "fixture-session", backend: "fixture" });
    if (lookup) {
      const index = elsewhere(p.prompt).items[0];
      const before = structuredClone(f.memory.state(group));
      assert.ok(before.disclosureTaint.includes(index.continuation.id));
      await p.callTool("memory_read", { id: index.continuation.id });
      const after = f.memory.state(group);
      for (const key of [
        "readThroughSeq",
        "replyBatchSends",
        "replyInputSeq",
        "sendTimes",
      ])
        assert.deepEqual(after[key], before[key]);
    }
  });
  const first = f.privateMessage();
  f.message(group);
  lookup = true;
  await f.runtime.wake("agent-0", group);
  lookup = false;
  const index = elsewhere(prompts[0].prompt).items[0];
  assert.equal(index.where, "private");
  assert.equal(index.fromPrivate, true);
  assert.equal(index.continuation.id, first.id);
  assert.doesNotMatch(prompts[0].prompt, /仅可回查的私聊正文/);
  assert.equal(f.memory.state(peer).readThroughSeq, first.seq);
  assert.equal(f.memory.state(group).elsewhereShown["30000"], first.id);
  const turn = f.memory.identity.get(
    "model_turns",
    f.memory.state(group).lastTurnId,
  );
  assert.deepEqual(turn.elsewhere, [
    { personId: "30000", where: "private", id: first.id },
  ]);
  f.message(group);
  await f.runtime.wake("agent-0", group);
  assert.equal(elsewhere(prompts[1].prompt), null);
  const second = f.privateMessage();
  f.message(group);
  await f.runtime.wake("agent-0", group);
  assert.equal(
    elsewhere(prompts[2].prompt).items[0].continuation.id,
    second.id,
  );
  f.runtime.contexts.retire("agent-0", group, "test");
  f.message(group);
  await f.runtime.wake("agent-0", group);
  assert.equal(
    elsewhere(prompts[3].prompt).items[0].continuation.id,
    second.id,
  );
  assert.equal(prompts[3].instructions, prompts[0].instructions);
});

test("an unsubmitted failure restores elsewhere presentation deduplication for a retained session", async (t) => {
  let fail = false;
  const prompts = [];
  const f = setup(t, async (p) => {
    prompts.push(p.prompt);
    if (fail) throw new SessionPreparationFailure(Error("CODEX_DISCONNECTED"));
    p.saveSession({ id: "fixture-session", backend: "fixture" });
  });
  f.message(group);
  await f.runtime.wake("agent-0", group);
  const session = f.memory.state(group).session;
  const before = f.memory.state(group).elsewhereShown;
  f.privateMessage();
  f.message(group);
  fail = true;
  await f.runtime.wake("agent-0", group);
  assert.ok(elsewhere(prompts[1]));
  assert.deepEqual(f.memory.state(group).elsewhereShown, before);
  assert.deepEqual(f.memory.state(group).session, session);
  fail = false;
  await f.runtime.wake("agent-0", group);
  assert.ok(elsewhere(prompts[2]));
});

test("disabled elsewhere leaves the complete prompt byte-identical and config changes retain sessions", async (t) => {
  const prompts = [];
  const f = setup(t, async (p) => {
    prompts.push(p);
    p.saveSession({ id: "fixture-session", backend: "fixture" });
  });
  const cfg = structuredClone(f.runtime.config);
  cfg.agents[0].behavior.elsewhere.enabled = false;
  await f.runtime.changeConfig(cfg, f.configStore.revision);
  const ctx = context(f.runtime, "agent-0", group);
  const backend = {};
  const before = structuredClone(f.memory.state(group));
  const plain = f.runtime.contexts.prepare(ctx, backend, []);
  f.memory.setState(group, before);
  f.privateMessage();
  const indexed = f.runtime.contexts.prepare(
    context(f.runtime, "agent-0", group),
    backend,
    [],
  );
  assert.equal(indexed.prompt, plain.prompt);
  assert.equal(indexed.instructions, plain.instructions);
  await f.runtime.wake("agent-0", group);
  const session = f.memory.state(group).session;
  const enabled = structuredClone(f.runtime.config);
  enabled.agents[0].behavior.elsewhere.enabled = true;
  enabled.agents[0].behavior.elsewhere.windowMs = 7200000;
  await f.runtime.changeConfig(enabled, f.configStore.revision);
  await f.runtime.wake("agent-0", group);
  assert.deepEqual(f.memory.state(group).session, session);
  assert.equal(f.memory.identity.list("session_history").length, 0);
});

test("subject and protected work prompts never show elsewhere indices or set their deduplication", (t) => {
  const f = setup(t);
  f.privateMessage();
  const task = f.runtime.protectedWork.create({
    agentId: "agent-0",
    instruction: "检查测试资料",
  });
  for (const scope of ["@subject", "@work:" + task.id]) {
    const ctx = context(f.runtime, "agent-0", scope);
    const { prompt } = f.runtime.contexts.prepare(ctx, {}, []);
    assert.equal(elsewhere(prompt), null);
    assert.equal(f.memory.state(scope).elsewhereShown, undefined);
    assert.equal(
      f.memory.identity.get("model_turns", ctx.turnId).elsewhere,
      undefined,
    );
  }
});

test("a new session created while disabled forgets the previous session's elsewhere presentation", async (t) => {
  const prompts = [];
  let sessionNumber = 0;
  const f = setup(t, async (p) => {
    prompts.push(p.prompt);
    if (!p.session)
      p.saveSession({ id: `fixture-${++sessionNumber}`, backend: "fixture" });
  });
  const source = f.privateMessage();
  f.message(group);
  await f.runtime.wake("agent-0", group);
  assert.equal(elsewhere(prompts[0]).items[0].continuation.id, source.id);
  const configure = async (enabled) => {
    const cfg = structuredClone(f.runtime.config);
    cfg.agents[0].behavior.elsewhere.enabled = enabled;
    await f.runtime.changeConfig(cfg, f.configStore.revision);
  };
  await configure(false);
  f.message(group);
  await f.runtime.wake("agent-0", group);
  assert.equal(elsewhere(prompts[1]), null);
  assert.equal(f.memory.state(group).elsewhereShown["30000"], source.id);
  assert.ok(f.memory.state(group).disclosureTaint.includes(source.id));

  f.runtime.contexts.retire("agent-0", group, "test");
  f.message(group);
  await f.runtime.wake("agent-0", group);
  assert.equal(elsewhere(prompts[2]), null);
  assert.deepEqual(f.memory.state(group).elsewhereShown, {});
  const session = f.memory.state(group).session;
  const provenance = f.memory.state(group).disclosureTaint;
  await configure(true);
  f.message(group);
  await f.runtime.wake("agent-0", group);
  assert.equal(elsewhere(prompts[3]).items[0].continuation.id, source.id);
  assert.deepEqual(f.memory.state(group).session, session);
  for (const id of provenance)
    assert.ok(f.memory.state(group).disclosureTaint.includes(id));
});
