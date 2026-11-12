import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { antigravityHookAllowed } from "../src/backends/antigravity-guard.mjs";
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
        const result = Object.hasOwn(overrides, msg.method)
          ? overrides[msg.method]
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
test("ACP submits a captured desktop JPEG as native input in the same bridge turn", async () => {
  const f = fake();
  const events = [];
  const image = { type: "image", mimeType: "image/jpeg", data: "AQID" };
  let takes = 0;
  await runAcp(
    { ...options, desktop: true, desktopScreen: true },
    "capture the fixture",
    (event) => events.push(event),
    f.launch,
    [],
    async () => {
      takes++;
      assert.equal(
        f.calls.filter(({ method }) => method === "session/prompt").length,
        1,
      );
      return image;
    },
  );
  const prompts = f.calls.filter(({ method }) => method === "session/prompt");
  assert.equal(takes, 1);
  assert.equal(prompts.length, 2);
  assert.equal(prompts[0].params.sessionId, prompts[1].params.sessionId);
  assert.deepEqual(prompts[1].params.prompt[1], image);
  assert.equal(events.filter(({ event }) => event === "result").length, 1);
});
test("ACP resumes with a current tool route when a native alias is unavailable", async () => {
  const f = fake();
  await runAcp(
    { ...options, session: id },
    "send with qq_send",
    () => {},
    f.launch,
  );
  const [{ text }] = f.calls.at(-1).params.prompt;
  assert.match(text, /if it is listed for this turn/i);
  assert.match(text, /unknown tool.*before execution/i);
  assert.match(
    text,
    /call_mcp_tool.*ServerName="qq-agents".*ToolName.*logical/i,
  );
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

test("ACP pre-registers the permitted reply tools in the native catalogue", async (t) => {
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
    tools: ["qq_send", "qq_draft", "qq_delivery_status", "board_read"].map(
      (name) => ({ name, inputSchema: { type: "object" } }),
    ),
  };
  const workspace = { workspace: root, custom, agents };
  const check = () => {
    const server = JSON.parse(
      fs.readFileSync(path.join(custom, "mcp_config.json"), "utf8"),
    ).mcpServers["qq-agents"];
    assert.deepEqual(server.enabledTools, [
      ...params.tools.map(({ name }) => name),
      "qq_reply_call",
    ]);
    assert.deepEqual(server.tools, {
      qq_reply_call: { eager: true },
      qq_delivery_status: { eager: true },
    });
    const guide = fs.readFileSync(path.join(agents, "qq-agents.md"), "utf8");
    assert.match(
      guide,
      /use the native MCP tool if it is listed for this turn/i,
    );
    assert.match(guide, /qq_reply_call.*argumentsJson/);
    assert.doesNotMatch(guide, /Call call_mcp_tool with ServerName/);
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
