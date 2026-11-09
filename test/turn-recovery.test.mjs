import test from "node:test";
import { EventEmitter } from "node:events";
import { CodexBackend } from "../src/backends/codex.mjs";
import assert from "node:assert/strict";
import { config, fixture } from "./helpers.mjs";
import { DshBackend } from "../src/backends/dsh.mjs";
import {
  BackendTurnFailure,
  dshTurnFailure,
  runWithRecovery,
} from "../src/backends/turn-failure.mjs";
import { retireSession } from "../src/core/session-records.mjs";

const chat = "group:20000";
const malformed = {
  kind: "error",
  error: {
    code: "MALFORMED_RESPONSE",
    message: "DeepSeek Messages stream: tool input is invalid JSON",
  },
};
const transportFailure = {
  kind: "error",
  error: { code: "TRANSPORT", message: "private provider detail" },
};
const ok = (value) => ({ result: { ok: true, value } });
function dshClient({
  reasons = [malformed, { kind: "completed" }],
  beforeEnd = async () => {},
  invalidSnapshot = false,
  onFollow = () => {},
} = {}) {
  const queue = [];
  const records = [];
  let wake;
  const push = (payload) => {
    if (payload.type === "session/event")
      records.push({ type: "event", event: payload.event });
    queue.push({ payload: { sessionId: "dsh-session", ...payload } });
    wake?.();
    wake = null;
  };
  const client = {
    prompts: [],
    creates: 0,
    invalidSnapshot,
    agentPresets: { list: async () => ok({ presets: [{ id: "qq-unified" }] }) },
    workspace: {
      create: async () => ok({ workspace: { workspaceId: "workspace" } }),
    },
    sessions: {
      create: async () => {
        client.creates++;
        return ok({ sessionId: "dsh-session" });
      },
      selectModel: async () => ok({}),
      prompt: async (request) => {
        client.prompts.push(request);
        const turn = client.prompts.length;
        push({
          type: "session/event",
          event: { type: "turn/start", data: { turn } },
        });
        await beforeEnd(turn);
        push({
          type: "session/event",
          event: {
            type: "turn/end",
            data: { turn, reason: reasons[turn - 1] || malformed },
          },
        });
        return ok({});
      },
    },
    events: {
      follow: () => {
        const snapshotRecords = [...records];
        onFollow(client, snapshotRecords);
        push({
          type: "session/snapshot",
          snapshot: {
            records: snapshotRecords,
            projections: {
              values: {
                inbox: {
                  "next-turn": client.invalidSnapshot ? [{ id: "queued" }] : [],
                  "next-step": [],
                },
              },
            },
          },
        });
      },
      forget() {},
      async *mux(_, signal, ready) {
        ready();
        signal.addEventListener("abort", () => wake?.(), { once: true });
        while (!signal.aborted) {
          while (queue.length) yield queue.shift();
          if (!signal.aborted)
            await new Promise((resolve) => {
              wake = resolve;
            });
        }
      },
    },
    callUnary: async () => ok({}),
  };
  return client;
}

test("DSH malformed tool JSON continues in the same native session", async (t) => {
  const cfg = config(1);
  cfg.agents[0].contextPolicy.capacityTokens = 131072;
  const f = fixture(t, { cfg });
  const client = dshClient();
  f.runtime.backendFactory = (b, a) =>
    new DshBackend({ ...b, preset: "qq-unified" }, a, { root: f.root, client });
  const result = await f.runtime.wake("agent-0", chat);
  assert.equal(result.status, "completed-no-send");
  assert.equal(client.prompts.length, 2);
  assert.equal(client.creates, 1);
  assert.equal(f.store.bind("agent-0").state(chat).session.id, "dsh-session");
});

