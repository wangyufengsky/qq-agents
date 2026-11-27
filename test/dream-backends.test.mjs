import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { WebSocketServer } from "ws";
import { createServer } from "../src/server.mjs";
import { NodeApiClient } from "../vendor/dsh-qq/dsh-client.js";
import { BackendRegistry } from "../src/backends/index.mjs";
import { checkpoint } from "../src/dream/store.mjs";
import { CodexRpc } from "../vendor/local-bridge/codex-rpc.mjs";
import { config, fixture, relayEnvironment } from "./helpers.mjs";

const agentId = "agent-0";
const cliFixture = fileURLToPath(
  new URL("./dream-backend-cli-fixture.mjs", import.meta.url),
);
const cognitiveTools = [
  "dream_cognition_list",
  "dream_cognition_submit",
  "memory_read",
  "memory_related",
  "memory_search",
].sort();
const storyTools = ["dream_story_submit"];
const apiKeyEnv = "QQ_TEST_DREAM_OPENAI_KEY";

async function loopback(t, handler, prepare) {
  const server = http.createServer(async (req, res) => {
    try {
      await handler(req, res);
    } catch {
      res.writeHead(500);
      res.end();
    }
  });
  prepare?.(server);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return "http://127.0.0.1:" + server.address().port;
}
async function json(req) {
  const parts = [];
  for await (const part of req) parts.push(part);
  return JSON.parse(Buffer.concat(parts).toString("utf8"));
}
function sendJson(res, body, code = 200) {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

async function openAIProtocol(t, current) {
  const old = process.env[apiKeyEnv];
  process.env[apiKeyEnv] = "fixture-dream-token";
  t.after(() => {
    if (old === undefined) delete process.env[apiKeyEnv];
    else process.env[apiKeyEnv] = old;
  });
  const base = await loopback(t, async (req, res) => {
    const plan = current();
    assert.equal(req.url, "/v1/chat/completions");
    assert.equal(req.headers.authorization, "Bearer fixture-dream-token");
    const body = await json(req);
    assert.deepEqual(
      body.tools.map((tool) => tool.function.name).sort(),
      plan.tools,
    );
    const reply = (message) => sendJson(res, { choices: [{ message }] });
    if (body.messages.length === 2) {
      assert.deepEqual(
        body.messages.map((message) => message.role),
        ["system", "user"],
      );
      return reply({
        tool_calls: [
          {
            id: "fixture-dream-submit",
            type: "function",
            function: { name: plan.name, arguments: JSON.stringify(plan.args) },
          },
        ],
      });
    }
    assert.deepEqual(
      body.messages.map((message) => message.role),
      ["system", "user", "assistant", "tool"],
    );
    const tool = body.messages.at(-1);
    assert.equal(tool.tool_call_id, "fixture-dream-submit");
    writeFileSync(
      plan.evidence,
      JSON.stringify({
        session: body.messages[1].content.match(/context=(\S+)/)[1],
        acknowledgement: JSON.parse(tool.content),
      }),
    );
    if (plan.fail) return sendJson(res, {}, 500);
    return reply({ content: "synthetic completion" });
  });
  return {
    fetch(url, options) {
      const target = new URL(url);
      assert.equal(target.hostname, "dream-fixture.invalid");
      return fetch(base + target.pathname, options);
    },
  };
}

async function dshProtocol(t, f, current) {
  const token = "fixture-admin-token";
  const app = createServer({ runtime: f.runtime, token });
  const port = await app.listen();
  const mcp = new Client({ name: "dream-dsh-fixture", version: "1" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL("../src/mcp.mjs", import.meta.url))],
    env: {
      QQ_UNIFIED_URL: "http://127.0.0.1:" + port,
      ...relayEnvironment(f.root, token),
    },
  });
  await mcp.connect(transport);
  t.after(async () => {
    await mcp.close();
    await app.close();
  });
  const sessions = new Set();
  const streams = new Map();
  const cancellations = [];
  const failures = [];
  const values = { inbox: { "next-turn": [], "next-step": [] } };
  const base = await loopback(
    t,
    async (req, res) => {
      const request = await json(req);
      const args = request.payload.args.request;
      const reply = (value) =>
        sendJson(res, {
          type: "server-response",
          rpcId: request.rpcId,
          result: { ok: true, value },
        });
      switch (req.url) {
        case "/api/agentPresets/list":
          return reply({ presets: [{ id: "qq-unified" }] });
        case "/api/workspace/create":
          return reply({ workspace: { workspaceId: "fixture-workspace" } });
        case "/api/session/create":
          assert.equal(args.agentPreset, "qq-unified");
          assert.ok(args.sessionId);
          assert.equal(sessions.has(args.sessionId), false);
          sessions.add(args.sessionId);
          return reply({ sessionId: args.sessionId });
        case "/api/session/selectModel":
          assert.equal(args.model, "fixture-model");
          return reply({});
        case "/api/session/projections":
          return reply({ values });
        case "/api/session/cancel":
          cancellations.push(args.sessionId);
          return reply({});
        case "/api/session/prompt": {
          const plan = current();
          const stream = streams.get(args.sessionId);
          const context = args.content[0].text.match(/context=(\S+)/)[1];
          const turn = "fixture-turn";
          reply({ accepted: true });
          stream({
            type: "event",
            event: { type: "turn/start", data: { turn } },
          });
          try {
            const catalogue = await mcp.callTool({
              name: "bridge_tools",
              arguments: { context },
            });
            assert.equal(catalogue.isError, undefined);
            assert.deepEqual(
              JSON.parse(catalogue.content[0].text)
                .tools.map((tool) => tool.name)
                .sort(),
              plan.tools,
            );
            const submitted = await mcp.callTool({
              name: "bridge_call",
              arguments: { context, name: plan.name, arguments: plan.args },
            });
            assert.equal(submitted.isError, undefined);
            writeFileSync(
              plan.evidence,
              JSON.stringify({
                session: args.sessionId,
                acknowledgement: JSON.parse(submitted.content[0].text),
              }),
            );
          } catch (error) {
            failures.push(error);
          } finally {
            stream({
              type: "event",
              event: {
                type: "turn/end",
                data: {
                  turn,
                  reason: {
                    kind: plan.fail || failures.length ? "error" : "completed",
                  },
                },
              },
            });
          }
          return;
        }
        default:
          throw Error("UNEXPECTED_DSH_ENDPOINT: " + req.url);
      }
    },
    (server) => {
      const wss = new WebSocketServer({ server });
      wss.on("connection", (socket) =>
        socket.on("message", (raw) => {
          const frame = JSON.parse(raw);
          if (frame.type === "cancel") {
            socket.send(
              JSON.stringify({ type: "end", streamId: frame.streamId }),
            );
          } else if (
            frame.type === "open" &&
            frame.endpoint === "session/follow"
          ) {
            const { sessionId } = frame.payload.args.request.address;
            const stream = (value) =>
              socket.send(
                JSON.stringify({
                  type: "item",
                  streamId: frame.streamId,
                  value,
                }),
              );
            streams.set(sessionId, stream);
            stream({ type: "snapshot", records: [], projections: { values } });
          }
        }),
      );
      t.after(async () => {
        for (const socket of wss.clients) socket.terminate();
        await new Promise((resolve) => wss.close(resolve));
      });
    },
  );
  return {
    options() {
      const client = new NodeApiClient(base, 4000, {});
      // A synthetic pre-issued cookie avoids local DSH credentials.
      client.cookie = "fixture=authenticated";
      return { client };
    },
    assertSession(session) {
      if (failures.length) throw failures[0];
      assert.ok(
        cancellations.includes(session),
        "DSH session work was drained",
      );
    },
  };
}

