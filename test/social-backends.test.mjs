import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import { OpenAIBackend } from "../src/backends/openai.mjs";
import { config, temp } from "./helpers.mjs";
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

test("round-only OpenAI supports compatible endpoints without a token profile", async () => {
  const f = fixture();
  Object.assign(f.params, {
    budget: null,
    profileId: null,
    endpoint: "https://compatible.example/v1/chat/completions",
    model: "fixture-model",
    outputCap: null,
    maxInferences: null,
  });
  const order = [];
  let calls = 0;
  f.params.onRunStarted = async () => order.push("started");
  f.params.fetch = async (_url, options) => {
    order.push("request");
    f.bodies.push(JSON.parse(options.body));
    return {
      ok: true,
      json: async () => ({
        choices: [
          {
            message:
              ++calls < 3
                ? {
                    tool_calls: [
                      {
                        id: `call-${calls}`,
                        type: "function",
                        function: {
                          name: "home_visit_send",
                          arguments: "{}",
                        },
                      },
                    ],
                  }
                : { content: "draft only" },
          },
        ],
      }),
    };
  };
  assert.deepEqual(await runOpenAISocial(f.params), {
    status: "completed",
    inferences: 3,
  });
  assert.deepEqual(order, [
    "started",
    "request",
    "started",
    "request",
    "started",
    "request",
  ]);
  assert.equal(f.reserved.length, 0);
  assert.equal(f.settled.length, 0);
  for (const body of f.bodies) {
    assert.equal(body.model, "fixture-model");
    assert.equal(Object.hasOwn(body, "max_completion_tokens"), false);
    assert.equal(Object.hasOwn(body, "max_tokens"), false);
  }
});

test("round-only execution rejects before starting and stops on cancellation without replay", async () => {
  const f = fixture();
  Object.assign(f.params, {
    budget: null,
    profileId: null,
    outputCap: null,
    maxInferences: null,
  });
  f.params.onRunStarted = async () => {
    throw Error("SOCIAL_TURN_CLOSED");
  };
  await assert.rejects(runOpenAISocial(f.params), /SOCIAL_TURN_CLOSED/);
  assert.equal(f.bodies.length, 0);
  const controller = new AbortController();
  f.params.signal = controller.signal;
  f.params.onRunStarted = async () => {};
  f.params.fetch = async (_url, options) => {
    f.bodies.push(JSON.parse(options.body));
    controller.abort();
    throw Error("SYNTHETIC_DISCONNECT");
  };
  await assert.rejects(runOpenAISocial(f.params), /SYNTHETIC_DISCONNECT/);
  assert.equal(f.bodies.length, 1);
  await assert.rejects(runOpenAISocial(f.params), /ABORTED/);
  assert.equal(f.bodies.length, 1);
});

function windowBinding(runId, windowId = "window-one", actor = "host") {
  return {
    runId,
    windowId,
    actorIdentity: { agentId: `agent-${actor}`, generation: actor },
    target: { kind: "visit", id: `visit-${windowId}` },
    targetHostGeneration: "host",
    targetGuestGeneration: "guest",
    epoch: "synthetic-epoch",
    backendContract: "synthetic-backend-contract",
  };
}
function socialBackend(t) {
  const f = fixture(),
    cfg = config();
  Object.assign(f.params, {
    budget: null,
    profileId: null,
    outputCap: null,
    maxInferences: null,
  });
  const backend = new OpenAIBackend(
    {
      ...cfg.backends[0],
      type: "openai",
      baseUrl: "https://compatible.example/v1",
      model: "fixture-model",
      apiKeyEnv: "",
    },
    cfg.agents[0],
    { root: temp(t), fetch: (...args) => f.params.fetch(...args) },
  );
  t.after(() => backend.close());
  return { ...f, backend };
}

test("OpenAI social keeps one system and incremental user input per window while ordinary sessions stay separate", async (t) => {
  const f = socialBackend(t);
  const ordinaryFile = path.join(f.backend.dir, "ordinary-session.json");
  fs.writeFileSync(ordinaryFile, "synthetic ordinary chat data");
  for (const index of [1, 2, 3])
    await f.backend.runSocial({
      ...f.params,
      binding: windowBinding(`run-${index}`),
      prompt: `new message ${index}`,
      session: { id: "ordinary-session" },
    });
  const messages = f.bodies[2].messages;
  assert.equal(
    messages.filter((message) => message.role === "system").length,
    1,
  );
  assert.deepEqual(
    messages
      .filter((message) => message.role === "user")
      .map((message) => message.content),
    ["new message 1", "new message 2", "new message 3"],
  );
  assert.equal(
    messages.filter((message) => message.role === "assistant").length,
    2,
  );
  assert.equal(
    fs.readFileSync(ordinaryFile, "utf8"),
    "synthetic ordinary chat data",
  );
  assert.deepEqual(fs.readdirSync(f.backend.dir), ["ordinary-session.json"]);
  await f.backend.closeSocialSessions({ windowId: "window-one" });
  await assert.rejects(
    f.backend.runSocial({ ...f.params, binding: windowBinding("closed-run") }),
    /SOCIAL_TURN_CLOSED/,
  );
  assert.equal(f.bodies.length, 3);
});

