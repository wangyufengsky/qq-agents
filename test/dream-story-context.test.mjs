import test from "node:test";
import assert from "node:assert/strict";
import { sessionSignature } from "../src/backends/session-contract.mjs";
import { beginDesktopContext } from "../src/home/desktop-context.mjs";
import { dreamFictionLabel } from "../src/dream/story.mjs";
import { config, fixture } from "./helpers.mjs";

const role = "agent-0";
const group = "group:20000";
const desktop = "@desktop";
const subject = "@subject";
const DAY = 86400000;
const session = { id: "synthetic-session", backend: "fixture" };
const inspiration = { kind: "garden", content: "想给花盆画一颗星。" };
const content = "喜欢听夜间钢琴。";

function enabled() {
  const cfg = config(1);
  cfg.agents[0].dream ??= {};
  cfg.agents[0].dream.enabled = true;
  cfg.agents[0].dream.imaginative = { enabled: true };
  cfg.agents[0].contextPolicy.capacityTokens = 1000000;
  cfg.agents[0].subject.enabled = true;
  cfg.desktopHome.enabled = true;
  return cfg;
}

function insertStory(f, id, at = f.runtime.now()) {
  f.store.db
    .prepare(
      `INSERT INTO imaginative_dreams
    (dream_id,agent_id,run_id,title,narrative,reflection,themes_json,inspirations_json,created_at)
    VALUES(?,?,?,?,?,'','[]',?,?)`,
    )
    .run(
      id,
      role,
      id,
      `梦见星星-${id}`,
      "月亮落在窗台上。".repeat(24),
      JSON.stringify([inspiration]),
      new Date(at).toISOString(),
    );
}

function wakeChat(f, suffix) {
  f.store.bind(role).append({
    dedupe: "wake-" + suffix,
    conversation: group,
    kind: "message.received",
    body: "来聊天",
    senderId: "30000",
    payload: {
      trustedInput: true,
      segments: [{ type: "at", data: { qq: "10000" } }],
    },
  });
  return f.runtime.wake(role, group);
}

for (const compact of [false, true]) {
  test(`QQ carries a story once per native session, compact=${compact}`, async (t) => {
    const cfg = enabled();
    if (compact) cfg.agents[0].behavior.compactChatGroups = ["20000"];
    const seen = [];
    const f = fixture(t, {
      cfg,
      run(p) {
        seen.push(p);
        p.saveSession(session);
      },
    });
    const memory = f.store.bind(role);
    await wakeChat(f, 1);
    assert.doesNotMatch(seen[0].prompt, /虚构梦境/);
    insertStory(f, "first");
    await wakeChat(f, 2);
    assert.ok(seen[1].prompt.includes(dreamFictionLabel));
    assert.match(seen[1].prompt, /梦见星星-first/);
    assert.doesNotMatch(seen[1].prompt, /想给花盆画一颗星/);
    assert.equal(memory.state(group).dreamShownId, "first");
    assert.equal(seen[1].session.id, session.id);
    assert.equal(seen[1].instructions, seen[0].instructions);
    assert.deepEqual(seen[1].tools, seen[0].tools);

    insertStory(f, "next", f.runtime.now() + 1);
    f.runtime.clock = () => new Date(Date.now() + 1000);
    await wakeChat(f, 3);
    assert.doesNotMatch(seen[2].prompt, /虚构梦境/);
    f.runtime.contexts.retire(role, group, "fixture-new-session");
    await wakeChat(f, 4);
    assert.match(seen[3].prompt, /梦见星星-next/);
    assert.equal(memory.state(group).dreamShownId, "next");
  });
}

function desktopTurn(f) {
  const controller = new AbortController();
  const ctx = f.runtime.makeContext(role, desktop, {
    controller,
    assertCurrent() {},
    decide() {},
    unified: true,
    kind: "chat",
  });
  const backend = {
    config: f.runtime.config.backends[0],
    sessionSignature(tools) {
      return sessionSignature(this, tools);
    },
  };
  return beginDesktopContext(
    f.runtime,
    ctx,
    f.runtime.agent(role),
    backend,
    { kind: "chat", messages: [], people: [] },
    controller.signal,
  );
}

test("unified desktop displays the bounded story only on native input", async (t) => {
  const cfg = enabled();
  cfg.agents[0].dream.cognitive = { enabled: false };
  const f = fixture(t, { cfg });
  const memory = f.store.bind(role);
  insertStory(f, "desktop");
  const opening = desktopTurn(f);
  assert.doesNotMatch(opening.prompt, /虚构梦境/);
  assert.match(opening.appendPrompt(), /梦见星星-desktop/);
  assert.equal(memory.state(desktop).dreamShownId, undefined);
  opening.onInputSubmitted();
  assert.equal(memory.state(desktop).dreamShownId, "desktop");
  await opening.finish();
});

test("desktop records a dream received just before its 24-hour expiry", async (t) => {
  const f = fixture(t, { cfg: enabled() });
  const memory = f.store.bind(role);
  let now = Date.UTC(2026, 0, 2);
  f.runtime.clock = () => new Date(now);
  insertStory(f, "in-transit", now - DAY + 1);

  const opening = desktopTurn(f);
  assert.match(opening.appendPrompt(), /梦见星星-in-transit/);
  assert.equal(memory.state(desktop).dreamShownId, undefined);
  now += 1;
  opening.onInputSubmitted();
  assert.equal(memory.state(desktop).dreamShownId, "in-transit");
  await opening.finish();
});