test("a continuation preflight failure keeps presentation already sent in the original prompt", async (t) => {
  const cfg = config(1);
  cfg.backends[0].type = "dsh";
  cfg.agents[0].contextPolicy.capacityTokens = 131072;
  const f = fixture(t, { cfg }),
    client = dshClient();
  const backend = new DshBackend(cfg.backends[0], cfg.agents[0], {
    root: f.root,
    client,
  });
  f.runtime.backends.set("agent-0", backend);
  const memory = f.store.bind("agent-0");
  const mood = memory.identity.setMood(
    { mood: "期待", intensity: 2, reason: "已经送达的心情" },
    { writtenIn: chat, now: f.runtime.now() },
  );
  const ready = backend.ready.bind(backend);
  let preparations = 0;
  backend.ready = async () => {
    if (++preparations === 2) throw Error("DSH_STREAM_FAILED");
    return ready();
  };
  assert.equal((await f.runtime.wake("agent-0", chat)).status, "failed");
  assert.equal(preparations, 2);
  assert.equal(client.prompts.length, 1);
  assert.equal(memory.state(chat).moodShown, mood.id);
  assert.equal(memory.state(chat).session.id, "dsh-session");
  backend.ready = ready;
  await f.runtime.wake("agent-0", chat);
  assert.equal(client.creates, 1);
  assert.ok(!client.prompts[1].content[0].text.includes("已经送达的心情"));
});

class RecoveryRpc extends EventEmitter {
  constructor({
    reasons = ["responseStreamDisconnected", null],
    beforeEnd = async () => {},
    invalidSnapshot = false,
    onRead = () => {},
  } = {}) {
    super();
    Object.assign(this, { reasons, beforeEnd, invalidSnapshot, onRead });
    this.starts = [];
    this.turns = [];
    this.creates = 0;
    this.responses = [];
  }
  async start() {}
  close() {}
  respond(id, result) {
    this.responses.push({ id, result });
  }
  reject() {}
  async request(method, args) {
    if (method === "account/read") return { account: { type: "fixture" } };
    if (method === "model/list") return { data: [] };
    if (method === "thread/start") {
      this.creates++;
      return { thread: { id: "codex-session" } };
    }
    if (method === "thread/read") {
      this.onRead();
      return {
        thread: {
          id: "codex-session",
          status: { type: this.invalidSnapshot ? "active" : "idle" },
          turns: this.turns,
        },
      };
    }
    if (method === "turn/start") {
      this.starts.push(args);
      const index = this.starts.length;
      const info = this.reasons[Math.min(index - 1, this.reasons.length - 1)];
      const turn = {
        id: String(index),
        status: info ? "failed" : "completed",
        error: info
          ? {
              message: "private provider detail",
              codexErrorInfo:
                info === "responseStreamDisconnected"
                  ? { [info]: { httpStatusCode: null } }
                  : info,
            }
          : null,
      };
      this.emit("notification", {
        method: "turn/started",
        params: { threadId: "codex-session", turn: { id: turn.id } },
      });
      setImmediate(async () => {
        await this.beforeEnd(index);
        this.turns.push(turn);
        this.emit("notification", {
          method: "turn/completed",
          params: { threadId: "codex-session", turn },
        });
      });
      return { turn };
    }
    return {};
  }
}
function setup(t, type, options = {}) {
  const cfg = config(1);
  cfg.agents[0].contextPolicy.capacityTokens = 131072;
  const f = fixture(t, { cfg });
  const client = type === "dsh" ? dshClient(options) : new RecoveryRpc(options);
  f.runtime.backendFactory = (b, a) =>
    type === "dsh"
      ? new DshBackend({ ...b, preset: "qq-unified" }, a, {
          root: f.root,
          client,
        })
      : new CodexBackend(b, a, { root: f.root, rpc: client });
  const ctx = () => [...f.runtime.capabilities.values()][0];
  return {
    ...f,
    client,
    ctx,
    m: f.store.bind("agent-0"),
    attempts: () => (client.prompts || client.starts).length,
  };
}

