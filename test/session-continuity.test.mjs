import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import path from "node:path";
import { fixture, config, temp, FakeTransport } from "./helpers.mjs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { CodexBackend } from "../src/backends/codex.mjs";
import { DshBackend } from "../src/backends/dsh.mjs";
import { Runtime } from "../src/core/runtime.mjs";
import { ConfigStore } from "../src/core/config.mjs";
import { restoreExport } from "../src/memory/migrate.mjs";
import { MemoryStore } from "../src/memory/store.mjs";
import { retireSession } from "../src/core/session-records.mjs";
const chat = "group:20000",
  tick = () => new Promise((r) => setImmediate(r));

if (process.argv[2] === "--crash-compaction") {
  const root = process.argv[3],
    store = new MemoryStore(path.join(root, "memory.sqlite"));
  const cfg = new ConfigStore(path.join(root, "config.json"), config(1));
  const runtime = new Runtime({
    memory: store,
    configStore: cfg,
    backendFactory: () => ({
      async run(p) {
        p.saveSession({ backend: "codex", id: "interrupted-compact" });
        p.onUsage({
          source: "measured",
          contextTokens: 19000,
          capacityTokens: 20000,
        });
      },
      async compact() {
        process.exit(77);
      },
    }),
  });
  runtime.transports.set("qq-0", new FakeTransport());
  await runtime.wake("agent-0", chat);
  throw Error("EXPECTED_COMPACTION");
}

test("N3 process death during compaction retains a running recovery marker until archival", async (t) => {
  const root = temp(t),
    child = spawnSync(
      process.execPath,
      [fileURLToPath(import.meta.url), "--crash-compaction", root],
      { encoding: "utf8" },
    );
  assert.equal(child.status, 77, child.stderr);
  const store = new MemoryStore(path.join(root, "memory.sqlite")),
    cfg = new ConfigStore(path.join(root, "config.json"), config(1));
  const before = store.bind("agent-0").identity.list("model_turns")[0];
  assert.equal(before.status, "running");
  assert.equal(before.phase, "compacting");
  const runtime = new Runtime({
    memory: store,
    configStore: cfg,
    backendFactory: () => {
      throw Error("NO_BACKEND_CALL");
    },
  });
  try {
    const m = store.bind("agent-0");
    assert.equal(m.state(chat).session, null);
    assert.equal(m.identity.list("session_history").length, 1);
    assert.equal(
      m.identity.list("session_history")[0].session.id,
      "interrupted-compact",
    );
    assert.equal(m.identity.list("model_turns")[0].status, "interrupted");
  } finally {
    await runtime.close();
    store.close();
  }
});

class Rpc extends EventEmitter {
  constructor(mode, onReady) {
    super();
    this.mode = mode;
    this.onReady = onReady;
    this.interrupts = 0;
  }
  async start() {}
  async request(method, args) {
    if (method === "account/read") return { account: { type: "fixture" } };
    if (method === "model/list") return { data: [] };
    if (method === "thread/start") {
      if (this.mode === "creation-cancel") this.onReady();
      return { thread: { id: "codex-session" } };
    }
    if (method === "thread/resume" && this.mode === "resume-error")
      throw Error("transport credential must not be archived");
    if (method === "turn/interrupt") {
      this.interrupts++;
      return {};
    }
    if (method === "turn/start") {
      this.emit("notification", {
        method: "turn/started",
        params: { threadId: args.threadId, turn: { id: "native-turn" } },
      });
      if (this.mode === "cancel") this.onReady();
      else
        queueMicrotask(() =>
          this.emit("notification", {
            method: "turn/completed",
            params: {
              threadId: args.threadId,
              turn: {
                id: "native-turn",
                status: this.mode === "success" ? "completed" : "failed",
              },
            },
          }),
        );
      return { turn: { id: "native-turn" } };
    }
    return {};
  }
  respond() {}
  reject() {}
  close() {}
}
function dsh(mode, onReady) {
  const queue = [];
  let wake;
  const ok = (value) => ({ result: { ok: true, value } });
  const push = (event) => {
    queue.push(event);
    wake?.();
    wake = null;
  };
  const event = (type, data) => ({
    payload: {
      type: "session/event",
      sessionId: "dsh-session",
      event: { type, data },
    },
  });
  const client = {
    agentPresets: { list: async () => ok({ presets: [{ id: "qq-unified" }] }) },
    workspace: {
      create: async () => ok({ workspace: { workspaceId: "workspace" } }),
    },
    sessions: {
      create: async () => {
        if (mode === "creation-cancel") onReady();
        return ok({ sessionId: "dsh-session" });
      },
      selectModel: async () => {
        if (mode === "model-error")
          throw Error("private endpoint credential must not be archived");
        return ok({});
      },
      prompt: async () => {
        push(event("turn/start", { turn: "native-turn" }));
        if (mode === "cancel") setImmediate(onReady);
        else
          push(
            event("turn/end", {
              turn: "native-turn",
              reason: { kind: mode === "success" ? "completed" : "failed" },
            }),
          );
        return ok({});
      },
    },
    events: {
      follow: () =>
        push({
          payload: { type: "session/snapshot", sessionId: "dsh-session" },
        }),
      forget() {},
      async *mux(_, signal, ready) {
        ready();
        signal.addEventListener("abort", () => wake?.(), { once: true });
        while (!signal.aborted) {
          while (queue.length) yield queue.shift();
          if (!signal.aborted) await new Promise((r) => (wake = r));
        }
      },
    },
    callUnary: async () => ok({}),
  };
  return client;
}

