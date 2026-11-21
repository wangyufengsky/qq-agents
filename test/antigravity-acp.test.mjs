import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { antigravityHookAllowed } from "../src/backends/antigravity-guard.mjs";
import http from "node:http";
import { runAcp } from "../src/backends/antigravity-acp.mjs";
import { AntigravityBackend } from "../src/backends/antigravity.mjs";
import { temp } from "./helpers.mjs";
import { AntigravityMedia } from "../src/backends/antigravity-media.mjs";
import { validateConfig } from "../src/core/config.mjs";
import { mediaLease } from "../src/tools/media-lease.mjs";
import { colorGrid } from "../scripts/fixtures/antigravity-media.mjs";
const id = "11111111-1111-4111-8111-111111111111";
const options = {
  command: "synthetic",
  settings: "settings.json",
  workspace: process.cwd(),
  profile: "profile",
  model: "synthetic",
  effort: "low",
};
function fake(overrides = {}) {
  const calls = [],
    replies = [];
  let killed = false;
  const launch = () => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => {
      killed = true;
      return true;
    };
    child.stdin = new Writable({
      write(data, encoding, callback) {
        const msg = JSON.parse(String(data));
        if (!msg.method) {
          replies.push(msg);
          callback();
          return;
        }
        calls.push(msg);
        const defaults = {
          initialize: {
            protocolVersion: 1,
            agentCapabilities: {
              loadSession: true,
              promptCapabilities: { image: true },
            },
          },
          "session/new": { sessionId: id },
          "session/load": {},
          "session/set_model": {},
          "session/set_config_option": {},
          "session/prompt": {
            stopReason: "end_turn",
            usage: { inputTokens: 999999 },
          },
        };
        const override = overrides[msg.method];
        const result = Object.hasOwn(overrides, msg.method)
          ? typeof override === "function"
            ? override(msg, calls)
            : override
          : defaults[msg.method];
        queueMicrotask(() => {
          if (msg.method === "session/prompt") {
            child.stdout.write(
              JSON.stringify({
                jsonrpc: "2.0",
                id: "permission",
                method: "session/request_permission",
                params: {
                  options: [{ optionId: "allow", kind: "allow_once" }],
                },
              }) + "\n",
            );
            child.stdout.write(
              JSON.stringify({
                jsonrpc: "2.0",
                id: "file",
                method: "fs/read_text_file",
                params: { path: "private" },
              }) + "\n",
            );
          }
          child.stdout.write(
            typeof result === "string"
              ? result + "\n"
              : JSON.stringify({
                  jsonrpc: "2.0",
                  id: msg.id,
                  ...(result.error ? result : { result }),
                }) + "\n",
          );
        });
        callback();
      },
    });
    return child;
  };
  return { launch, calls, replies, killed: () => killed };
}
test("ACP preserves the terminal contract, refuses client capabilities, and avoids cumulative occupancy", async () => {
  const f = fake(),
    events = [];
  await runAcp(options, "synthetic prompt", (e) => events.push(e), f.launch);
  assert.equal(events[0].conversation_id, id);
  assert.equal(events.at(-1).result.status, "SUCCESS");
  assert.equal(events[1].step_update.usage, undefined);
  assert.deepEqual(f.calls.at(-1).params.prompt, [
    { type: "text", text: "synthetic prompt" },
  ]);
  assert.deepEqual(f.replies[0].result, { outcome: { outcome: "cancelled" } });
  assert.equal(f.replies[1].error.code, -32601);
  assert(f.killed());
});
test("ACP resumes only the supplied session and sets the configured model and effort", async () => {
  const f = fake();
  await runAcp({ ...options, session: id }, "next", () => {}, f.launch);
  assert.equal(f.calls[1].method, "session/load");
  assert.equal(f.calls[1].params.sessionId, id);
  assert.equal(f.calls[2].params.modelId, "synthetic");
  assert.equal(f.calls[3].params.value, "low");
});
test("ACP group turns specify registered routes even if native read and send names are absent", async () => {
  for (const session of [undefined, id]) {
    const f = fake();
    await runAcp(
      {
        ...options,
        session,
        bridgeTools: true,
        groupToolNames: ["conversation_read", "qq_send", "qq_draft"],
      },
      "Current group input with readGap.",
      () => {},
      f.launch,
    );
    const text = f.calls.at(-1).params.prompt[0].text;
    assert.match(
      text,
      /mcp_qq-agents_qq_tool_call with name="conversation_read"/,
    );
    assert.match(
      text,
      /mcp_qq-agents_qq_reply_call with name set to qq_send or qq_draft/,
    );
    assert.match(text, /argumentsJson/);
    assert.match(text, /readGap/);
    assert.match(text, /before reporting.*unavailable/);
    assert.doesNotMatch(text, /qq_reply_call if listed|qq_send_burst/);
    assert.match(text, /Current group input with readGap\./);
    if (session) assert.equal(f.calls[1].params.sessionId, session);
  }
});

