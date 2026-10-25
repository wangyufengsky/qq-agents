// Opt-in real-model acceptance. All QQ writes terminate at loopback fixture gateways.
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import os from "node:os";
import { randomBytes } from "node:crypto";
import { WebSocketServer } from "ws";
import { ConfigStore, validateConfig } from "../src/core/config.mjs";
import { MemoryStore } from "../src/memory/store.mjs";
import { Runtime } from "../src/core/runtime.mjs";
import { BackendRegistry } from "../src/backends/index.mjs";
import { createServer } from "../src/server.mjs";
import { MediaStore } from "../src/tools/media.mjs";
import { VoiceStore } from "../src/tools/voice.mjs";
import { TOOL_NAMES } from "../src/tools/index.mjs";
import { wav } from "../test/audio-fixture.mjs";

if (!process.argv.includes("--allow-real-models"))
  throw Error("EXPLICIT_REAL_MODEL_OPT_IN_REQUIRED");
if (
  !process.env.DSH_HOME ||
  path.resolve(process.env.DSH_HOME) === path.join(os.homedir(), ".dsh")
)
  throw Error("INDEPENDENT_DSH_HOME_REQUIRED");
const args = process.argv.slice(2),
  opt = (k) => args[args.indexOf(k) + 1];
const root = path.resolve(
  args.includes("--data") ? opt("--data") : "work/live-acceptance/bridge",
);
fs.mkdirSync(root, { recursive: true, mode: 0o700 });
const configFile = path.join(root, "config.json");
if (fs.existsSync(configFile)) {
  const existing = JSON.parse(fs.readFileSync(configFile, "utf8"));
  if (
    JSON.stringify(existing.agents?.map((a) => a.id)) !==
    JSON.stringify(["acceptance-dsh", "acceptance-codex"])
  )
    throw Error("NOT_AN_ACCEPTANCE_DATA_DIRECTORY");
}
const lock = path.join(root, "process.lock");
const lockFd = fs.openSync(lock, "wx", 0o600);
fs.writeFileSync(lockFd, String(process.pid));
fs.closeSync(lockFd);
process.on("exit", () => fs.rmSync(lock, { force: true }));
const tokenFile = path.join(root, "admin-token");
if (!fs.existsSync(tokenFile))
  fs.writeFileSync(tokenFile, randomBytes(32).toString("hex"), { mode: 0o600 });
const token = fs.readFileSync(tokenFile, "utf8").trim();
const inputs = args.includes("--inputs")
  ? JSON.parse(fs.readFileSync(opt("--inputs"), "utf8"))
  : null;
const ids = ["acceptance-dsh", "acceptance-codex"],
  gateways = new Map(),
  calls = [],
  results = [];