test("DSH transport failure continues a verified native turn without repeating QQ delivery", async (t) => {
  let f, originalCapability;
  f = setup(t, "dsh", {
    reasons: [transportFailure, { kind: "completed" }],
    beforeEnd: async (attempt) => {
      const ctx = f.ctx();
      const message = { requestId: "original", text: "已完成的回复" };
      if (attempt === 1) {
        originalCapability = ctx.token;
        await f.runtime.send(ctx, message);
      } else {
        assert.notEqual(ctx.token, originalCapability);
        assert.throws(
          () => f.runtime.capability(originalCapability),
          /INVALID_CAPABILITY/,
        );
        assert.equal(f.runtime.capability(ctx.token), ctx);
        assert.throws(
          () => f.runtime.assertSafeOutput(ctx, originalCapability),
          /SENSITIVE_OUTPUT_BLOCKED/,
        );
        await assert.rejects(
          f.runtime.send(ctx, { requestId: "new-id", text: "改写的回复" }),
          /RECOVERY_DELIVERY_BLOCKED/,
        );
        assert.equal((await f.runtime.send(ctx, message)).duplicate, true);
      }
    },
  });

  assert.equal((await f.runtime.wake("agent-0", chat)).status, "sent");
  assert.equal(f.attempts(), 2);
  assert.equal(f.client.creates, 1);
  assert.equal(f.m.state(chat).session.id, "dsh-session");
  assert.equal(f.runtime.transports.get("qq-0").sent.length, 1);
  assert.equal(f.m.delivery("original").status, "sent");
  const [turn] = f.m.identity.list("model_turns");
  assert.deepEqual(turn.backendTurnIds, ["1", "2"]);
  assert.equal(turn.recoveryAttempts, 1);
  assert.equal(turn.backendFailures[0].code, "TRANSPORT");
  assert.equal(turn.backendFailures[0].category, "response-stream");
  assert.equal(turn.backendFailures[0].sessionReusable, true);
  assert.ok(!JSON.stringify(turn).includes("private provider detail"));
  assert.match(f.client.prompts[1].content[0].text, /只允许查询原回执/);
});

test("DSH transport failure cannot continue while native input is queued", async (t) => {
  const f = setup(t, "dsh", {
    reasons: [transportFailure],
    invalidSnapshot: true,
  });
  assert.equal((await f.runtime.wake("agent-0", chat)).status, "failed");
  assert.equal(f.runtime.status().agents[0].error, "DSH_TRANSPORT");
  assert.equal(f.attempts(), 1);
  assert.equal(f.m.state(chat).session, null);
  const [turn] = f.m.identity.list("model_turns");
  assert.equal(turn.backendFailures[0].code, "TRANSPORT");
  assert.equal(turn.backendFailures[0].sessionReusable, false);
});

test("DSH transport continuation verifies the same failed turn and code in both snapshots", async (t) => {
  for (const phase of [2, 3]) {
    for (const mismatch of ["turn", "code"]) {
      await t.test(
        `snapshot ${phase} has a different ${mismatch}`,
        async (t) => {
          let snapshots = 0;
          const f = setup(t, "dsh", {
            reasons: [transportFailure],
            onFollow: (_, records) => {
              if (++snapshots !== phase) return;
              const { event } = records.at(-1);
              records[records.length - 1] = {
                event: {
                  ...event,
                  data:
                    mismatch === "turn"
                      ? { ...event.data, turn: 2 }
                      : { ...event.data, reason: malformed },
                },
              };
            },
          });
          assert.equal(
            (await f.runtime.wake("agent-0", chat)).status,
            "failed",
          );
          assert.equal(snapshots, phase);
          assert.equal(f.attempts(), 1);
          assert.equal(f.m.state(chat).session, null);
        },
      );
    }
  }
});