test("ACP group turn with only read access gives no reply route", async () => {
  const f = fake();
  await runAcp(
    {
      ...options,
      session: id,
      bridgeTools: true,
      groupToolNames: ["conversation_read"],
    },
    "Current group input.",
    () => {},
    f.launch,
  );
  const text = f.calls.at(-1).params.prompt[0].text;
  assert.match(
    text,
    /mcp_qq-agents_qq_tool_call with name="conversation_read"/,
  );
  assert.doesNotMatch(text, /qq_reply_call|qq_send/);
});

test("ACP submits all desktop JPEGs as native input in the same bridge turn", async () => {
  const f = fake();
  const events = [];
  const image = { type: "image", mimeType: "image/jpeg", data: "AQID" };
  const second = { type: "image", mimeType: "image/jpeg", data: "BAUG" };
  const content = [image, { type: "text", text: "Second display" }, second];
  let takes = 0;
  await runAcp(
    { ...options, desktop: true, desktopScreen: true },
    "capture the fixture",
    (event) => events.push(event),
    f.launch,
    [],
    async () => {
      takes++;
      if (takes === 2) return null;
      assert.equal(
        f.calls.filter(({ method }) => method === "session/prompt").length,
        1,
      );
      return { content, receiptId: "a".repeat(32) };
    },
    undefined,
    async (receiptId) => {
      assert.equal(receiptId, "a".repeat(32));
    },
  );
  const prompts = f.calls.filter(({ method }) => method === "session/prompt");
  assert.equal(takes, 2);
  assert.equal(prompts.length, 2);
  assert.equal(prompts[0].params.sessionId, prompts[1].params.sessionId);
  assert.deepEqual(prompts[1].params.prompt.slice(1), content);
  assert.equal(events.filter(({ event }) => event === "result").length, 1);
});
test("ACP never acknowledges an image when its native prompt fails", async () => {
  let acknowledgements = 0;
  const f = fake({
    "session/prompt": (_msg, calls) => ({
      stopReason:
        calls.filter(({ method }) => method === "session/prompt").length === 1
          ? "end_turn"
          : "cancelled",
    }),
  });
  await assert.rejects(
    runAcp(
      { ...options, desktop: true, desktopScreen: true },
      "capture",
      () => {},
      f.launch,
      [],
      async () => ({
        image: { type: "image", mimeType: "image/jpeg", data: "AQID" },
        receiptId: "a".repeat(32),
      }),
      undefined,
      async () => {
        acknowledgements++;
      },
    ),
    /ANTIGRAVITY_PROTOCOL_ERROR/,
  );
  assert.equal(acknowledgements, 0);
});
test("ACP ignores a mismatched native prompt response for the captured frame", async () => {
  let acknowledgements = 0;
  const f = fake({
    "session/prompt": (_msg, calls) =>
      calls.filter(({ method }) => method === "session/prompt").length === 1
        ? { stopReason: "end_turn" }
        : JSON.stringify({
            jsonrpc: "2.0",
            id: 999,
            result: { stopReason: "end_turn" },
          }),
  });
  await assert.rejects(
    runAcp(
      { ...options, desktop: true, desktopScreen: true },
      "capture",
      () => {},
      f.launch,
      [],
      async () => ({
        image: { type: "image", mimeType: "image/jpeg", data: "AQID" },
        receiptId: "a".repeat(32),
      }),
      undefined,
      async () => {
        acknowledgements++;
      },
    ),
    /ANTIGRAVITY_PROTOCOL_ERROR/,
  );
  assert.equal(acknowledgements, 0);
});
test("ACP checks for a requested screenshot after delivering video", async () => {
  const f = fake();
  const calls = () =>
    f.calls.filter(({ method }) => method === "session/prompt");
  const video = { type: "image", mimeType: "image/jpeg", data: "AQID" };
  const screen = { type: "image", mimeType: "image/jpeg", data: "BAUG" };
  await runAcp(
    { ...options, desktop: true, desktopScreen: true, videoFrames: true },
    "watch the fixture",
    () => {},
    f.launch,
    [],
    async () =>
      calls().length === 2
        ? { image: screen, receiptId: "b".repeat(32) }
        : null,
    async () => (calls().length === 1 ? [video] : []),
    async () => {},
  );
  assert.deepEqual(
    calls().map(({ params }) =>
      params.prompt.filter(({ type }) => type === "image"),
    ),
    [[], [video], [screen]],
  );
  assert(calls().every(({ params }) => params.sessionId === id));
});

