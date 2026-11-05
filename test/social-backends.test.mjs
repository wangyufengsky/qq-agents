import test from "node:test";
import assert from "node:assert/strict";
import { runOpenAISocial } from "../src/backends/openai-social.mjs";
import { installDshSocialGuard } from "../src/backends/dsh-social-guard.mjs";
import { socialProviderProfile } from "../src/backends/social-budget.mjs";

function fixture() {
  const reserved = [],
    settled = [],
    bodies = [];
  let sequence = 0;
  const budget = {
    async reserveInference(value) {
      reserved.push(value);
      return { reservationId: String(++sequence), claimed: true };
    },
    async settleInference(value) {
      settled.push(value);
    },
  };
  const params = {
    binding: { runId: "run-one" },
    endpoint: "https://api.openai.com/v1/chat/completions",
    model: "gpt-4.1-mini-2025-04-14",
    profileId: "openai-gpt-4.1-mini",
    budget,
    signal: new AbortController().signal,
    beforeInput: async () => {},
    instructions: "test identity",
    prompt: "test input",
    outputCap: 32,
    maxInferences: 2,
    maxCallsPerInference: 1,
    maxToolResultBytes: 1024,
    tools: [
      {
        type: "function",
        function: { name: "home_visit_send", parameters: { type: "object" } },
      },
    ],
    headers: () => ({ "content-type": "application/json" }),
    callTool: async () => ({ status: "committed" }),
    fetch: async (_url, options) => {
      bodies.push(JSON.parse(options.body));
      return {
        ok: true,
        json: async () => ({
          usage: { prompt_tokens: 10, completion_tokens: 5 },
          choices: [{ message: { content: "draft only" } }],
        }),
      };
    },
  };
  return { params, reserved, settled, bodies };
}

test("invalid endpoint errors never include original URL", () => {
  assert.throws(
    () =>
      socialProviderProfile(
        "openai-gpt-4.1-mini",
        "private-invalid-url",
        "model",
      ),
    /^Error: SOCIAL_BACKEND_UNSUPPORTED$/,
  );
});

test("post-reservation preflight failure releases an explicitly unstarted request", async () => {
  const f = fixture();
  let checks = 0;
  f.params.beforeInput = async () => {
    if (++checks === 2) throw Error("VISIT_CLOSED");
  };
  await assert.rejects(
    runOpenAISocial(f.params),
    /SOCIAL_INFERENCE_NOT_STARTED/,
  );
  assert.equal(f.bodies.length, 0);
  assert.equal(f.settled[0].status, "not_started");
});

test("DSH second authorization rejects changed fence and keeps per-run ordinals", async () => {
  const hooks = new Map(),
    reserved = [],
    settled = [];
  let runId = "one",
    authorizations = 0,
    started = 0;
  let changed = false;
  const control = {
    authorize: async () => ({
      verifiedProvider: true,
      reasoningIncluded: true,
      retryBoundaryVerified: true,
      runId,
      outputCap: 32,
      inputUpperBound: 128000,
      fence: changed && ++authorizations % 2 === 0 ? 2 : 1,
    }),
    reserveInference: async (value) => {
      reserved.push(value);
      return { reservationId: String(reserved.length), claimed: true };
    },
    settleInference: async (value) => settled.push(value),
  };
  installDshSocialGuard({ on: (name, fn) => hooks.set(name, fn) }, control);
  const consume = async () => {
    for await (const chunk of hooks.get("llm/stream")(
      { sessionId: "session", maxTokens: 32 },
      async function* () {
        started++;
        yield {};
      },
    ))
      void chunk;
  };
  await consume();
  runId = "two";
  await consume();
  assert.deepEqual(
    reserved.map((x) => x.requestId),
    ["one:0", "two:0"],
  );
  changed = true;
  await assert.rejects(consume(), /SOCIAL_BACKEND_UNSUPPORTED/);
  assert.equal(started, 2);
  assert.equal(settled.at(-1).status, "not_started");
  control.authorize = async () => false;
  await assert.rejects(consume(), /SOCIAL_BACKEND_UNSUPPORTED/);
  assert.equal(started, 2);
});

