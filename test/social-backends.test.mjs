import test from "node:test";
import assert from "node:assert/strict";
import { runOpenAISocial } from "../src/backends/openai-social.mjs";
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

test("input consumption acknowledgement precedes tools and snapshots each HTTP input", async () => {
  const f = fixture(),
    pending = ["initial"],
    order = [],
    seen = [];
  f.params.captureInputConsumption = () => pending.slice();
  f.params.onInputConsumed = async (ticket) => {
    seen.push(ticket);
    order.push("consumed");
    pending.length = 0;
  };
  f.params.callTool = async () => {
    order.push("tool-read");
    pending.push("tool-result");
    return { ok: true };
  };
  let round = 0;
  f.params.fetch = async () => {
    order.push("http");
    return {
      ok: true,
      json: async () => ({
        usage: { prompt_tokens: 10, completion_tokens: 5 },
        choices: [
          {
            message: round++
              ? { content: "done" }
              : {
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
      }),
    };
  };
  await runOpenAISocial(f.params);
  assert.deepEqual(seen, [["initial"], ["tool-result"]]);
  assert.deepEqual(order, [
    "http",
    "consumed",
    "tool-read",
    "http",
    "consumed",
  ]);
});

test("unconsumed tool results and rejected model requests never acknowledge input", async () => {
  for (const failure of ["budget", "usage", "lease", "transport"]) {
    const f = fixture();
    let confirmed = 0,
      checks = 0;
    f.params.onInputConsumed = async () => {
      confirmed++;
    };
    if (failure === "budget")
      f.params.budget.reserveInference = async () => {
        throw Error("SOCIAL_RESOURCE_LIMIT");
      };
    if (failure === "usage")
      f.params.fetch = async () => ({
        ok: true,
        json: async () => ({ choices: [{ message: { content: "done" } }] }),
      });
    if (failure === "lease")
      f.params.beforeInput = async () => {
        if (++checks === 3) throw Error("AUDIENCE_DENIED");
      };
    if (failure === "transport")
      f.params.fetch = async () => {
        throw Error("SYNTHETIC_NETWORK_FAILURE");
      };
    await assert.rejects(runOpenAISocial(f.params));
    assert.equal(confirmed, 0, failure);
  }
  const f = fixture(),
    tickets = [];
  let pending = [];
  f.params.maxInferences = 1;
  f.params.captureInputConsumption = () => pending.slice();
  f.params.onInputConsumed = async (ticket) => {
    tickets.push(ticket);
  };
  f.params.callTool = async () => {
    pending.push("new unread result");
    return { ok: true };
  };
  f.params.fetch = async () => ({
    ok: true,
    json: async () => ({
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
    }),
  });
  await assert.rejects(runOpenAISocial(f.params), /SOCIAL_INFERENCE_LIMIT/);
  assert.deepEqual(tickets, [[]]);
});

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

test("malformed tool arguments expose only a stable code and never invoke a tool", async () => {
  const f = fixture();
  let calls = 0;
  f.params.callTool = async () => {
    calls++;
  };
  f.params.fetch = async () => ({
    ok: true,
    json: async () => ({
      usage: { prompt_tokens: 10, completion_tokens: 5 },
      choices: [
        {
          message: {
            tool_calls: [
              {
                id: "call",
                type: "function",
                function: {
                  name: "home_visit_send",
                  arguments: "SYNTHETIC_PRIVATE_ARGUMENT",
                },
              },
            ],
          },
        },
      ],
    }),
  });
  await assert.rejects(runOpenAISocial(f.params), (error) => {
    assert.equal(error.message, "SOCIAL_RESPONSE_INVALID");
    assert.equal(error.cause, undefined);
    assert.equal(error.stack.includes("SYNTHETIC_PRIVATE_ARGUMENT"), false);
    return true;
  });
  assert.equal(calls, 0);
  assert.equal(f.settled[0].status, "completed");
});