function cliOptions(type, root, planPath) {
  if (type === "codex")
    return {
      root,
      rpc: new CodexRpc({
        command: process.execPath,
        args: [cliFixture, type, pathToFileURL(planPath).href],
        cwd: root,
        timeoutMs: 12000,
      }),
    };
  return {
    root,
    spawn(_command, args, options) {
      return spawn(
        process.execPath,
        [cliFixture, type, pathToFileURL(planPath).href, ...args],
        options,
      );
    },
  };
}

for (const type of ["codex", "openai", "antigravity", "dsh"]) {
  test(
    `dreams use the ${type} protocol and commit only completed runs`,
    { timeout: 110000 },
    async (t) => {
      const cfg = config(1);
      const role = cfg.agents[0];
      role.dream.enabled = true;
      role.dream.imaginative.enabled = true;
      role.dream.imaginative.dailyMax = 2;
      role.dream.cognitive.timeoutMs = 18000;
      role.dream.imaginative.timeoutMs = 18000;
      const backend = cfg.backends[0];
      Object.assign(backend, { type, model: "fixture-model" });
      if (type === "openai")
        Object.assign(backend, {
          baseUrl: "https://dream-fixture.invalid/v1",
          apiKeyEnv,
        });
      if (type === "dsh") backend.preset = "qq-unified";
      if (type === "antigravity")
        Object.assign(backend, {
          cliProtocol: "headless",
          cliReuse: { enabled: true },
        });
      const f = fixture(t, { cfg });
      const registry = new BackendRegistry();
      const planPath = path.join(f.root, "dream-plan.json");
      let plan;
      const openAI =
        type === "openai" ? await openAIProtocol(t, () => plan) : null;
      const dsh = type === "dsh" ? await dshProtocol(t, f, () => plan) : null;
      f.runtime.backendFactory = (backend, agent) =>
        registry.create(backend, agent, {
          root: f.root,
          ...(dsh
            ? dsh.options()
            : openAI || cliOptions(type, f.root, planPath)),
        });
      const record = f.store.bind(agentId);
      const db = f.store.db;
      const sessions = new Set();
      for (const mode of ["nap", "imaginative"]) {
        const imaginative = mode === "imaginative";
        for (const fail of [true, false]) {
          const marker = mode + "-" + (fail ? "failed" : "success");
          const source = record.append({
            dedupe: marker,
            kind: "message.received",
            direction: "in",
            conversation: "group:20000",
            body: "合成梦境来源",
          });
          const before = checkpoint(db, agentId);
          plan = {
            tools: imaginative ? storyTools : cognitiveTools,
            name: imaginative ? "dream_story_submit" : "dream_cognition_submit",
            args: imaginative
              ? {
                  schemaVersion: 1,
                  title: "雾里的站台",
                  narrative: "梦见火车从云端出发。",
                  reflection: "醒来还记得风声。",
                  themes: ["旅行"],
                  inspirations: [],
                }
              : {
                  schemaVersion: 1,
                  operations: [
                    {
                      op: "ADD",
                      category: "fact",
                      scopeId: "group:20000",
                      subjectKey: "fixture:protocol",
                      content: "这是独立协议夹具。",
                      epistemicStatus: "reported",
                      evidenceIds: [source.id],
                      importance: 0.5,
                      confidence: 0.5,
                      reason: "合成来源",
                    },
                  ],
                  awakeningSummary: "",
                  noChangesReason: null,
                },
            fail,
            evidence: path.join(f.root, marker + ".json"),
          };
          writeFileSync(planPath, JSON.stringify(plan));
          const result = await f.runtime.dreams.run(agentId, { mode });
          const row = db
            .prepare("SELECT * FROM dream_runs WHERE run_id=?")
            .get(result.runId);
          assert.equal(
            row.status,
            fail ? "FAILED" : "COMMITTED",
            row.error_code,
          );
          assert.equal(row.mode, mode);
          assert.equal(row.backend_id, backend.id);
          assert.equal(row.model, backend.model);
          assert.equal(record.state("@dream").session, undefined);
          const evidence = JSON.parse(readFileSync(plan.evidence, "utf8"));
          assert.equal(sessions.has(evidence.session), false);
          sessions.add(evidence.session);
          dsh?.assertSession(evidence.session);
          assert.equal(evidence.acknowledgement.status, "accepted");
          if (fail || imaginative)
            assert.deepEqual(checkpoint(db, agentId), before);
          else assert.equal(checkpoint(db, agentId).starts.events, source.seq);
          const table = imaginative ? "imaginative_dreams" : "cognitions";
          assert.equal(
            db
              .prepare(
                `SELECT count(*) AS count FROM ${table} WHERE agent_id=?`,
              )
              .get(agentId).count,
            fail ? 0 : 1,
          );
        }
      }
    },
  );
}