for (const backendType of ["codex", "dsh"])
  for (const lane of ["chat", "subject"])
    for (const mode of ["failure", "cancel", "creation-cancel"])
      test(`N3 ${backendType} ${lane} ${mode} retains session and turn references without replay`, async (t) => {
        const cfg = config(1);
        cfg.agents[0].subject.enabled = true;
        const f = fixture(t, { cfg }),
          m = f.store.bind("agent-0"),
          scope = lane === "subject" ? "@subject" : chat;
        const abort = () => {
          for (const ctx of f.runtime.capabilities.values())
            ctx.controller.abort();
        };
        const factory = (b, a) =>
          backendType === "codex"
            ? new CodexBackend(b, a, {
                root: f.root,
                rpc: new Rpc(mode, abort),
              })
            : new DshBackend(
                { ...b, preset: "qq-unified", model: "fixture" },
                a,
                { root: f.root, client: dsh(mode, abort) },
              );
        f.runtime.backendFactory = factory;
        m.reserveDelivery("prior-unknown", chat, { text: "synthetic" });
        m.completeDelivery("prior-unknown", "unknown");
        const result = await f.runtime.wake("agent-0", scope);
        assert.equal(
          result.status,
          mode === "failure" ? "failed" : "cancelled",
        );
        assert.equal(m.state(scope).session, null);
        const history = m.identity.list("session_history"),
          turns = m.identity.list("model_turns");
        assert.equal(history.length, 1);
        assert.equal(history[0].session.id, backendType + "-session");
        assert.equal(history[0].conversation, scope);
        assert.equal(turns.length, 1);
        assert.equal(history[0].turnId, turns[0].id);
        assert.equal(turns[0].backendSession.id, history[0].session.id);
        assert.equal(turns[0].sessionHistoryId, history[0].id);
        assert.equal(turns[0].backendId, cfg.agents[0].backendId);
        if (mode !== "creation-cancel")
          assert.equal(turns[0].backendTurnId, "native-turn");
        assert(!JSON.stringify(history).includes("credential"));
        retireSession(m, scope, "process-recovery", Date.now(), {
          turnId: turns[0].id,
        });
        assert.equal(m.identity.list("session_history").length, 1);
        assert.equal(m.delivery("prior-unknown").status, "unknown");
        assert.equal(
          [...f.runtime.transports.values()].reduce(
            (n, t) => n + t.sent.length,
            0,
          ),
          0,
        );
      });

test("DSH connection preparation preserves an existing transcript and resumes it after recovery", async (t) => {
  const cfg = config(1);
  cfg.backends[0].type = "dsh";
  cfg.backends[0].preset = "qq-unified";
  cfg.agents[0].contextPolicy.capacityTokens = 1000000;
  const f = fixture(t, { cfg }),
    client = dsh("success", () => {});
  let created = 0;
  const create = client.sessions.create;
  client.sessions.create = async (...args) => {
    created++;
    return create(...args);
  };
  const backend = new DshBackend(cfg.backends[0], cfg.agents[0], {
    root: f.root,
    client,
  });
  f.runtime.backends.set("agent-0", backend);
  await f.runtime.wake("agent-0", chat);
  const memory = f.store.bind("agent-0"),
    original = memory.state(chat).session;
  const ready = backend.ready.bind(backend);
  backend.ready = async () => {
    throw Error("DSH_NOT_READY");
  };
  await f.runtime.wake("agent-0", chat);
  assert.deepEqual(memory.state(chat).session, original);
  backend.ready = ready;
  await f.runtime.wake("agent-0", chat);
  assert.equal(created, 1);
  assert.equal(memory.identity.list("session_history").length, 0);
});

