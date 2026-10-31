import test from "node:test";
import assert from "node:assert/strict";
import { fixture, config, FakeTransport } from "./helpers.mjs";
import {
  sessionSignature,
  acceptsSession,
} from "../src/backends/session-contract.mjs";
const cases = [
  [
    "subject tool budget",
    (c) => (c.agents[0].subject.maxToolCallsPerTurn = 30),
    true,
  ],
  ["subject interval", (c) => (c.agents[0].subject.intervalMs = 7200000), true],
  [
    "subject daily checks",
    (c) => (c.agents[0].subject.maxChecksPerDay = 20),
    true,
  ],
  [
    "subject contacts limit",
    (c) => (c.agents[0].subject.maxContactsPerDay = 10),
    true,
  ],
  ["wake participation", (c) => (c.agents[0].wake.participation = 0.5), true],
  ["wake cooldown", (c) => (c.agents[0].wake.cooldownMs = 2000), true],
  ["wake keywords", (c) => (c.agents[0].wake.keywords = ["sample"]), true],
  ["send rate", (c) => (c.agents[0].behavior.maxSendPerHour = 80), true],
  [
    "context capacity increase",
    (c) => (c.agents[0].contextPolicy.capacityTokens = 1500000),
    true,
  ],
  [
    "context idle delay",
    (c) => (c.agents[0].contextPolicy.idleMs = 3600000),
    true,
  ],
  [
    "clock timezone",
    (c) => (c.agents[0].behavior.proactive.timezone = "UTC"),
    true,
  ],
  [
    "failure notice text",
    (c) => (c.agents[0].behavior.failureNotice.text = "稍后回复。"),
    true,
  ],
  [
    "self review delay",
    (c) => (c.agents[0].selfPolicy.minorDelayMs = 3600000),
    true,
  ],
  [
    "initial persona template",
    (c) => (c.agents[0].persona = "新的初始化模板"),
    true,
  ],
  ["disabled TTS voice", (c) => (c.agents[0].voice.tts.voice = "Alex"), true],
  ["tool order", (c) => c.agents[0].tools.reverse(), true],
  ["administrator order", (c) => c.agents[0].ownerIds.reverse(), true],
  ["alias order", (c) => c.agents[0].aliases.reverse(), true],
  ["allow list order", (c) => c.agents[0].allow.groups.reverse(), true],
  ["backend label", (c) => (c.backends[0].label = "New label"), true],
  [
    "backend reconnect policy",
    (c) => (c.backends[0].recovery.autoReconnect = true),
    true,
  ],
  [
    "connection label",
    (c) => (c.connections[0].label = "New connection label"),
    true,
  ],
  [
    "connection retry policy",
    (c) => (c.connections[0].recovery.maxAttempts = 9),
    true,
  ],
  [
    "connection admin web URL",
    (c) => (c.connections[0].webUrl = "http://127.0.0.1:10"),
    true,
  ],
  [
    "unused Codex preset",
    (c) => (c.backends[0].preset = "unused-preset"),
    true,
  ],
  [
    "global peer conversation limit",
    (c) => (c.peerLimit.maxMessages = 7),
    true,
  ],
  ["private-like group policy", (c) => (c.privateLikeGroups = ["20000"]), true],
  ["peer alias change", (c) => (c.agents[1].aliases = ["peer"]), true],
  ["model change", (c) => (c.agents[0].model = "another-model"), false],
  ["administrator change", (c) => (c.agents[0].ownerIds = ["30001"]), false],
  ["own account change", (c) => (c.connections[0].accountId = "10009"), false],
  ["appearance change", (c) => (c.agents[0].appearance = "另一形象"), false],
];
async function runCase(t, name, change, expectedRetain, scope, active) {
  const cfg = config(2);
  Object.assign(cfg.agents[0], {
    appearance: "固定形象",
    ownerIds: ["30000", "30001"],
    aliases: ["first", "second"],
  });
  Object.assign(cfg.agents[0].subject, {
    enabled: true,
    sessionMode: "continuous",
  });
  cfg.agents[0].contextPolicy.capacityTokens = 1000000;
  const f = fixture(t, { cfg });
  let creates = 0,
    hold = false,
    release,
    entered;
  let entry = new Promise((r) => (entered = r));
  f.runtime.backendFactory = (c) => {
    const b = {
      config: c,
      sessionSignature: (tools) => sessionSignature(b, tools),
      acceptsSession: (s, t) => acceptsSession(b, s, t),
      close: async () => {},
      cancel: async () => {},
      run: async (p) => {
        p.saveSession(
          p.session || {
            id: "session-" + ++creates,
            backend: c.type,
            signature: sessionSignature(b, p.tools),
          },
        );
        p.onUsage({
          source: "measured",
          contextTokens: 1000,
          capacityTokens: 1000000,
        });
        if (hold) {
          entered();
          await new Promise((resolve, reject) => {
            release = resolve;
            p.signal.addEventListener("abort", () => reject(Error("ABORTED")), {
              once: true,
            });
          });
        }
      },
    };
    return b;
  };
  const m = f.store.bind("agent-0");
  let job;
  try {
    await f.runtime.wake("agent-0", scope);
    const original = m.state(scope).session.id;
    if (active) {
      hold = true;
      job = f.runtime.wake("agent-0", scope);
      await entry;
    }
    const ctx = f.runtime.running.get("agent-0|" + scope);
    const next = structuredClone(f.runtime.config);
    change(next);
    await f.runtime.changeConfig(next, f.configStore.revision);
    const aborted = ctx?.controller.signal.aborted || false;
    if (active) {
      hold = false;
      release();
      await job;
    }
    for (const c of f.runtime.config.connections)
      f.runtime.transports.set(c.id, new FakeTransport());
    await f.runtime.wake("agent-0", scope);
    const session = m.state(scope).session;
    const changed = session?.id !== original;
    assert.equal(
      changed,
      !expectedRetain,
      JSON.stringify(m.identity.list("session_history")),
    );
    if (expectedRetain) assert.equal(aborted, false);
    else if (active) {
      const retired = m.identity.list("session_history")[0];
      assert.equal(retired.details.source, "configuration");
      assert(retired.details.changes.length > 0);
      assert(
        retired.details.changes.every((key) =>
          /^(agent|backend|connection)\.[A-Za-z]+$/.test(key),
        ),
      );
    }
    assert.equal(
      [...f.runtime.transports.values()].flatMap((t) => t.sent).length,
      0,
    );
  } finally {
    hold = false;
    release?.();
    if (job) await job;
  }
}
for (const [name, change, expectedRetain] of cases)
  for (const scope of ["@subject", "group:20000"])
    for (const active of [false, true])
      test(`${name}: ${scope} ${active ? "active" : "idle"} session boundary`, (t) =>
        runCase(t, name, change, expectedRetain, scope, active));
