import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import { EventEmitter } from "node:events";
import { OpenAIBackend } from "../src/backends/openai.mjs";
import { CodexBackend } from "../src/backends/codex.mjs";
import {
  runNativeSocial,
  assertSocialToolResult,
} from "../src/backends/native-social.mjs";
import { mediaLease } from "../src/tools/media-lease.mjs";
import { config, temp } from "./helpers.mjs";

const pixel = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6a1sAAAAASUVORK5CYII=",
    "base64",
  ),
  image = Buffer.concat([pixel, Buffer.alloc(40000)]).toString("base64");
const tool = (name) => ({
  type: "function",
  function: { name, parameters: { type: "object" } },
});
const scene = (lease = () => true) => ({
  [mediaLease]: lease,
  content: [
    {
      type: "text",
      text: JSON.stringify({
        effectiveScene: { visibleObjectCount: 13 },
        imageAvailable: true,
      }),
    },
    { type: "image", mimeType: "image/png", data: image },
  ],
});
const call = (id, name) => ({
  id,
  type: "function",
  function: { name, arguments: "{}" },
});
const params = (extra = {}) => ({
  binding: { runId: "synthetic-scene-run" },
  budget: null,
  outputCap: null,
  maxInferences: null,
  prompt: "查看自己的小窝",
  instructions: "合成社交角色",
  tools: [tool("room_scene_view")],
  signal: new AbortController().signal,
  beforeInput: async () => {},
  onRunStarted: async () => {},
  callTool: async () => scene(),
  maxToolResultBytes: 32000,
  maxCallsPerInference: 8,
  ...extra,
});
async function server(t, script) {
  const requests = [],
    app = http.createServer(async (req, res) => {
      let body = "";
      for await (const part of req) body += part;
      requests.push(JSON.parse(body));
      const next = script.shift();
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          choices: [{ message: next }],
          usage: { prompt_tokens: 100, completion_tokens: 20 },
        }),
      );
    });
  await new Promise((resolve) => app.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => app.close(resolve)));
  return { requests, baseUrl: `http://127.0.0.1:${app.address().port}/v1` };
}
function backend(t, baseUrl, extra = {}, fetch) {
  const root = temp(t),
    adapter = new OpenAIBackend(
      {
        id: "scene",
        type: "openai",
        baseUrl,
        model: "synthetic-vision",
        vision: true,
        toolServers: [],
        ...extra,
      },
      { id: "synthetic-role" },
      { root, ...(fetch ? { fetch } : {}) },
    );
  t.after(() => adapter.close());
  return { adapter, root };
}
function images(request) {
  return request.messages.flatMap((message) =>
    Array.isArray(message.content)
      ? message.content.filter((part) => part.type === "image_url")
      : [],
  );
}

test("social OpenAI sends real HTTP image_url after all tool replies and drops consumed pixels from window history", async (t) => {
  let valid = true;
  const s = await server(t, [
      { tool_calls: [call("scene-1", "room_scene_view")] },
      { content: "看到了家具" },
      { content: "继续聊" },
    ]),
    { adapter, root } = backend(t, s.baseUrl),
    binding = {
      runId: "scene-run-1",
      windowId: "scene-window",
      actorIdentity: { generation: "synthetic-generation" },
    };
  await adapter.runSocial(
    params({ binding, callTool: async () => scene(() => valid) }),
  );
  assert.equal(s.requests.length, 2);
  assert.equal(images(s.requests[0]).length, 0);
  assert.equal(images(s.requests[1]).length, 1);
  assert.equal(
    images(s.requests[1])[0].image_url.url,
    `data:image/png;base64,${image}`,
  );
  assert.equal(s.requests[1].messages.at(-2).role, "tool");
  assert.equal(s.requests[1].messages.at(-1).role, "user");
  valid = false;
  await adapter.runSocial(
    params({ binding: { ...binding, runId: "scene-run-2" } }),
  );
  assert.equal(images(s.requests[2]).length, 0);
  assert.equal(
    JSON.stringify(s.requests[2]).includes("visibleObjectCount"),
    true,
  );
  assert.equal(JSON.stringify(s.requests[2]).includes("未交付"), false);
  assert.equal(
    JSON.stringify(
      [...adapter.socialSessionPool.capsules.values()][0].messages,
    ).includes(image),
    false,
  );
  assert.deepEqual(
    fs.readdirSync(`${root}/openai/synthetic-role/sessions`),
    [],
  );
});

test("social OpenAI rechecks a prepared image lease immediately before HTTP input", async (t) => {
  let valid = true,
    starts = 0;
  const s = await server(t, [
      { tool_calls: [call("scene-1", "room_scene_view")] },
      { content: "未收到旧图片" },
    ]),
    { adapter } = backend(t, s.baseUrl);
  await adapter.runSocial(
    params({
      callTool: async () => scene(() => valid),
      onRunStarted: async () => {
        if (++starts === 2) valid = false;
      },
    }),
  );
  assert.equal(images(s.requests[1]).length, 0);
  assert.equal(JSON.stringify(s.requests[1]).includes(image), false);
  assert.match(JSON.stringify(s.requests[1]), /未交付/);
  assert.equal(
    JSON.stringify(s.requests[1]).includes("visibleObjectCount"),
    false,
  );
});