test("social OpenAI reserves full documented context and caps each inference without sessions", async () => {
  const f = fixture();
  await runOpenAISocial(f.params);
  await runOpenAISocial({ ...f.params, binding: { runId: "run-two" } });
  assert.equal(f.reserved[0].inputUpperBound, 1047576);
  assert.equal(f.bodies[0].max_completion_tokens, 32);
  assert.equal(f.bodies[0].store, false);
  assert.equal(f.bodies[0].n, 1);
  assert.deepEqual(f.bodies[0].messages, f.bodies[1].messages);
  assert.equal(f.settled[0].status, "completed");
});

test("tool continuation reserves again; final text never invokes delivery", async () => {
  const f = fixture();
  let sends = 0;
  const fetch = f.params.fetch;
  f.params.callTool = async () => {
    sends++;
    return { status: "committed" };
  };
  f.params.fetch = async (...args) => {
    const response = await fetch(...args);
    if (f.bodies.length === 1)
      response.json = async () => ({
        usage: { prompt_tokens: 10, completion_tokens: 5 },
        choices: [
          {
            message: {
              tool_calls: [
                {
                  id: "call",
                  type: "function",
                  function: { name: "home_visit_send", arguments: "{}" },
                },
              ],
            },
          },
        ],
      });
    return response;
  };
  await runOpenAISocial(f.params);
  assert.equal(sends, 1);
  assert.equal(f.reserved.length, 2);
  assert.notEqual(f.reserved[0].requestId, f.reserved[1].requestId);
});

test("provider failure stays unknown with no retry or tool execution", async () => {
  const f = fixture();
  f.params.fetch = async () => {
    throw Error("private provider text");
  };
  await assert.rejects(
    runOpenAISocial(f.params),
    /^Error: SOCIAL_INFERENCE_UNKNOWN$/,
  );
  assert.equal(f.reserved.length, 1);
  assert.equal(f.settled[0].status, "unknown");
});

test("budget refusal, unknown route and expired fence make zero HTTP requests", async () => {
  for (const failure of ["budget", "route", "fence"]) {
    const f = fixture();
    if (failure === "budget")
      f.params.budget.reserveInference = async () => {
        throw Error("RATE_LIMITED");
      };
    if (failure === "route")
      f.params.endpoint = "https://compatible.invalid/v1/chat/completions";
    if (failure === "fence")
      f.params.beforeInput = async () => {
        throw Error("VISIT_CLOSED");
      };
    await assert.rejects(runOpenAISocial(f.params));
    assert.equal(f.bodies.length, 0);
  }
});

test("missing usage and cap violations cannot release reservations", async () => {
  const f = fixture();
  f.params.fetch = async () => ({
    ok: true,
    json: async () => ({ usage: { prompt_tokens: 2, completion_tokens: 33 } }),
  });
  await assert.rejects(runOpenAISocial(f.params), /SOCIAL_USAGE_UNVERIFIED/);
  assert.equal(f.settled[0].status, "unknown");
});

test("DSH request cap precedes stream reservation; retries each reserve and failures remain unknown", async () => {
  const hooks = new Map(),
    reserved = [],
    settled = [];
  const lease = {
    verifiedProvider: true,
    reasoningIncluded: true,
    retryBoundaryVerified: true,
    runId: "run",
    fence: 1,
    outputCap: 32,
    inputUpperBound: 128000,
  };
  installDshSocialGuard(
    { on: (name, fn) => hooks.set(name, fn) },
    {
      authorize: async () => lease,
      reserveInference: async (value) => {
        reserved.push(value);
        return { reservationId: String(reserved.length), claimed: true };
      },
      settleInference: async (value) => settled.push(value),
    },
  );
  const config = await hooks.get("agent/request")(
    { agent: { id: "session" } },
    async () => ({ provider: "verified", model: "model" }),
  );
  assert.equal(config.maxTokens, 32);
  for (let i = 0; i < 2; i++) {
    const stream = hooks.get("llm/stream")(
      { ...config, sessionId: "session" },
      async function* () {
        yield { type: "test" };
        throw Error("failure");
      },
    );
    await assert.rejects(async () => {
      for await (const chunk of stream) void chunk;
    });
  }
  assert.equal(reserved.length, 2);
  assert.notEqual(reserved[0].requestId, reserved[1].requestId);
  assert.deepEqual(
    settled.map((x) => x.status),
    ["unknown", "unknown"],
  );
  lease.retryBoundaryVerified = false;
  await assert.rejects(
    hooks.get("agent/request")(
      { agent: { id: "session" } },
      async () => config,
    ),
    /SOCIAL_BACKEND_UNSUPPORTED/,
  );
});