test("DSH stops after one verified transport continuation fails", async (t) => {
  const f = setup(t, "dsh", {
    reasons: [transportFailure, transportFailure],
  });
  assert.equal((await f.runtime.wake("agent-0", chat)).status, "failed");
  assert.equal(f.attempts(), 2);
  assert.equal(f.m.state(chat).session.id, "dsh-session");
  const [turn] = f.m.identity.list("model_turns");
  assert.equal(turn.recoveryAttempts, 1);
  assert.deepEqual(
    turn.backendFailures.map((failure) => failure.code),
    ["TRANSPORT", "TRANSPORT"],
  );
});

test("DSH transport recovery depends on the terminal kind and exact protocol code", () => {
  for (const code of ["ABORTED", "TIMEOUT", "HTTP_401", "HTTP_429", "OTHER"]) {
    const failure = dshTurnFailure(
      { kind: "error", error: { code, message: "TRANSPORT" } },
      "1",
    );
    assert.equal(failure.recoverable, false, code);
  }
  const cancelled = dshTurnFailure(
    { ...transportFailure, kind: "cancelled" },
    "1",
  );
  assert.equal(cancelled.category, "cancelled");
  assert.equal(cancelled.recoverable, false);
});

test("diagnostics follow their running turn across recovery and classify worker retirement", async (t) => {
  const f = fixture(t, { cfg: config(1) }),
    memory = f.store.bind("agent-0"),
    agent = f.runtime.config.agents[0],
    backendType = f.runtime.config.backends.find(
      (backend) => backend.id === agent.backendId,
    ).type;
  let calls = 0;
  const callbacks = [];
  f.runtime.backends.set("agent-0", {
    async run(params) {
      calls++;
      callbacks.push(params.onDiagnostic);
      if (calls === 1) {
        params.saveSession({ backend: backendType, id: "diagnostic-session" });
        params.onDiagnostic({
          origin: "protocol",
          phase: "running",
          backendOutcome: "failed",
          workerOutcome: "healthy",
          sessionDisposition: "retained",
          privateText: "must-not-persist",
        });
        const error = new BackendTurnFailure(
          backendType,
          "responseStreamDisconnected",
          "response-stream",
          "native-turn",
          true,
        );
        error.sessionReusable = true;
        throw error;
      }
      assert.equal(
        callbacks[0]({
          origin: "protocol",
          phase: "settled",
          backendOutcome: "failed",
          sessionDisposition: "retained",
        }),
        false,
      );
      params.onDiagnostic({
        origin: "finalization",
        phase: "settled",
        terminalStatus: "SUCCESS",
        trustedTerminal: true,
        backendOutcome: "success",
        workerOutcome: "exit-warning",
        sessionDisposition: "retiring",
      });
      params.saveSession(null);
      params.onDiagnostic({
        origin: "finalization",
        phase: "settled",
        sessionDisposition: "retired",
      });
    },
  });

  assert.equal(
    (await f.runtime.wake("agent-0", chat)).status,
    "completed-no-send",
  );
  const firstTurn = memory.identity.list("model_turns")[0];
  assert.equal(calls, 2);
  assert.equal(firstTurn.backendDiagnostics.length, 3);
  assert.deepEqual(
    firstTurn.backendDiagnostics.map(({ attempt }) => attempt),
    [0, 1, 1],
  );
  assert.deepEqual(
    firstTurn.backendDiagnostics.map(({ origin, phase }) => ({
      origin,
      phase,
    })),
    [
      { origin: "protocol", phase: "running" },
      { origin: "finalization", phase: "settled" },
      { origin: "finalization", phase: "settled" },
    ],
  );
  assert.equal(firstTurn.backendOutcome, "success");
  assert.equal(firstTurn.workerOutcome, "exit-warning");
  assert.equal(firstTurn.sessionDisposition, "retired");
  assert.equal(firstTurn.terminalStatus, undefined);
  assert.equal(
    memory.identity.list("session_history")[0].reason,
    "backend-worker-unavailable",
  );
  assert.equal(
    memory.identity.list("session_history")[0].details.source,
    "backend",
  );
  assert.equal(memory.state(chat).session, null);
  assert.equal(
    callbacks[0]({ origin: "protocol", phase: "running", ioCode: "EPIPE" }),
    false,
  );
  assert.equal(
    memory.identity.get("model_turns", firstTurn.id).backendDiagnostics.length,
    3,
  );
});