test("OpenAI social histories are isolated across actors and windows and cleared on adapter close", async (t) => {
  const f = socialBackend(t);
  for (const [runId, windowId, actor, prompt] of [
    ["r1", "w1", "host", "host private window input"],
    ["r2", "w1", "guest", "guest input"],
    ["r3", "w2", "host", "another window input"],
  ]) {
    await f.backend.runSocial({
      ...f.params,
      binding: windowBinding(runId, windowId, actor),
      prompt,
    });
  }
  for (const body of f.bodies) assert.equal(body.messages.length, 2);
  assert.doesNotMatch(JSON.stringify(f.bodies[1]), /host private window input/);
  assert.doesNotMatch(
    JSON.stringify(f.bodies[2]),
    /host private window input|guest input/,
  );
  await f.backend.close();
  assert.equal(f.backend.socialSessionPool.capsules.size, 0);
});

test("OpenAI yielded history answers every tool call before reuse and never executes calls after sealing", async (t) => {
  const f = socialBackend(t);
  let yielded = false,
    requests = 0;
  const tools = [
    {
      type: "function",
      function: { name: "home_exchange_yield", parameters: { type: "object" } },
    },
    ...f.params.tools,
  ];
  const calls = [];
  f.params.fetch = async (_url, options) => {
    f.bodies.push(JSON.parse(options.body));
    return {
      ok: true,
      json: async () => ({
        choices: [
          {
            message:
              ++requests === 1
                ? {
                    tool_calls: [
                      {
                        id: "sealed-call",
                        type: "function",
                        function: {
                          name: "home_exchange_yield",
                          arguments: "{}",
                        },
                      },
                      {
                        id: "unexecuted-call",
                        type: "function",
                        function: { name: "home_visit_send", arguments: "{}" },
                      },
                    ],
                  }
                : { content: "continue normally" },
          },
        ],
      }),
    };
  };
  const params = {
    ...f.params,
    tools,
    maxCallsPerInference: 2,
    shouldStop: () => yielded,
    beforeInput: async () => {
      if (yielded) throw Error("SOCIAL_TURN_CLOSED");
    },
    callTool: async (name) => {
      calls.push(name);
      yielded = true;
      return { batchSealed: true };
    },
  };
  await f.backend.runSocial({
    ...params,
    binding: windowBinding("yield-first"),
  });
  yielded = false;
  await f.backend.runSocial({
    ...params,
    binding: windowBinding("yield-second"),
    prompt: "new response",
  });
  assert.deepEqual(calls, ["home_exchange_yield"]);
  const messages = f.bodies[1].messages;
  assert.deepEqual(
    messages
      .filter((message) => message.role === "tool")
      .map((message) => message.tool_call_id),
    ["sealed-call", "unexecuted-call"],
  );
  assert.equal(
    JSON.parse(
      messages.find((message) => message.tool_call_id === "sealed-call")
        .content,
    ).batchSealed,
    true,
  );
  assert.equal(
    JSON.parse(
      messages.find((message) => message.tool_call_id === "unexecuted-call")
        .content,
    ).code,
    "SOCIAL_TURN_CLOSED",
  );
  assert.equal(messages.at(-1).content, "new response");
});

test("OpenAI unknown continuation closes its history without replay or replacement", async (t) => {
  const f = socialBackend(t);
  await f.backend.runSocial({
    ...f.params,
    binding: windowBinding("known-run"),
  });
  let failures = 0;
  f.params.fetch = async () => {
    failures++;
    throw Error("SYNTHETIC_UNKNOWN");
  };
  await assert.rejects(
    f.backend.runSocial({ ...f.params, binding: windowBinding("unknown-run") }),
    /SYNTHETIC_UNKNOWN/,
  );
  assert.equal(f.backend.socialSessionPool.capsules.size, 0);
  await assert.rejects(
    f.backend.runSocial({
      ...f.params,
      binding: windowBinding("never-replay"),
    }),
    /SOCIAL_TURN_CLOSED/,
  );
  assert.equal(failures, 1);
});

test("explicitly truncated OpenAI output closes its window without tools or automatic reconstruction", async (t) => {
  for (const reason of ["length", "content_filter"]) {
    const f = socialBackend(t);
    let calls = 0;
    f.params.fetch = async (_url, options) => {
      f.bodies.push(JSON.parse(options.body));
      return {
        ok: true,
        json: async () => ({
          choices: [
            {
              finish_reason: reason,
              message: { content: "incomplete synthetic output" },
            },
          ],
        }),
      };
    };
    const params = {
      ...f.params,
      binding: windowBinding("truncated-run"),
      callTool: async () => {
        calls++;
      },
    };
    await assert.rejects(
      f.backend.runSocial(params),
      /SOCIAL_RESPONSE_INVALID/,
    );
    await assert.rejects(
      f.backend.runSocial({
        ...params,
        binding: windowBinding("no-reconstruction"),
      }),
      /SOCIAL_TURN_CLOSED/,
    );
    assert.equal(f.bodies.length, 1);
    assert.equal(calls, 0);
  }
});
