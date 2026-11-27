import test from "node:test";
import assert from "node:assert/strict";
import { sessionSignature } from "../src/backends/session-contract.mjs";
import { cognitionContext } from "../src/dream/context-builder.mjs";
import { beginDesktopContext } from "../src/home/desktop-context.mjs";
import { DESKTOP_CONVERSATION } from "../src/home/desktop-decision.mjs";
import { config, fixture } from "./helpers.mjs";

const role = "agent-0";
const group = "group:20000";
const nativeSession = { id: "synthetic-qq-session", backend: "fixture" };
const patch = (operation) => ({
  schemaVersion: 1,
  operations: [operation],
  awakeningSummary: "",
  noChangesReason: null,
});
function append(f, dedupe, conversation = group) {
  return f.store.bind(role).append({
    dedupe,
    conversation,
    kind: "message.received",
    body: "实际读到的偏好",
    senderId: "30000",
    payload: {
      trustedInput: true,
      segments: [{ type: "at", data: { qq: "10000" } }],
    },
  });
}
function add(id, scopeId = "global") {
  return patch({
    op: "ADD",
    scopeId,
    category: "preference",
    subjectKey: "user:30000:music",
    evidenceIds: [id],
    importance: 0.7,
    confidence: 0.8,
    content: "喜欢听钢琴。",
    epistemicStatus: "reported",
    reason: "明确自述。",
  });
}

test("QQ delivers new versions incrementally and dream configuration retains the chat contract", async (t) => {
  const seen = [];
  let pending;
  const cfg = config(1);
  cfg.agents[0].contextPolicy.capacityTokens = 1000000;
  const f = fixture(t, {
    cfg,
    run: async (p) => {
      if (p.dream) {
        await p.callTool("dream_cognition_submit", pending);
        return;
      }
      seen.push({
        prompt: p.prompt,
        instructions: p.instructions,
        tools: p.tools,
        session: p.session,
      });
      p.saveSession(nativeSession);
    },
  });
  const memory = f.store.bind(role);
  let wakeCount = 0;
  const wake = () => {
    append(f, "chat-wake-" + ++wakeCount);
    return f.runtime.wake(role, group);
  };
  await wake();
  const originalSession = memory.state(group).session;
  assert.ok(
    originalSession,
    JSON.stringify(f.store.db.prepare("SELECT value FROM model_turns").all()),
  );
  assert.equal(originalSession.id, nativeSession.id);
  const enabled = structuredClone(f.runtime.config);
  enabled.agents[0].dream.enabled = true;
  await f.runtime.changeConfig(enabled, f.configStore.revision);
  assert.deepEqual(memory.state(group).session, originalSession);
  const first = append(f, "qq-context-first", "private:30000");
  pending = add(first.id);
  assert.equal((await f.runtime.dreams.run(role)).status, "COMMITTED");
  const { id } = f.store.db.prepare("SELECT id FROM cognitions").get();
  await wake();
  assert.match(seen[1].prompt, /喜欢听钢琴/);
  assert.match(seen[1].prompt, /"fromPrivate":true/);
  assert.equal(seen[1].session.id, nativeSession.id);
  assert.equal(seen[1].instructions, seen[0].instructions);
  assert.deepEqual(seen[1].tools, seen[0].tools);
  assert.equal(memory.state(group).cognitionsShown[id], 1);
  await wake();
  assert.doesNotMatch(seen[2].prompt, /长期认知|喜欢听钢琴/);

  const second = append(f, "qq-context-second");
  pending = patch({
    op: "UPDATE",
    targetId: id,
    expectedVersion: 1,
    evidenceIds: [second.id],
    content: "现在也喜欢听弦乐。",
    epistemicStatus: "reported",
    reason: "补充偏好。",
  });
  assert.equal((await f.runtime.dreams.run(role)).status, "COMMITTED");
  await wake();
  assert.match(seen[3].prompt, /现在也喜欢听弦乐/);
  assert.match(seen[3].prompt, /"fromPrivate":true/);
  assert.equal(memory.state(group).cognitionsShown[id], 2);
  assert.deepEqual(memory.state(group).session, originalSession);

  const off = structuredClone(f.runtime.config);
  off.agents[0].dream.enabled = false;
  await f.runtime.changeConfig(off, f.configStore.revision);
  f.runtime.contexts.retire(role, group, "fixture-new-session");
  await wake();
  assert.deepEqual(memory.state(group).cognitionsShown, {});
  await f.runtime.changeConfig(enabled, f.configStore.revision);
  await wake();
  assert.match(seen.at(-1).prompt, /现在也喜欢听弦乐/);
});

test("desktop shares the ordinary Session and records delivery only on native input receipt", async (t) => {
  const cfg = config();
  cfg.desktopHome.enabled = true;
  cfg.agents[0].dream.enabled = true;
  let pending;
  const f = fixture(t, {
    cfg,
    run: (p) => p.callTool("dream_cognition_submit", pending),
  });
  pending = add(append(f, "desktop-context").id);
  assert.equal((await f.runtime.dreams.run(role)).status, "COMMITTED");
  const memory = f.store.bind(role);
  const agent = f.runtime.agent(role);
  let lastSignature;
  const backend = {
    config: f.runtime.config.backends[0],
    sessionSignature(tools) {
      return (lastSignature = sessionSignature(this, tools));
    },
  };
  const begin = () => {
    const controller = new AbortController();
    const ctx = f.runtime.makeContext(role, DESKTOP_CONVERSATION, {
      controller,
      assertCurrent() {},
      decide() {},
      unified: true,
      kind: "chat",
    });
    return beginDesktopContext(
      f.runtime,
      ctx,
      agent,
      backend,
      { kind: "chat", messages: [], people: [] },
      controller.signal,
    );
  };
  const initial = begin();
  assert.match(initial.prompt, /喜欢听钢琴/);
  assert.equal(memory.state(DESKTOP_CONVERSATION).cognitionsShown, undefined);
  const { id } = f.store.db.prepare("SELECT id FROM cognitions").get();
  initial.onInputSubmitted();
  assert.deepEqual(memory.state(DESKTOP_CONVERSATION).cognitionsShown, {
    [id]: 1,
  });
  initial.managedContext.saveSession({
    id: "synthetic-desktop-session",
    backend: "codex",
    signature: lastSignature,
  });
  initial.managedContext.onCompleted();
  await initial.finish();
  const retained = begin();
  assert.equal(retained.managedContext.session.id, "synthetic-desktop-session");
  assert.equal(retained.instructions, initial.instructions);
  assert.doesNotMatch(retained.prompt, /喜欢听钢琴/);
  // The opening builder applies the same seen-version map across both surfaces.
  assert.equal(
    cognitionContext(
      f.runtime,
      { agentId: role, conversation: DESKTOP_CONVERSATION },
      { fresh: false },
    ).line,
    "",
  );
  const overBudget = {
    ...agent,
    dream: {
      ...agent.dream,
      budget: { ...agent.dream.budget, contextCoreChars: 8 },
    },
  };
  const runtime = { agent: () => overBudget, memory: f.store };
  assert.equal(
    cognitionContext(
      runtime,
      { agentId: role, conversation: DESKTOP_CONVERSATION },
      { fresh: true },
    ).line,
    "",
  );
});