test("failed worker retirement remains visible when saveSession throws", async (t) => {
  const f = fixture(t, { cfg: config(1) }),
    memory = f.store.bind("agent-0"),
    agent = f.runtime.config.agents[0],
    backendType = f.runtime.config.backends.find(
      (backend) => backend.id === agent.backendId,
    ).type;
  memory.db.exec(
    "CREATE TRIGGER reject_worker_retirement BEFORE INSERT ON session_history BEGIN SELECT RAISE(ABORT,'retirement write failed'); END",
  );
  f.runtime.backends.set("agent-0", {
    async run(params) {
      params.saveSession({ backend: backendType, id: "still-live-session" });
      params.onDiagnostic({
        origin: "finalization",
        phase: "settled",
        terminalStatus: "SUCCESS",
        backendOutcome: "success",
        sessionDisposition: "retiring",
      });
      params.saveSession(null);
    },
  });

  await assert.rejects(
    f.runtime.wake("agent-0", chat),
    /retirement write failed/,
  );
  assert.equal(memory.state(chat).session.id, "still-live-session");
  assert.equal(memory.identity.list("session_history").length, 0);
  const turn = memory.identity.list("model_turns")[0];
  assert.equal(turn.backendOutcome, "success");
  assert.equal(turn.backendDiagnostics.at(-1).terminalStatus, "SUCCESS");
  assert.equal(turn.sessionDisposition, "retiring");
  memory.db.exec("DROP TRIGGER reject_worker_retirement");
  retireSession(memory, chat, "lifecycle", Date.now(), {
    turnId: turn.id,
    backendId: agent.backendId,
  });
  assert.equal(
    memory.identity.get("model_turns", turn.id).sessionDisposition,
    "retired",
  );
});

