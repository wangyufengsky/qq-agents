import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { fixture, config } from "./helpers.mjs";
import { CodexBackend } from "../src/backends/codex.mjs";
import { DshBackend } from "../src/backends/dsh.mjs";
import { SessionUnavailableFailure } from "../src/backends/turn-failure.mjs";
import { OpenAIBackend } from "../src/backends/openai.mjs";
for (const mode of [
  "codex-resume",
  "dsh-select-model",
  "dsh-follow",
  "openai-401",
  "openai-429",
  "openai-key-missing",
  "codex-missing",
  "dsh-missing",
  "dsh-follow-missing",
])
  test(`${mode} distinguishes preparation from missing transcripts without replay`, async (t) => {
    const cfg = config(1),
      type = mode.split("-")[0];
    Object.assign(cfg.backends[0], {
      type,
      model: "fixture-model",
      preset: "qq-unified",
    });
    if (type === "openai")
      Object.assign(cfg.backends[0], {
        baseUrl: "https://api.example.test/v1",
        contextWindow: 1000000,
        maxToolRounds: 10,
      });
    cfg.agents[0].contextPolicy.capacityTokens = 1000000;
    const f = fixture(t, { cfg });
    let fail = false,
      submitted = 0,
      b;
    try {
      if (type === "codex") {
        const rpc = new EventEmitter();
        rpc.close = () => {};
        rpc.request = async (method, args) => {
          if (method === "thread/start")
            return { thread: { id: "codex-session" } };
          if (method === "thread/resume" && fail)
            throw Object.assign(Error("SYNTHETIC_TRANSPORT_FAILURE"), {
              rpcRejected: mode === "codex-missing",
            });
          if (method === "turn/start") {
            submitted++;
            queueMicrotask(() => b.active.get(args.threadId).resolve());
            return { turn: { id: "turn-" + submitted } };
          }
          return {};
        };
        b = new CodexBackend(cfg.backends[0], cfg.agents[0], {
          root: f.root,
          rpc,
        });
        b.ready = async () => {};
      } else if (type === "dsh") {
        const ok = (value) => ({ result: { ok: true, value } });
        const client = {
          agentPresets: {
            list: async () => ok({ presets: [{ id: "qq-unified" }] }),
          },
          workspace: {
            create: async () => ok({ workspace: { workspaceId: "workspace" } }),
          },
          sessions: {
            create: async () => ok({ sessionId: "dsh-session" }),
            selectModel: async () => {
              if (fail && mode === "dsh-missing")
                return {
                  result: { ok: false, error: { code: "session-not-found" } },
                };
              if (fail && mode === "dsh-select-model")
                throw Error("SYNTHETIC_TRANSPORT_FAILURE");
              return ok({});
            },
            prompt: async () => {
              submitted++;
              b.turns.get("dsh-session").resolve();
              return ok({});
            },
          },
          events: {
            follow: () => {
              if (fail && mode === "dsh-follow-missing")
                throw new SessionUnavailableFailure("DSH_SESSION_UNAVAILABLE");
              if (fail && mode === "dsh-follow")
                throw Error("SYNTHETIC_TRANSPORT_FAILURE");
              b.turns.get("dsh-session").followed({});
            },
            forget() {},
          },
          callUnary: async () => ok({}),
        };
        b = new DshBackend(cfg.backends[0], cfg.agents[0], {
          root: f.root,
          client,
        });
        b.ready = async () => client;
        b.stream = async () => {};
      } else {
        b = new OpenAIBackend(cfg.backends[0], cfg.agents[0], { root: f.root });
        if (mode === "openai-key-missing") {
          b.config.apiKeyEnv = "QQ_AGENTS_TEST_RETENTION_KEY";
          const previous = process.env[b.config.apiKeyEnv];
          process.env[b.config.apiKeyEnv] = "synthetic";
          t.after(() => {
            if (previous === undefined) delete process.env[b.config.apiKeyEnv];
            else process.env[b.config.apiKeyEnv] = previous;
          });
        }
        b.request = async (route) => {
          assert.equal(route, "/chat/completions");
          submitted++;
          if (fail)
            throw Object.assign(Error("OPENAI_HTTP_ERROR"), {
              status: Number(mode.split("-")[1]),
            });
          return {
            choices: [{ message: { role: "assistant", content: "synthetic" } }],
            usage: { prompt_tokens: 100, completion_tokens: 10 },
          };
        };
      }
      f.runtime.backends.set("agent-0", b);
      assert.equal(
        (await f.runtime.wake("agent-0", "group:20000")).status,
        "completed-no-send",
      );
      const m = f.store.bind("agent-0"),
        original = m.state("group:20000").session;
      assert(original?.id);
      fail = true;
      submitted = 0;
      if (mode === "openai-key-missing") delete process.env[b.config.apiKeyEnv];
      const outcome = await f.runtime.wake("agent-0", "group:20000");
      const historyFile = type === "openai" ? b.load(original.id) : null;
      assert.equal(outcome.status, "failed");
      const missing = [
        "codex-missing",
        "dsh-missing",
        "dsh-follow-missing",
      ].includes(mode);
      assert.equal(
        m.state("group:20000").session?.id,
        missing ? undefined : original.id,
      );
      assert.equal(m.identity.list("session_history").length, missing ? 1 : 0);
      assert.equal(
        submitted,
        mode === "openai-401" || mode === "openai-429" ? 1 : 0,
      );
      if (historyFile) assert(Array.isArray(historyFile.messages));
      if (mode === "openai-key-missing")
        process.env[b.config.apiKeyEnv] = "synthetic";
      fail = false;
      await f.runtime.wake("agent-0", "group:20000");
      assert.equal(m.state("group:20000").session.id, original.id);
    } finally {
      await b?.close();
    }
  });
