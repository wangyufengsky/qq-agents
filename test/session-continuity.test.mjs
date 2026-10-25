import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import path from "node:path";
import { fixture, config, temp } from "./helpers.mjs";
import { CodexBackend } from "../src/backends/codex.mjs";
import { DshBackend } from "../src/backends/dsh.mjs";
import { Runtime } from "../src/core/runtime.mjs";
import { ConfigStore } from "../src/core/config.mjs";
import { restoreExport } from "../src/memory/migrate.mjs";
import { MemoryStore } from "../src/memory/store.mjs";
import { retireSession } from "../src/core/session-records.mjs";
const chat = "group:20000",
  tick = () => new Promise((r) => setImmediate(r));

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
  for (const lane of ["chat", "subject", "learner"])
    for (const mode of ["failure", "cancel", "creation-cancel"])
      test(`N3 ${backendType} ${lane} ${mode} retains session and turn references without replay`, async (t) => {
        const cfg = config(1);
        cfg.agents[0].subject.enabled = true;
        cfg.agents[0].slang.enabled = true;
        const f = fixture(t, { cfg }),
          m = f.store.bind("agent-0"),
          scope =
            lane === "subject"
              ? "@subject"
              : lane === "learner"
                ? "learner:" + chat
                : chat;
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
        if (lane === "learner") {
          m.setState(chat, {
            slang: { entries: [], throughSeq: 0 },
            readThroughSeq: 0,
          });
          await f.runtime.learner.learn(f.runtime.agent("agent-0"), chat, [
            { id: "evidence", body: "synthetic", seq: 1 },
          ]);
          assert.equal(m.state(chat).slang.session, null);
          assert.equal(m.state(chat).slang.throughSeq, 0);
        } else {
          const result = await f.runtime.wake("agent-0", scope);
          assert.equal(
            result.status,
            mode === "failure" ? "failed" : "cancelled",
          );
          assert.equal(m.state(scope).session, null);
        }
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

test("N3 errors before adapter turn try blocks still archive a new DSH or resumed Codex session", async (t) => {
  for (const type of ["dsh", "codex"]) {
    const f = fixture(t, { cfg: config(1) }),
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

test("N3 process recovery archives chat, subject and learner before clearing; restart and JSON restore are idempotent", async (t) => {
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
    assert.equal(m.identity.list("session_history").length, 3);
    assert(
      m.identity
        .list("model_turns")
        .every(
          (x) =>
            x.status === "interrupted" &&
            x.backendSession &&
            x.sessionHistoryId,
        ),
    );
    assert.equal(m.state(chat).session, null);
    assert.equal(m.state(chat).slang.session, null);
    assert.equal(m.state(chat).slang.throughSeq, 42);
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