for (const type of ["dsh", "codex"]) {
  test(`${type} resumes once with the same session and logical turn`, async (t) => {
    let f;
    const contexts = [];
    f = setup(t, type, { beforeEnd: async () => contexts.push(f.ctx()) });
    assert.equal(
      (await f.runtime.wake("agent-0", chat)).status,
      "completed-no-send",
    );
    assert.equal(f.attempts(), 2);
    assert.equal(f.client.creates, 1);
    assert.equal(contexts[0], contexts[1]);
    assert.equal(f.m.state(chat).session.id, type + "-session");
    const turn = f.m.identity.list("model_turns")[0];
    assert.equal(turn.recoveryAttempts, 1);
    assert.deepEqual(turn.backendTurnIds, ["1", "2"]);
    assert.equal(turn.backendFailures.length, 1);
    assert(!JSON.stringify(turn).includes("private provider detail"));
    assert.equal(f.m.identity.list("session_history").length, 0);
    const retry =
      type === "dsh"
        ? f.client.prompts[1].content[0].text
        : f.client.starts[1].input[0].text;
    assert.match(retry, /不要重做/);
    if (type === "dsh")
      assert.ok(retry.includes("context=" + contexts[1].token));
    else assert(!retry.includes("context="));
  });

  for (const delivery of ["sent", "unknown", "failed", "pending"]) {
    test(`${type} preserves ${delivery} receipt and blocks a new ID/reworded send on recovery`, async (t) => {
      let f, release, pending;
      const recovered = [];
      f = setup(t, type, {
        beforeEnd: async (attempt) => {
          const ctx = f.ctx();
          if (attempt === 1) {
            if (delivery === "pending") {
              const transport = f.runtime.transports.get("qq-0");
              transport.send = async () => {
                transport.sent.push({});
                return new Promise((r) => {
                  release = r;
                });
              };
              pending = f.runtime.send(ctx, {
                requestId: "original",
                text: "已完成的回复",
              });
            } else {
              if (delivery !== "sent")
                f.runtime.transports.get("qq-0").failure =
                  delivery === "failed" ? "ONEBOT_REJECTED" : "TIMEOUT";
              try {
                await f.runtime.send(ctx, {
                  requestId: "original",
                  text: "已完成的回复",
                });
              } catch (e) {
                assert.match(e.message, /DELIVERY_/);
              }
            }
          } else {
            if (delivery === "pending") {
              release({ messageId: "40001" });
              await pending;
            }
            for (const text of ["已完成的回复", "换句话重新回答"]) {
              try {
                await f.runtime.send(ctx, {
                  requestId: "replacement-" + text,
                  text,
                });
              } catch (e) {
                recovered.push(e.message);
              }
            }
            if (["sent", "pending"].includes(delivery)) {
              const receipt = await f.runtime.send(ctx, {
                requestId: "original",
                text: "已完成的回复",
              });
              assert.equal(receipt.duplicate, true);
            } else {
              await assert.rejects(
                f.runtime.send(ctx, {
                  requestId: "original",
                  text: "已完成的回复",
                }),
                new RegExp(
                  "DELIVERY_ALREADY_ATTEMPTED_" + delivery.toUpperCase(),
                ),
              );
            }
          }
        },
      });
      await f.runtime.wake("agent-0", chat);
      assert.equal(f.attempts(), 2);
      assert.deepEqual(recovered, [
        "RECOVERY_DELIVERY_BLOCKED",
        "RECOVERY_DELIVERY_BLOCKED",
      ]);
      assert.equal(f.runtime.transports.get("qq-0").sent.length, 1);
      assert.equal(
        f.m.delivery("original").status,
        delivery === "pending" ? "sent" : delivery,
      );
    });
  }
  test(`${type} may send the unfinished reply if no delivery was attempted`, async (t) => {
    let f;
    f = setup(t, type, {
      beforeEnd: async (attempt) => {
        if (attempt === 2)
          await f.runtime.send(f.ctx(), {
            requestId: "unfinished",
            text: "完成回复",
          });
      },
    });
    assert.equal((await f.runtime.wake("agent-0", chat)).status, "sent");
    assert.equal(f.runtime.transports.get("qq-0").sent.length, 1);
  });
  test(`${type} exhausted continuation keeps verified session but does not loop`, async (t) => {
    const f = setup(t, type, {
      reasons:
        type === "dsh"
          ? [malformed, malformed]
          : ["responseStreamDisconnected"],
    });
    assert.equal((await f.runtime.wake("agent-0", chat)).status, "failed");
    assert.equal(f.attempts(), 2);
    assert.equal(f.m.state(chat).session.id, type + "-session");
    assert.equal(f.m.identity.list("model_turns")[0].backendFailures.length, 2);
    assert.equal(f.m.identity.list("session_history").length, 0);
  });
  test(`${type} unverified or busy native state is not resumed`, async (t) => {
    const f = setup(t, type, { invalidSnapshot: true });
    assert.equal((await f.runtime.wake("agent-0", chat)).status, "failed");
    assert.equal(f.attempts(), 1);
    assert.equal(f.m.state(chat).session, null);
  });
  test(`${type} cancellation during recovery probe prevents continuation`, async (t) => {
    let f;
    const cancel = () => f.ctx()?.controller.abort();
    f = setup(t, type, {
      onRead: cancel,
      onFollow: (c) => {
        if (c.prompts.length) cancel();
      },
    });
    assert.equal((await f.runtime.wake("agent-0", chat)).status, "cancelled");
    assert.equal(f.attempts(), 1);
    assert.equal(f.m.state(chat).session, null);
  });
}