test("N3 errors before adapter turn try blocks still archive a new DSH or resumed Codex session", async (t) => {
  for (const type of ["dsh", "codex"]) {
    const cfg = config(1);
    cfg.agents[0].contextPolicy.capacityTokens = 131072;
    const f = fixture(t, { cfg }),
      m = f.store.bind("agent-0");
    let b;
    if (type === "dsh")
      b = new DshBackend(
        { preset: "qq-unified", model: "fixture" },
        f.runtime.agent("agent-0"),
        { root: f.root, client: dsh("model-error", () => {}) },
      );
    else {
      const rpc = new Rpc("success", () => {});
      b = new CodexBackend({}, f.runtime.agent("agent-0"), {
        root: f.root,
        rpc,
      });
      f.runtime.backends.set("agent-0", b);
      await f.runtime.wake("agent-0", chat);
      rpc.mode = "resume-error";
    }
    f.runtime.backends.set("agent-0", b);
    assert.equal((await f.runtime.wake("agent-0", chat)).status, "failed");
    assert.equal(m.state(chat).session, null);
    assert.equal(
      m.identity.list("session_history")[0].session.id,
      type + "-session",
    );
    assert(
      !JSON.stringify(m.identity.list("session_history")).includes(
        "credential",
      ),
    );
  }
});

test("N3 process recovery archives chat and subject before clearing, only closes legacy learner turns; restart and JSON restore are idempotent", async (t) => {
  const root = temp(t),
    file = path.join(root, "db.sqlite"),
    cfg = new ConfigStore(path.join(root, "config.json"), config(1));
  let db = new MemoryStore(file),
    m = db.bind("agent-0");
  for (const scope of [chat, "@subject", "learner:" + chat]) {
    const id = "turn:" + scope,
      session = {
        backend: "codex",
        id: "old:" + scope,
        signature: "contract-v2:synthetic",
        credential: "must-not-copy",
      };
    m.identity.put("model_turns", {
      id,
      conversation: scope,
      status: "running",
      backendId: "dedicated",
    });
    // Slang learner turns (removed in 0.5.3) can still be running in old data.
    if (scope.startsWith("learner:"))
      m.setState(chat, {
        ...m.state(chat),
        slang: { session, lastTurnId: id, throughSeq: 42 },
      });
    else
      m.setState(scope, {
        session,
        lastTurnId: id,
        readThroughSeq: 12,
        seenThroughSeq: 15,
      });
  }
  m.reserveDelivery("pending", chat, { text: "synthetic" });
  db.close();
  for (let i = 0; i < 2; i++) {
    db = new MemoryStore(file);
    const r = new Runtime({
      configStore: cfg,
      memory: db,
      backendFactory: () => ({}),
    });
    m = db.bind("agent-0");
    assert.equal(m.identity.list("session_history").length, 2);
    assert(
      m.identity
        .list("model_turns")
        .every(
          (x) =>
            x.status === "interrupted" &&
            (x.conversation.startsWith("learner:") ||
              (x.backendSession && x.sessionHistoryId)),
        ),
    );
    assert.equal(m.state(chat).session, null);
    // The old learner state is kept as it was, and its scope gets no state row.
    assert.equal(m.state(chat).slang.session.id, "old:learner:" + chat);
    assert.equal(m.state(chat).slang.throughSeq, 42);
    assert.equal(
      m.db
        .prepare("SELECT COUNT(*) n FROM runtime WHERE conversation LIKE ?")
        .get("learner:%").n,
      0,
    );
    assert.equal(m.state(chat).readThroughSeq, 12);
    assert.equal(m.delivery("pending").status, "unknown");
    assert(
      !JSON.stringify(m.identity.list("session_history")).includes(
        "must-not-copy",
      ),
    );
    const restored = new MemoryStore(":memory:");
    try {
      restoreExport(restored.bind("agent-0"), m.export());
      assert.deepEqual(
        restored
          .bind("agent-0")
          .identity.list("session_history")
          .sort((a, b) => a.id.localeCompare(b.id)),
        m.identity
          .list("session_history")
          .sort((a, b) => a.id.localeCompare(b.id)),
      );
      assert.deepEqual(
        restored
          .bind("agent-0")
          .identity.list("model_turns")
          .sort((a, b) => a.id.localeCompare(b.id)),
        m.identity.list("model_turns").sort((a, b) => a.id.localeCompare(b.id)),
      );
    } finally {
      restored.close();
    }
    await r.close();
    db.close();
  }
});

test("N3 a late session callback cannot overwrite another turn's active mapping", async (t) => {
  const f = fixture(t),
    m = f.store.bind("agent-0");
  let release, started;
  const ready = new Promise((r) => (started = r));
  f.runtime.backends.set("agent-0", {
    async run(p) {
      started();
      await new Promise((r) => (release = r));
      p.saveSession({
        backend: "codex",
        id: "late-session",
        token: "must-not-copy",
      });
      throw Error("cancelled");
    },
  });
  const job = f.runtime.wake("agent-0", chat);
  await ready;
  f.runtime.running.get("agent-0|" + chat).controller.abort();
  m.setState(chat, {
    ...m.state(chat),
    lastTurnId: "next-owner",
    session: { backend: "codex", id: "next-session" },
  });
  release();
  await job;
  assert.equal(m.state(chat).session.id, "next-session");
  assert.equal(
    m.identity.list("session_history")[0].session.id,
    "late-session",
  );
  assert(
    !JSON.stringify(m.identity.list("session_history")).includes(
      "must-not-copy",
    ),
  );
  await tick();
});