let eventId = Date.now(),
  messageId = 80000,
  busy = false,
  current = null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, timeout = 180000) {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > timeout) throw Error("ACCEPTANCE_TIMEOUT");
    await sleep(50);
  }
}
function record() {
  fs.writeFileSync(
    path.join(root, "acceptance-results.json"),
    JSON.stringify(
      { updatedAt: new Date().toISOString(), current, busy, results, calls },
      null,
      2,
    ),
    { mode: 0o600 },
  );
}
for (let i = 0; i < ids.length; i++) {
  const id = ids[i],
    port = 3214 + i,
    sent = [],
    actions = [],
    resources = new Map();
  resources.set("acceptance-root", {
    messages: [
      {
        sender: { user_id: 30000, nickname: "验收甲" },
        message: [
          { type: "text", data: { text: "外层暗号：蓝鲸" } },
          { type: "forward", data: { id: "acceptance-child" } },
        ],
      },
    ],
  });
  resources.set("acceptance-child", {
    messages: [
      {
        sender: { user_id: 30001, nickname: "验收乙" },
        message: [{ type: "text", data: { text: "内层暗号：松林" } }],
      },
    ],
  });
  for (const [key, value] of Object.entries(inputs?.forwardResources || {}))
    resources.set(key, value);
  const server = http.createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    if (body.length > 30 * 1024 * 1024) {
      res.writeHead(413);
      res.end();
      return;
    }
    const p = JSON.parse(body || "{}"),
      action = req.url.slice(1);
    actions.push({ action, at: Date.now() });
    let data;
    if (action === "get_login_info") data = { user_id: 10000 + i };
    else if (action === "get_status") data = { online: true, good: true };
    else if (action === "get_forward_msg")
      data = resources.get(p.message_id || p.id) || { messages: [] };
    else if (
      action === "get_record" &&
      inputs?.record &&
      p.file ===
        inputs.voiceSegments?.find((s) => s.type === "record")?.data.file
    )
      data = inputs.record;
    else if (action === "get_group_member_info") data = { user_id: p.user_id };
    else if (
      [
        "send_group_msg",
        "send_private_msg",
        "send_group_forward_msg",
        "send_private_forward_msg",
      ].includes(action)
    ) {
      data = { message_id: ++messageId };
      sent.push({ action, ...p, messageId: String(messageId), at: Date.now() });
    } else {
      res.end(JSON.stringify({ status: "failed", retcode: 100, data: null }));
      return;
    }
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ status: "ok", retcode: 0, data }));
  });
  const ws = new WebSocketServer({ server });
  await new Promise((r) => server.listen(port, "127.0.0.1", r));
  gateways.set(id, { server, ws, sent, actions, resources });
}
const cfg = validateConfig({
  version: 1,
  mode: "live",
  globalPaused: true,
  port: 3212,
  connections: ids.map((id, i) => ({
    id,
    label: "本机验收网关 " + id,
    accountId: String(10000 + i),
    enabled: true,
    httpUrl: `http://127.0.0.1:${3214 + i}`,
    wsUrl: `ws://127.0.0.1:${3214 + i}`,
  })),
  backends: [
    {
      id: "dsh",
      type: "dsh",
      label: "独立 DSH profile",
      baseUrl: "http://127.0.0.1:3213",
      preset: "qq-unified",
      provider: "deepseek-account",
      model: "deepseek-flash",
      effort: "high",
    },
    {
      id: "codex",
      type: "codex",
      label: "独立 Codex home",
      model: "gpt-6-astra",
      effort: "high",
    },
  ],
  agents: ids.map((id, i) => ({
    id,
    name: i ? "Codex 验收角色" : "DSH 验收角色",
    connectionId: id,
    backendId: i ? "codex" : "dsh",
    paused: true,
    ownerIds: ["30000"],
    allow: { groups: ["20000"], users: ["30000"] },
    tools: TOOL_NAMES,
    persona:
      "你是独立测试环境的验收角色。当前 QQ 网关只保存本机测试回执。按当前唤醒原因中的验收说明调用工具；不要声称未经工具确认的结果。不要主动继续上一条测试。收到 sleep/proactive 原因时只发送对应的 ACCEPTANCE_SLEEP / ACCEPTANCE_PROACTIVE 标记并结束。",
    wake: { participation: 1, cooldownMs: 0 },
    behavior: {
      preSleepWaitMs: 2000,
      quietAfterNewMs: 0,
      turnTimeoutMs: 180000,
      maxSendPerMinute: 30,
      maxSendPerHour: 300,
      maxWakePerMinute: 30,
      maxWakePerHour: 300,
      replyCheckMs: 3600000,
    },
    scheduler: { enabled: true, jitterMin: 0, quietEnabled: false },
  })),
});
const configStore = new ConfigStore(path.join(root, "config.json"), cfg);
configStore.save(cfg, configStore.revision);
const memory = new MemoryStore(path.join(root, "memory.sqlite")),
  registry = new BackendRegistry();