for (const code of [
  "unauthorized",
  "rateLimitExceeded",
  "usageLimitExceeded",
  "contextWindowExceeded",
  "other",
]) {
  test(`Codex ${code} is terminal and is never retried`, async (t) => {
    const f = setup(t, "codex", { reasons: [code] });
    assert.equal((await f.runtime.wake("agent-0", chat)).status, "failed");
    assert.equal(f.attempts(), 1);
    assert.equal(f.m.state(chat).session, null);
  });
}

for (const type of ["dsh", "codex"]) {
  test(`${type} a queued delivery cannot cross the recovery fence`, async (t) => {
    let f, unlock, pending;
    f = setup(t, type, {
      beforeEnd: async (attempt) => {
        if (attempt === 1) {
          f.runtime.delivery.queues.set(
            "qq-0",
            new Promise((r) => {
              unlock = r;
            }),
          );
          pending = f.runtime.send(f.ctx(), {
            requestId: "queued",
            text: "尚未开始发送",
          });
          pending.catch(() => {});
        } else {
          unlock();
          await assert.rejects(pending, /RECOVERY_DELIVERY_BLOCKED/);
          await assert.rejects(
            f.runtime.deliver(f.ctx(), {
              requestId: "action-retry",
              intent: { action: "fixture" },
              action: true,
              send: () => {
                assert.fail("QQ action must not execute");
              },
            }),
            /RECOVERY_DELIVERY_BLOCKED/,
          );
        }
      },
    });
    assert.equal(
      (await f.runtime.wake("agent-0", chat)).status,
      "completed-no-send",
    );
    assert.equal(f.attempts(), 2);
    assert.equal(f.runtime.transports.get("qq-0").sent.length, 0);
    assert.equal(f.m.delivery("queued"), undefined);
  });
  test(`${type} changing native state between verification and continuation fails closed`, async (t) => {
    let f,
      reads = 0;
    f = setup(t, type, {
      onRead: () => {
        if (++reads === 2) f.client.invalidSnapshot = true;
      },
      onFollow: (c) => {
        if (c.prompts.length && ++reads === 2) {
          c.invalidSnapshot = true;
        }
      },
    });
    const result = await f.runtime.wake("agent-0", chat);
    assert.equal(result.status, "failed");
    assert.equal(f.attempts(), 1);
    assert.equal(f.m.state(chat).session, null);
  });
}

test("Codex malformed arguments and tool execution errors return to the model without retiring the session", async (t) => {
  let f;
  f = setup(t, "codex", {
    reasons: [null],
    beforeEnd: async () => {
      const backend = f.runtime.backends.get("agent-0");
      for (const [id, args] of [
        ["bad-json", "{"],
        ["tool-failure", { requestId: "x", text: "" }],
      ]) {
        await backend.request({
          id,
          method: "item/tool/call",
          params: {
            threadId: "codex-session",
            turnId: "1",
            tool: "qq_send",
            arguments: args,
          },
        });
      }
    },
  });
  assert.equal(
    (await f.runtime.wake("agent-0", chat)).status,
    "completed-no-send",
  );
  assert.equal(f.attempts(), 1);
  assert.equal(f.client.responses.length, 2);
  assert(f.client.responses.every((x) => x.result.success === false));
  assert.equal(f.m.state(chat).session.id, "codex-session");
});

test("late Codex completion from the failed attempt cannot end its continuation", async (t) => {
  let f;
  f = setup(t, "codex", {
    beforeEnd: async (attempt) => {
      if (attempt === 2)
        f.client.emit("notification", {
          method: "turn/completed",
          params: {
            threadId: "codex-session",
            turn: { id: "1", status: "failed" },
          },
        });
    },
  });
  assert.equal(
    (await f.runtime.wake("agent-0", chat)).status,
    "completed-no-send",
  );
  assert.equal(f.attempts(), 2);
});