test("ACP receives the full video rewatch with eight labelled frames and subtitles", async (t) => {
  const f = fake();
  const text = (text) => ({ type: "text", text });
  const image = { type: "image", mimeType: "image/jpeg", data: "AQID" };
  const parts = [
    text("metadata"),
    ...Array.from({ length: 8 }, (_, index) => [
      text("frame " + index),
      image,
    ]).flat(),
    text("subtitle"),
  ];
  let contents = parts;
  const server = http.createServer((req, res) => {
    if (req.method !== "POST" || req.url !== "/video-frames")
      return res.writeHead(404).end();
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ contents }));
    contents = [];
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const endpoint = process.env.QQ_AGY_ENDPOINT;
  const token = process.env.QQ_AGY_TOKEN;
  process.env.QQ_AGY_ENDPOINT = `http://127.0.0.1:${server.address().port}`;
  process.env.QQ_AGY_TOKEN = "synthetic";
  t.after(() => {
    if (endpoint === undefined) delete process.env.QQ_AGY_ENDPOINT;
    else process.env.QQ_AGY_ENDPOINT = endpoint;
    if (token === undefined) delete process.env.QQ_AGY_TOKEN;
    else process.env.QQ_AGY_TOKEN = token;
  });
  await runAcp(
    { ...options, videoFrames: true },
    "rewatch",
    () => {},
    f.launch,
  );
  const prompts = f.calls.filter(({ method }) => method === "session/prompt");
  assert.deepEqual(prompts[1].params.prompt.slice(1), parts);
  contents = [...parts, text("unexpected part")];
  await assert.rejects(
    runAcp(
      { ...options, videoFrames: true },
      "rewatch",
      () => {},
      fake().launch,
    ),
    /ANTIGRAVITY_PROTOCOL_ERROR/,
  );
});

test("ACP resumes with a current tool route when a native alias is unavailable", async () => {
  const f = fake();
  await runAcp(
    { ...options, session: id, bridgeTools: true },
    "send with qq_send",
    () => {},
    f.launch,
  );
  const [{ text }] = f.calls.at(-1).params.prompt;
  assert.match(text, /if it is listed for this turn/i);
  assert.match(text, /unknown tool.*before execution/i);
  assert.match(
    text,
    /mcp_qq-agents_qq_tool_call.*name.*logical.*argumentsJson/i,
  );
  assert.doesNotMatch(text, /call_mcp_tool/);
  assert.match(text, /same requestId/);
  assert.match(text, /tool errors from earlier turns do not determine/i);
  assert(text.endsWith("\n\nsend with qq_send"));
});
for (const [name, overrides] of Object.entries({
  missingVision: { initialize: { protocolVersion: 1, agentCapabilities: {} } },
  malformed: { "session/prompt": "not json" },
  missingResult: { "session/prompt": '{"jsonrpc":"2.0","id":5,"result":null}' },
  cancelled: { "session/prompt": { stopReason: "cancelled" } },
  refusedModel: {
    "session/set_model": {
      error: { code: -1, message: "private provider detail" },
    },
  },
}))
  test(`ACP fails closed for ${name} without a success terminal`, async () => {
    const f = fake(overrides),
      events = [];
    await assert.rejects(
      runAcp(options, "prompt", (e) => events.push(e), f.launch),
      /^Error: ANTIGRAVITY_PROTOCOL_ERROR$/,
    );
    assert(!events.some((e) => e.event === "result"));
    assert(f.killed());
  });