const runtime = new Runtime({
  configStore,
  memory,
  backendFactory: (c, a) => {
    const b = registry.create(c, a, { root });
    const run = b.run.bind(b);
    b.run = async (...args) => {
      try {
        return await run(...args);
      } catch (e) {
        console.log(
          JSON.stringify({
            event: "backend-failure",
            backend: a.id,
            error: e.message
              .replace(/context=[\w-]+/g, "context=[redacted]")
              .slice(0, 300),
          }),
        );
        throw e;
      }
    };
    if (c.type === "codex")
      b.rpc.on("notification", (m) => {
        if (m.method === "turn/completed")
          console.log(
            JSON.stringify({
              backend: a.id,
              status: m.params.turn.status,
              error: m.params.turn.error?.message?.slice(0, 200),
            }),
          );
      });
    return b;
  },
});
runtime.media = new MediaStore(path.join(root, "media"));
runtime.voices = new VoiceStore(path.join(root, "voices"));
const call = runtime.callTool.bind(runtime);
runtime.callTool = async (ctx, name, params) => {
  const entry = {
    agentId: ctx.agentId,
    name,
    at: Date.now(),
    status: "running",
  };
  calls.push(entry);
  record();
  try {
    const result = await call(ctx, name, params);
    if (name === "qq_forward_read")
      entry.forward = {
        complete: result.complete,
        maxDepth: Math.max(0, ...result.items.map((x) => x.depth || 0)),
        total: result.total,
      };
    entry.status = "ok";
    return result;
  } catch (e) {
    entry.status = "error";
    entry.error = e.message;
    throw e;
  } finally {
    record();
  }
};
const app = createServer({ runtime, token, allowLive: true });
await app.listen(3212);
for (const id of ids) await runtime.startConnection(id);
runtime.startTimers();
for (const id of ids)
  await runtime.voices.put(id, wav(1), runtime.agent(id).voice, {
    title: "验收合成音",
  });