for (const type of ["dsh", "codex"])
  test(`${type} subject uses the same recovery policy`, async (t) => {
    const f = setup(t, type);
    f.runtime.config.agents[0].subject.enabled = true;
    assert.equal(
      (await f.runtime.wake("agent-0", "@subject")).status,
      "completed-no-send",
    );
    assert.equal(f.m.state("@subject").session.id, type + "-session");
    assert.equal(f.attempts(), 2);
    assert.equal(f.runtime.transports.get("qq-0").sent.length, 0);
  });
for (const httpStatusCode of [401, 403, 429]) {
  test(`Codex stream error with HTTP ${httpStatusCode} is not transient`, async (t) => {
    const f = setup(t, "codex", {
      reasons: [{ responseStreamDisconnected: { httpStatusCode } }],
    });
    assert.equal((await f.runtime.wake("agent-0", chat)).status, "failed");
    assert.equal(f.attempts(), 1);
    assert.equal(f.m.state(chat).session, null);
  });
}

test("superseded backend callbacks cannot mutate the live turn", async (t) => {
  let previous,
    attempt = 0,
    f;
  f = fixture(t, {
    cfg: config(1),
    run: async (params) => {
      if (++attempt === 1) {
        previous = params;
        params.saveSession({
          backend: "codex",
          id: "fixture-initial",
          signature: "fixture",
        });
        const failure = new BackendTurnFailure(
          "codex",
          "fixtureTransient",
          "response-stream",
          "fixture-first",
          true,
        );
        failure.sessionReusable = true;
        throw failure;
      }
      const memory = f.store.bind("agent-0");
      previous.saveSession({
        backend: "codex",
        id: "fixture-late",
        signature: "fixture",
      });
      previous.onBackendTurn({ turnId: "fixture-late" });
      await assert.rejects(
        previous.callTool("diary_write", {
          title: "Stale fixture",
          body: "Synthetic",
        }),
        /INPUT_EPOCH_CHANGED/,
      );
      assert.equal(memory.state(chat).session.id, "fixture-initial");
      assert.equal(
        f.store.db.prepare("SELECT count(*) AS n FROM diaries").get().n,
        0,
      );
      assert.equal(
        memory.identity.list("model_turns")[0].backendTurnId,
        undefined,
      );
      assert.equal(
        memory.identity.list("model_turns")[0].backendSession.id,
        "fixture-initial",
      );
      assert.equal(
        memory.identity.list("session_history")[0].session.id,
        "fixture-late",
      );
    },
  });
  assert.equal(
    (await f.runtime.wake("agent-0", chat)).status,
    "completed-no-send",
  );
  assert.equal(attempt, 2);
});

test("the attempt interface returns a rejected promise to stale tool callers", async () => {
  const session = {
    backend: "codex",
    id: "fixture-session",
    signature: "fixture",
  };
  let first;
  let called = 0;
  const backend = {
    async run(params) {
      if (!first) {
        first = params;
        const failure = new BackendTurnFailure(
          "codex",
          "fixtureTransient",
          "response-stream",
          "fixture-first",
          true,
        );
        failure.sessionReusable = true;
        throw failure;
      }
      await assert.rejects(first.callTool("stale", {}), /INPUT_EPOCH_CHANGED/);
      await assert.rejects(first.beforeInputSubmitted(), /INPUT_EPOCH_CHANGED/);
      await assert.rejects(
        first.finalizeToolOutput({}, {}),
        /INPUT_EPOCH_CHANGED/,
      );
      await params.callTool("current", {});
    },
  };
  await runWithRecovery(backend, {
    session,
    prompt: "synthetic",
    signal: new AbortController().signal,
    tools: [],
    saveSession() {},
    beforeInputSubmitted: async () => {},
    finalizeToolOutput: async () => ({ wire: {} }),
    callTool: async () => ++called,
  });
  assert.equal(called, 1);
});