test("ACP image blocks retain pixels and frame metadata without granting native paths", () => {
  const media = new AntigravityMedia(undefined, true);
  const content = [
    { type: "text", text: '{"sampled":true,"frame":2}' },
    {
      type: "image",
      mimeType: "image/png",
      data: colorGrid(["blue", "red", "yellow", "green"]).toString("base64"),
    },
  ];
  const result = media.result({ content });
  assert.deepEqual(result.content, content);
  assert.deepEqual(media.catalog(), []);
  assert.equal(media.directory, null);
  assert.throws(
    () => media.result({ content, [mediaLease]: () => false }),
    /ANTIGRAVITY_TURN_INACTIVE/,
  );
  assert.throws(
    () => media.result({ content: [...Array(11)].map(() => content[1]) }),
    /ANTIGRAVITY_MEDIA_LIMIT/,
  );
  assert.throws(
    () =>
      media.result({ content: [{ ...content[1], mimeType: "image/jpeg" }] }),
    /ANTIGRAVITY_MEDIA_FORMAT/,
  );
  media.close();
  assert.throws(() => media.result({ content }), /ANTIGRAVITY_TURN_INACTIVE/);
});
test("ACP is opt-in and cannot be assigned to unrelated backends", () => {
  const config = {
    version: 1,
    mode: "isolated",
    agents: [],
    connections: [],
    backends: [{ id: "probe", type: "antigravity", label: "Probe" }],
  };
  assert.equal(validateConfig(config).backends[0].cliProtocol, undefined);
  assert.equal(
    validateConfig({
      ...config,
      backends: [{ ...config.backends[0], cliProtocol: "acp" }],
    }).backends[0].cliProtocol,
    "acp",
  );
  assert.throws(() =>
    validateConfig({
      ...config,
      backends: [{ ...config.backends[0], type: "codex", cliProtocol: "acp" }],
    }),
  );
});

test("ACP pre-registers permitted reply and video tools in the native catalogue", async (t) => {
  const root = temp(t);
  const backend = new AntigravityBackend(
    { type: "antigravity", cliProtocol: "acp", toolServers: [] },
    { id: "probe" },
    { root },
  );
  t.after(() => backend.close());
  const media = new AntigravityMedia(undefined, true);
  const custom = path.join(root, ".agents");
  const agents = path.join(custom, "agents");
  fs.mkdirSync(agents, { recursive: true });
  const params = {
    tools: [
      "qq_send",
      "qq_draft",
      "qq_delivery_status",
      "board_read",
      "video_read",
    ].map((name) => ({ name, inputSchema: { type: "object" } })),
  };
  const workspace = { workspace: root, custom, agents };
  const check = () => {
    const server = JSON.parse(
      fs.readFileSync(path.join(custom, "mcp_config.json"), "utf8"),
    ).mcpServers["qq-agents"];
    assert.deepEqual(server.enabledTools, [
      ...params.tools
        .map(({ name }) => name)
        .filter((name) => name !== "video_read"),
      "qq_reply_call",
      "qq_video_call",
      "qq_tool_call",
    ]);
    assert.deepEqual(server.tools, {
      qq_reply_call: { eager: true },
      qq_delivery_status: { eager: true },
      qq_video_call: { eager: true },
      qq_tool_call: { eager: true },
    });
    const guide = fs.readFileSync(path.join(agents, "qq-agents.md"), "utf8");
    assert.match(
      guide,
      /use the native MCP tool if it is listed for this turn/i,
    );
    assert.match(guide, /qq_reply_call.*argumentsJson/);
    assert.match(guide, /For video_read, use mcp_qq-agents_qq_video_call/);
    assert.match(guide, /mcp_qq-agents_qq_tool_call/);
    assert.doesNotMatch(guide, /call_mcp_tool/);
  };
  backend.configure(params, workspace, media);
  check();
  backend.configure({ ...params, session: { id } }, workspace, media);
  check();
});

test("ACP native MCP aliases require exact server, tool and active catalogue", () => {
  const input = { toolCall: { name: "mcp_qq-agents_probe_image", args: {} } };
  const catalogue = {
    tools: [{ name: "probe_image" }],
    images: [],
    nativeMcp: true,
  };
  assert.equal(antigravityHookAllowed(input, catalogue), true);
  for (const denied of [
    { ...catalogue, nativeMcp: false },
    { ...catalogue, tools: [] },
  ])
    assert.equal(antigravityHookAllowed(input, denied), false);
  for (const name of [
    "mcp_other_probe_image",
    "mcp_qq-agents_probe_image_extra",
    "read_file",
    "run_command",
  ])
    assert.equal(
      antigravityHookAllowed({ toolCall: { name, args: {} } }, catalogue),
      false,
    );
});

test("ACP prompt includes labelled images directly without filesystem reads", async () => {
  const f = fake();
  await runAcp(options, "look", () => {}, f.launch, [
    {
      eventId: "fixture",
      index: 0,
      label: "picture",
      mimeType: "image/png",
      data: "cGl4ZWxz",
    },
  ]);
  assert.deepEqual(f.calls.at(-1).params.prompt, [
    { type: "text", text: "look" },
    { type: "text", text: "picture" },
    { type: "image", mimeType: "image/png", data: "cGl4ZWxz" },
  ]);
});
