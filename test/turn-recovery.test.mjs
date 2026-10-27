import test from "node:test";
import { EventEmitter } from "node:events";
import { CodexBackend } from "../src/backends/codex.mjs";
import assert from "node:assert/strict";
import { config, fixture } from "./helpers.mjs";
import { DshBackend } from "../src/backends/dsh.mjs";

const chat = "group:20000";
const malformed = {
  kind: "error",
  error: {
    code: "MALFORMED_RESPONSE",
    message: "DeepSeek Messages stream: tool input is invalid JSON",
  },
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
        onFollow(client);
        push({
          type: "session/snapshot",
          snapshot: {
            records: [...records],
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
  const f = fixture(t, { cfg: config(1) });
  const client = dshClient();
  f.runtime.backendFactory = (b, a) =>
    new DshBackend({ ...b, preset: "qq-unified" }, a, { root: f.root, client });
  const result = await f.runtime.wake("agent-0", chat);
  assert.equal(result.status, "completed-no-send");
  assert.equal(client.prompts.length, 2);
  assert.equal(client.creates, 1);
  assert.equal(f.store.bind("agent-0").state(chat).session.id, "dsh-session");
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
      await this.beforeEnd(index);
      this.turns.push(turn);
      this.emit("notification", {
        method: "turn/completed",
        params: { threadId: "codex-session", turn },
      });
      return { turn };
    }
    return {};
  }
}
function setup(t, type, options = {}) {
  const f = fixture(t, { cfg: config(1) });
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
for (const type of ["dsh", "codex"]) {
  test(`${type} resumes once without recreating session or capability`, async (t) => {
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
    assert(!retry.includes("context="));
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
          f.runtime.sendChains.set(
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
  for (const lane of ["subject", "learner"]) {
    test(`${type} ${lane} uses the same recovery policy`, async (t) => {
      const f = setup(t, type);
      f.runtime.config.agents[0].subject.enabled = true;
      f.runtime.config.agents[0].slang.enabled = true;
      if (lane === "subject") {
        assert.equal(
          (await f.runtime.wake("agent-0", "@subject")).status,
          "completed-no-send",
        );
        assert.equal(f.m.state("@subject").session.id, type + "-session");
      } else {
        f.m.setState(chat, {
          slang: { entries: [], throughSeq: 0 },
          readThroughSeq: 0,
        });
        await f.runtime.learner.learn(f.runtime.agent("agent-0"), chat, [
          { id: "evidence", body: "synthetic", seq: 1 },
        ]);
        assert.equal(f.m.state(chat).slang.session.id, type + "-session");
        assert.equal(f.m.state(chat).slang.throughSeq, 1);
      }
      assert.equal(f.attempts(), 2);
      assert.equal(f.runtime.transports.get("qq-0").sent.length, 0);
    });
  }
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