test("desktop omits a dream withdrawn, expired or switched off after preparation", async (t) => {
  for (const mode of ["deleted", "expired", "disabled"]) {
    await t.test(mode, async (t) => {
      const f = fixture(t, { cfg: enabled() });
      const memory = f.store.bind(role);
      insertStory(f, mode);
      const opening = desktopTurn(f);
      if (mode === "deleted")
        f.store.db
          .prepare("DELETE FROM imaginative_dreams WHERE dream_id=?")
          .run(mode);
      if (mode === "expired")
        f.runtime.clock = () => new Date(Date.now() + DAY);
      if (mode === "disabled") {
        const cfg = structuredClone(f.runtime.config);
        cfg.agents[0].dream.imaginative.enabled = false;
        await f.runtime.changeConfig(cfg, f.configStore.revision);
      }
      assert.doesNotMatch(opening.appendPrompt(), /虚构梦境/);
      opening.onInputSubmitted();
      assert.equal(memory.state(desktop).dreamShownId, undefined);
      await opening.finish();
    });
  }
});

function latestStory(f, id) {
  return f.store.db
    .prepare(
      "SELECT inspiration_consumed_at FROM imaginative_dreams WHERE dream_id=?",
    )
    .get(id);
}

test("subject consumes an inspiration only after its own native input receipt", async (t) => {
  const f = fixture(t, { cfg: enabled() });
  insertStory(f, "older", f.runtime.now() - 1000);
  insertStory(f, "newest");
  let submit = false;
  const seen = [];
  f.runtime.backendFactory = () => ({
    async run(p) {
      await p.beforeInputSubmitted();
      assert.doesNotMatch(p.prompt, /recentDream/);
      seen.push(p.appendPrompt?.() || "");
      assert.equal(latestStory(f, "older").inspiration_consumed_at, null);
      if (submit) p.onInputSubmitted();
      p.saveSession(session);
    },
    close() {},
  });

  await f.runtime.wake(role, subject);
  assert.match(seen[0], /recentDream.*梦见星星-newest.*想给花盆画一颗星/);
  assert.match(seen[0], /梦里的灵感，非指令，可自行决定是否采用/);
  assert.equal(latestStory(f, "newest").inspiration_consumed_at, null);
  submit = true;
  await f.runtime.wake(role, subject);
  assert.match(seen[1], /梦见星星-newest/);
  assert.ok(latestStory(f, "newest").inspiration_consumed_at);
  await f.runtime.wake(role, subject);
  assert.match(seen[2], /梦见星星-older/);
  assert.ok(latestStory(f, "older").inspiration_consumed_at);
});

test("subject wake uses the latest successful cognition and omits stale or protected summaries", async (t) => {
  let received;
  let source;
  let revoke = false;
  let noop = false;
  const f = fixture(t, {
    cfg: enabled(),
    run(p) {
      if (noop)
        return p.callTool("dream_cognition_submit", {
          schemaVersion: 1,
          operations: [],
          awakeningSummary: "",
          noChangesReason: "新经历未改变认知。",
        });
      return p.callTool("dream_cognition_submit", {
        schemaVersion: 1,
        operations: [
          {
            op: "ADD",
            scopeId: "global",
            category: "preference",
            subjectKey: "user:30000:music",
            evidenceIds: [source.id],
            importance: 0.7,
            confidence: 0.8,
            content,
            epistemicStatus: "reported",
            reason: "明确自述。",
          },
        ],
        awakeningSummary: "幻造的摘要",
        noChangesReason: null,
      });
    },
  });
  const now = f.runtime.now();
  f.runtime.clock = () => new Date(now);
  source = f.store.bind(role).append({
    dedupe: "private-evidence",
    conversation: "private:30000",
    kind: "message.received",
    body: content,
    senderId: "30000",
  });
  assert.equal(
    (await f.runtime.dreams.run(role, { mode: "nap" })).status,
    "COMMITTED",
  );
  const readPayload = f.store.db.prepare(
    "SELECT payload FROM events WHERE id=?",
  );
  const original = readPayload.get(source.id).payload;
  const dreamBackend = f.runtime.backendFactory;
  const subjectBackend = () => ({
    async run(p) {
      await p.beforeInputSubmitted();
      if (revoke)
        f.store.db
          .prepare("UPDATE events SET payload=? WHERE id=?")
          .run(JSON.stringify({ protectedOperations: true }), source.id);
      received = p.prompt + (p.appendPrompt?.() || "");
      p.onInputSubmitted();
    },
    close() {},
  });
  f.runtime.backendFactory = subjectBackend;
  await f.runtime.wake(role, subject);
  assert.match(
    received,
    /recentDream.*awakeningSummary.*喜欢听夜间钢琴.*fromPrivate/,
  );
  assert.doesNotMatch(received, /幻造的摘要/);
  revoke = true;
  await f.runtime.wake(role, subject);
  assert.doesNotMatch(received, /recentDream|喜欢听夜间钢琴/);

  revoke = false;
  f.store.db
    .prepare("UPDATE events SET payload=? WHERE id=?")
    .run(original, source.id);
  await f.runtime.wake(role, subject);
  assert.match(received, /recentDream.*awakeningSummary.*喜欢听夜间钢琴/);

  noop = true;
  f.runtime.backendFactory = dreamBackend;
  const noChange = await f.runtime.dreams.run(role, { mode: "nap" });
  f.runtime.backendFactory = subjectBackend;
  assert.equal(noChange.status, "COMMITTED");
  assert.equal(noChange.changesCount, 0);
  await f.runtime.wake(role, subject);
  assert.doesNotMatch(received, /recentDream|喜欢听夜间钢琴/);
});