async function reset(id) {
  await runtime.cancel(id);
  await until(
    () => ![...runtime.running.keys()].some((k) => k.startsWith(id + "|")),
    10000,
  );
  const mem = memory.bind(id);
  mem.setState("private:30000", {
    readThroughSeq: memory.db
      .prepare(
        "SELECT coalesce(max(seq),0) AS seq FROM events WHERE agent_id=?",
      )
      .get(id).seq,
  });
  runtime.agent(id).behavior.proactive.enabled = false;
  const scheduler = runtime.scheduler.state(id);
  scheduler.tasks.forEach((t) => (t.enabled = false));
  runtime.scheduler.save(id, scheduler);
  await runtime.pause("all", false);
  await runtime.pause(id, false);
}
async function turn(id, instruction, { segments = [], useWire = false } = {}) {
  const connection = runtime.connection(id),
    raw = {
      post_type: "message",
      self_id: Number(connection.accountId),
      message_type: "private",
      user_id: 30000,
      message_id: ++eventId,
      time: Math.floor(Date.now() / 1000),
      message: [{ type: "text", data: { text: instruction } }, ...segments],
      sender: { nickname: "本机验收员" },
    };
  if (useWire) {
    gateways.get(id).ws.clients.forEach((s) => s.send(JSON.stringify(raw)));
    await until(
      () => memory.bind(id).state("private:30000").lastReceivedSeq,
      5000,
    );
  } else {
    const a = runtime.agent(id),
      old = a.wake.private;
    a.wake.private = false;
    const participation = a.wake.participation;
    a.wake.participation = 0;
    await runtime.ingest(id, raw);
    a.wake.private = old;
    a.wake.participation = participation;
    await runtime.wake(id, "private:30000", {
      reasons: [{ reason: "acceptance", instruction }],
    });
  }
  await until(() => !runtime.running.has(id + "|private:30000"));
  await Promise.allSettled([...runtime.jobs]);
}
function requireResult(ok, code) {
  if (!ok) throw Error(code);
}
async function runCase(id, test) {
  if (!ids.includes(id)) throw Error("UNKNOWN_FIXTURE_AGENT");
  if (busy) throw Error("ACCEPTANCE_BUSY");
  busy = true;
  current = { agentId: id, test, startedAt: Date.now() };
  record();
  console.log(JSON.stringify({ event: "case-start", ...current }));
  const started = Date.now(),
    gateway = gateways.get(id),
    before = gateway.sent.length,
    beforeCalls = calls.length;
  try {
    await reset(id);
    if (test.startsWith("received-") && inputs) {
      Object.assign(
        inputs,
        JSON.parse(fs.readFileSync(opt("--inputs"), "utf8")),
      );
      for (const [key, value] of Object.entries(inputs.forwardResources || {}))
        gateway.resources.set(key, value);
    }
    if (test === "smoke") {
      await turn(
        id,
        "独立验收：请只调用 qq_send 发送 ACCEPTANCE_HELLO，然后结束。",
        { useWire: true },
      );
      requireResult(
        gateway.sent
          .slice(before)
          .some((m) => JSON.stringify(m.message).includes("ACCEPTANCE_HELLO")),
        "NO_CONFIRMED_HELLO",
      );
    } else if (test === "voice") {
      await turn(
        id,
        "独立语音验收：先调用 qq_list_voices 找到验收合成音，再 qq_voice_read 读取，不要虚构音频含义；用 qq_send_voice 将同一 audioId 以 volume=1.3 发送到当前会话，然后结束。",
      );
      const item = gateway.sent
        .slice(before)
        .flatMap((m) => m.message || [])
        .find((s) => s.type === "record");
      requireResult(item?.data.file?.startsWith("base64://"), "NO_VOICE_BYTES");
      const media = await runtime.voices.put(
        id,
        Buffer.from(item.data.file.slice(9), "base64"),
        runtime.agent(id).voice,
        { title: "验收投递音频回读" },
      );
      requireResult(media.duration > 0, "INVALID_DELIVERED_AUDIO");
      requireResult(
        calls
          .slice(beforeCalls)
          .some((c) => c.name === "qq_voice_read" && c.status === "ok"),
        "VOICE_READ_NOT_CALLED",
      );
    } else if (test === "received-voice") {
      requireResult(
        inputs?.voiceSegments && inputs?.record,
        "MANUAL_VOICE_INPUT_REQUIRED",
      );
      await turn(
        id,
        "真实 QQ 来信语音验收：读取本条消息的语音附件，用 qq_voice_read 的 eventId 模式。不要虚构转录。然后用 qq_send_voice 把该 audioId 以 volume=1.3 发送到当前会话。",
        { segments: inputs.voiceSegments },
      );
      const item = gateway.sent
        .slice(before)
        .flatMap((m) => m.message || [])
        .find((s) => s.type === "record");
      requireResult(item, "NO_VOICE_BYTES");
      const media = await runtime.voices.put(
        id,
        Buffer.from(item.data.file.slice(9), "base64"),
        runtime.agent(id).voice,
        { title: "真实 QQ 语音验收回读" },
      );
      requireResult(media.duration > 0, "INVALID_DELIVERED_AUDIO");
    } else if (test === "forward" || test === "received-forward") {
      if (test === "received-forward")
        requireResult(inputs?.forwardDepth >= 1, "NESTED_INPUT_REQUIRED");
      await turn(
        id,
        "独立转发验收：读取最近这条经历里的合并转发，使用 qq_forward_read 和 maxDepth=3 完整展开内层。用 qq_send 报告外层和内层暗号，再用 qq_forward_send 转发这条已观察经历，随后结束。",
        {
          segments:
            test === "received-forward"
              ? inputs?.forwardSegments
              : [{ type: "forward", data: { id: "acceptance-root" } }],
        },
      );
      const sent = gateway.sent.slice(before);
      requireResult(
        sent.some((m) => /send_.*_forward_msg/.test(m.action)),
        "NO_FORWARD_SEND",
      );
      const text = JSON.stringify(
        sent.filter((m) => m.message).map((m) => m.message),
      );
      requireResult(
        text.includes("蓝鲸") && text.includes("松林"),
        "NESTED_CONTENT_MISSING",
      );
      requireResult(
        calls
          .slice(beforeCalls)
          .some((c) => c.forward?.complete && c.forward.maxDepth >= 1),
        "NESTED_EXPANSION_UNCONFIRMED",
      );
    } else if (test === "wait-sleep") {
      await turn(
        id,
        "独立等待验收：调用 qq_wait_for_messages 等待 timeoutMs=2000、quietMs=0；完成后调用 qq_set_wake_config 设置 sleepMs=1500 的有限睡眠，然后结束当前回合。下次睡眠到期唤醒只发送 ACCEPTANCE_SLEEP，然后结束。",
      );
      await until(
        () =>
          gateway.sent
            .slice(before)
            .some((m) =>
              JSON.stringify(m.message).includes("ACCEPTANCE_SLEEP"),
            ),
        180000,
      );
      requireResult(
        calls
          .slice(beforeCalls)
          .some((c) => c.name === "qq_wait_for_messages" && c.status === "ok"),
        "WAIT_NOT_COMPLETED",
      );
    } else if (test === "proactive") {
      const a = runtime.agent(id);
      Object.assign(a.behavior.proactive, {
        enabled: true,
        probability: 1,
        nightFactor: 1,
        idleMs: 0,
        minMs: 86400000,
        maxMs: 86400000,
      });
      memory.bind(id).setState("private:30000", {
        lastIncomingAt: Date.now() - 60000,
        nextProactiveAt: Date.now() + 1000,
      });
      await until(
        () =>
          gateway.sent
            .slice(before)
            .some((m) =>
              JSON.stringify(m.message).includes("ACCEPTANCE_PROACTIVE"),
            ),
        180000,
      );
      a.behavior.proactive.enabled = false;
    } else if (test === "schedule-crud") {
      await turn(
        id,
        "定时管理验收：依次使用 qq_schedule_create、qq_schedule_list、qq_schedule_update、qq_schedule_delete。创建一条名为 ACCEPTANCE_CRUD 的 text 任务，text=验收，每天 UTC 23:59 执行（按工具定义填写 schedule），timezone=UTC，enabled=false，目标仅当前私聊；列出确认，改名为 ACCEPTANCE_CRUD_EDITED，再删除该任务。只操作刚创建的任务，完成即结束。",
      );
      for (const name of [
        "qq_schedule_create",
        "qq_schedule_list",
        "qq_schedule_update",
        "qq_schedule_delete",
      ])
        requireResult(
          calls
            .slice(beforeCalls)
            .some((c) => c.name === name && c.status === "ok"),
          "SCHEDULE_CRUD_INCOMPLETE",
        );
      requireResult(
        !runtime.scheduler
          .state(id)
          .tasks.some((t) => t.name.startsWith("ACCEPTANCE_CRUD")),
        "SCHEDULE_CRUD_NOT_DELETED",
      );
    } else if (test === "scheduler") {
      const at = new Date(Math.ceil((Date.now() + 1000) / 60000) * 60000),
        date = at.toISOString().slice(0, 10),
        time = at.toISOString().slice(11, 16);
      const task = runtime.scheduler.create(id, {
        name: "真实后端定时验收",
        kind: "ai",
        instruction: "只通过 qq_send 发送 ACCEPTANCE_SCHEDULE，然后结束。",
        targets: ["private:30000"],
        schedule: { type: "once", date, time },
        timezone: "UTC",
        jitterMin: 0,
      });
      await until(
        () =>
          runtime.scheduler
            .state(id)
            .history.some(
              (r) =>
                r.taskId === task.id &&
                ["sent", "failed", "unknown", "completed-no-send"].includes(
                  r.status,
                ),
            ),
        240000,
      );
      const history = runtime.scheduler
        .state(id)
        .history.filter((r) => r.taskId === task.id);
      requireResult(history[0]?.status === "sent", "SCHEDULE_NOT_SENT");
      runtime.tick();
      await sleep(1100);
      requireResult(
        gateway.sent
          .slice(before)
          .filter((m) =>
            JSON.stringify(m.message).includes("ACCEPTANCE_SCHEDULE"),
          ).length === 1,
        "SCHEDULE_DUPLICATED",
      );
    } else if (test === "cancel") {
      const pending = turn(
        id,
        "独立取消验收：先 qq_wait_for_messages 等待 timeoutMs=20000、quietMs=0。完成后才 qq_send 发送 CANCEL_SHOULD_NOT_SEND。",
      );
      await until(
        () =>
          calls
            .slice(beforeCalls)
            .some(
              (c) =>
                c.name === "qq_wait_for_messages" && c.status === "running",
            ),
        120000,
      );
      await runtime.pause(id, true);
      await pending;
      requireResult(gateway.sent.length === before, "CANCEL_LATE_SEND");
    } else throw Error("UNKNOWN_ACCEPTANCE_CASE");
    await until(() => !runtime.running.has(id + "|private:30000"));
    results.push({
      agentId: id,
      test,
      status: "passed",
      elapsedMs: Date.now() - started,
      sends: gateway.sent.length - before,
      tools: calls
        .slice(beforeCalls)
        .map((c) => ({ name: c.name, status: c.status, error: c.error })),
    });
  } catch (e) {
    results.push({
      agentId: id,
      test,
      status: "failed",
      error: e.message,
      elapsedMs: Date.now() - started,
      tools: calls
        .slice(beforeCalls)
        .map((c) => ({ name: c.name, status: c.status, error: c.error })),
    });
  } finally {
    await runtime.pause(id, true);
    await runtime.pause("all", true);
    busy = false;
    current = null;
    record();
    console.log(JSON.stringify({ event: "case-end", ...results.at(-1) }));
  }
  return results.at(-1);
}
const control = http.createServer(async (req, res) => {
  res.setHeader("content-type", "application/json");
  if (req.headers["x-admin-token"] !== token) {
    res.writeHead(401);
    res.end("{}");
    return;
  }
  try {
    if (req.method === "GET") {
      res.end(JSON.stringify({ busy, current, results, calls }));
      return;
    }
    let body = "";
    for await (const c of req) {
      body += c;
      if (body.length > 10000) throw Error("BODY_TOO_LARGE");
    }
    const data = JSON.parse(body);
    if (req.url === "/case") {
      if (!ids.includes(data.agentId)) throw Error("UNKNOWN_FIXTURE_AGENT");
      if (busy) throw Error("ACCEPTANCE_BUSY");
      void runCase(data.agentId, data.test);
      res.end(JSON.stringify({ accepted: true }));
      return;
    }
    throw Error("UNKNOWN_CONTROL");
  } catch (e) {
    res.writeHead(400);
    res.end(JSON.stringify({ error: e.message }));
  }
});
await new Promise((r) => control.listen(3216, "127.0.0.1", r));
console.log(
  JSON.stringify({
    event: "ready",
    consolePort: 3212,
    controlPort: 3216,
    qqDelivery: "loopback-only",
    data: root,
  }),
);
async function close(code = 0) {
  await runtime.pause("all", true);
  await runtime.close();
  await app.close();
  for (const g of gateways.values()) {
    g.ws.clients.forEach((c) => c.terminate());
    g.ws.close();
    g.server.close();
  }
  control.close();
  memory.close();
  process.exit(code);
}
process.on("SIGTERM", () => void close());
process.on("SIGINT", () => void close());
if (args.includes("--run-all")) {
  const selected = args.includes("--agent") ? [opt("--agent")] : ids;
  const cases = args.includes("--case")
    ? opt("--case").split(",")
    : [
        "smoke",
        "voice",
        "forward",
        "wait-sleep",
        "proactive",
        "schedule-crud",
        "scheduler",
        "cancel",
        ...(inputs?.voiceSegments ? ["received-voice"] : []),
        ...(inputs?.forwardSegments ? ["received-forward"] : []),
      ];
  try {
    for (const id of selected)
      for (const test of cases) await runCase(id, test);
    await close(results.some((r) => r.status !== "passed") ? 1 : 0);
  } catch {
    await close(1);
  }
}
