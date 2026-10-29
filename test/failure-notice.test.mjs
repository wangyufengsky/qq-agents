import test from "node:test";
import assert from "node:assert/strict";
import { fixture, config, settle } from "./helpers.mjs";

const scope = "private:30000";
const TEXT = "稍等，我刚才没接上";

function setup(t, { notice = {}, run } = {}) {
  const cfg = config(1);
  cfg.agents[0].behavior.failureNotice = {
    enabled: true,
    text: TEXT,
    cooldownMs: 600000,
    ...notice,
  };
  const f = fixture(t, {
    cfg,
    run:
      run ||
      (async () => {
        throw Error("BACKEND_DOWN_FIXTURE");
      }),
  });
  let now = Date.parse("2026-10-29T12:00:00Z");
  f.runtime.clock = () => new Date(now);
  const sent = () =>
    f.runtime.transports
      .get("qq-0")
      .sent.map((x) => x.segments.map((s) => s.data?.text).join(""));
  const wake = async (reason = "private", conversation = scope) => {
    await f.runtime.wake("agent-0", conversation, { reasons: [{ reason }] });
    await settle(f.runtime);
  };
  return { ...f, sent, wake, advance: (ms) => (now += ms) };
}

test("a failed turn someone addressed sends the fixed line once per cooldown", async (t) => {
  const f = setup(t);
  await f.wake();
  assert.deepEqual(f.sent(), [TEXT]);
  const m = f.store.bind("agent-0");
  const delivery = m.db
    .prepare("SELECT request_id, status FROM deliveries WHERE agent_id=?")
    .all("agent-0");
  assert.equal(delivery.length, 1);
  assert.match(delivery[0].request_id, /^turn-failure:/);
  assert.equal(delivery[0].status, "sent");
  // The line is archived as the agent's own message, so later turns see it.
  assert(
    m
      .conversation({ conversation: scope })
      .items.some((x) => x.type === "message.sent" && x.body === TEXT),
  );

  await f.wake("mention");
  assert.equal(f.sent().length, 1, "still cooling down");
  f.advance(600000);
  await f.wake("name");
  assert.deepEqual(f.sent(), [TEXT, TEXT]);
});

test("no line is sent when nobody addressed the agent or the feature is off", async (t) => {
  const ambient = setup(t);
  for (const reason of ["message", "question", "keyword", "replyCheck"])
    await ambient.wake(reason, "group:20000");
  assert.deepEqual(ambient.sent(), []);

  const off = setup(t, { notice: { enabled: false } });
  await off.wake();
  assert.deepEqual(off.sent(), []);
});

test("a turn that already tried to send gets no extra line", async (t) => {
  const f = setup(t, {
    run: async (p) => {
      await p.callTool("qq_send", { requestId: "partial", text: "先说一半" });
      throw Error("BACKEND_DOWN_FIXTURE");
    },
  });
  await f.wake();
  assert.deepEqual(f.sent(), ["先说一半"]);
});

test("silencing or pausing during the failed turn suppresses the line", async (t) => {
  let f;
  f = setup(t, {
    run: async () => {
      const m = f.store.bind("agent-0");
      m.setState(scope, {
        ...m.state(scope),
        silenceUntil: f.runtime.now() + 3600000,
      });
      throw Error("BACKEND_DOWN_FIXTURE");
    },
  });
  await f.wake();
  assert.deepEqual(f.sent(), []);

  let g;
  g = setup(t, {
    run: async () => {
      g.runtime.config.agents[0].paused = true;
      throw Error("BACKEND_DOWN_FIXTURE");
    },
  });
  await g.wake();
  assert.deepEqual(g.sent(), []);
});

test("a turn that times out before saying anything also gets the line", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = setup(t, {
    run: (p) =>
      new Promise((_, reject) =>
        p.signal.addEventListener("abort", () => reject(Error("ABORTED"))),
      ),
  });
  f.runtime.config.agents[0].behavior.turnTimeoutMs = 60000;
  const turn = f.runtime.wake("agent-0", scope, {
    reasons: [{ reason: "private" }],
  });
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
  t.mock.timers.tick(60000);
  await turn;
  await settle(f.runtime);
  assert.deepEqual(f.sent(), [TEXT]);
});

test("the notice text is bounded and defaults off", () => {
  const cfg = config(1);
  assert.deepEqual(cfg.agents[0].behavior.failureNotice, {
    enabled: false,
    text: "我刚才没接上，稍后再回你。",
    cooldownMs: 600000,
  });
});