test("hard-budget social requests preserve reservations and explicitly withhold unbounded pixels", async (t) => {
  const s = await server(t, [
      { tool_calls: [call("scene-1", "room_scene_view")] },
      { content: "仅收到文字降级" },
    ]),
    { adapter } = backend(
      t,
      "https://api.openai.com/v1",
      {
        model: "gpt-4.1-mini-2025-04-14",
        socialProfile: "openai-gpt-4.1-mini",
      },
      (_url, init) => fetch(`${s.baseUrl}/chat/completions`, init),
    ),
    reservations = [],
    settlements = [],
    budget = {
      reserveInference: async (value) => {
        reservations.push(value);
        return {
          reservationId: `reservation-${reservations.length}`,
          claimed: true,
        };
      },
      settleInference: async (value) => {
        settlements.push(value);
      },
    };
  await adapter.runSocial(params({ budget, outputCap: 100, maxInferences: 3 }));
  assert.equal(reservations.length, 2);
  assert.ok(
    reservations.every(
      (row) => row.inputUpperBound === 1047576 && row.outputCap === 100,
    ),
  );
  assert.equal(settlements.length, 2);
  assert.ok(settlements.every((row) => row.status === "completed"));
  assert.equal(images(s.requests[1]).length, 0);
  assert.match(JSON.stringify(s.requests[1]), /显式硬预算/);
  assert.equal(JSON.stringify(s.requests[1]).includes(image), false);
});

test("a terminal social batch answers remaining calls without submitting or retaining its pending image", async (t) => {
  let sealed = false,
    sceneCalls = 0;
  const s = await server(t, [
      {
        tool_calls: [
          call("scene-1", "room_scene_view"),
          call("yield-1", "home_exchange_yield"),
          call("scene-2", "room_scene_view"),
        ],
      },
    ]),
    { adapter } = backend(t, s.baseUrl),
    binding = {
      runId: "sealed-scene",
      windowId: "sealed-window",
      actorIdentity: { generation: "synthetic-generation" },
    };
  await adapter.runSocial(
    params({
      binding,
      tools: [tool("room_scene_view"), tool("home_exchange_yield")],
      shouldStop: () => sealed,
      callTool: async (name) => {
        if (name === "home_exchange_yield") {
          sealed = true;
          return { status: "committed" };
        }
        sceneCalls++;
        return scene();
      },
    }),
  );
  assert.equal(s.requests.length, 1);
  assert.equal(sceneCalls, 1);
  const history = [...adapter.socialSessionPool.capsules.values()][0].messages;
  assert.equal(JSON.stringify(history).includes(image), false);
  assert.match(history.at(-1).content, /SOCIAL_TURN_CLOSED/);
});

test("native scene quota keeps its media lease and does not exempt other tools, extra images or text", async () => {
  const result = scene();
  assertSocialToolResult("room_scene_view", result, 32000);
  for (const [name, value] of [
    ["home_visit_read", result],
    [
      "room_scene_view",
      { ...result, content: [...result.content, result.content[1]] },
    ],
    [
      "room_scene_view",
      {
        ...result,
        content: [
          result.content[0],
          {
            ...result.content[1],
            data: Buffer.alloc(4 * 1024 * 1024 + 1).toString("base64"),
          },
        ],
      },
    ],
    [
      "room_scene_view",
      {
        ...result,
        content: [{ type: "text", text: "x".repeat(32001) }, result.content[1]],
      },
    ],
  ])
    assert.throws(
      () => assertSocialToolResult(name, value, 32000),
      /SOCIAL_TOOL_RESULT_LIMIT/,
    );
  let delivered;
  await runNativeSocial(
    {
      run: async (value) => {
        await value.beforeInputSubmitted();
        delivered = await value.callTool("room_scene_view", {});
      },
    },
    params({ callTool: async () => result }),
    async () => {},
  );
  assert.equal(delivered, result);
  assert.equal(delivered[mediaLease], result[mediaLease]);
});

class Rpc extends EventEmitter {
  responses = [];
  async start() {}
  async request(method) {
    if (method === "account/read") return { account: { type: "fixture" } };
    if (method === "config/read") return { config: { mcp_servers: {} } };
    if (method === "thread/start") return { thread: { id: "scene-thread" } };
    if (method === "turn/start") return { turn: { id: "scene-turn" } };
    return {};
  }
  reject() {
    assert.fail("authorized scene request rejected");
  }
  respond(id, value) {
    this.responses.push({ id, value });
  }
  close() {}
}
test("Codex native social delivers a scene as inputImage through its actual dynamic-tool MCP adapter", async (t) => {
  const cfg = config(),
    rpc = new Rpc(),
    adapter = new CodexBackend(cfg.backends[0], cfg.agents[0], {
      root: temp(t),
      rpc,
    });
  t.after(() => adapter.close());
  const running = adapter.runSocial(params());
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(adapter.active.get("scene-thread").turnId, "scene-turn");
  await adapter.request({
    id: 1,
    method: "item/tool/call",
    params: {
      threadId: "scene-thread",
      turnId: "scene-turn",
      tool: "room_scene_view",
      arguments: {},
    },
  });
  assert.equal(
    rpc.responses[0].value.contentItems.find(
      (part) => part.type === "inputImage",
    ).imageUrl,
    `data:image/png;base64,${image}`,
  );
  rpc.emit("notification", {
    method: "turn/completed",
    params: {
      threadId: "scene-thread",
      turn: { id: "scene-turn", status: "completed" },
    },
  });
  await running;
});
