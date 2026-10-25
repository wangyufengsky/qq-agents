import { appSharingAcceptance } from "./fixtures/app-sharing.mjs";
// Opt-in real-model acceptance. All QQ writes terminate at loopback fixture gateways.
import fs from "node:fs";
import { automaticContinuityAcceptance } from "./fixtures/automatic-continuity.mjs";
import {
  selfContextAcceptance,
  subjectCostAcceptance,
  intentReceiptAcceptance,
} from "./fixtures/self-context.mjs";
import {
  seedQuality,
  qualityPrompt,
  judgeQuality,
} from "./fixtures/memory-quality.mjs";
import path from "node:path";
import http from "node:http";
import os from "node:os";
import { randomBytes, createHash } from "node:crypto";
import { WebSocketServer } from "ws";
import { ConfigStore, validateConfig } from "../src/core/config.mjs";
import { MemoryStore } from "../src/memory/store.mjs";
import { Runtime } from "../src/core/runtime.mjs";
import { BackendRegistry } from "../src/backends/index.mjs";
import { createServer } from "../src/server.mjs";
import { MediaStore } from "../src/tools/media.mjs";
import { VoiceStore } from "../src/tools/voice.mjs";
import { FileStore } from "../src/tools/files.mjs";
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
const portBase = args.includes("--port-base")
  ? Number(opt("--port-base"))
  : 3212;
if (!Number.isInteger(portBase) || portBase < 1024 || portBase > 60000)
  throw Error("INVALID_ACCEPTANCE_PORT_BASE");
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
    port = portBase + 2 + i,
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
    else if (["upload_private_file", "upload_group_file"].includes(action)) {
      if (!p.file?.startsWith("base64://"))
        throw Error("FIXTURE_EXPECTED_FILE_BYTES");
      const bytes = Buffer.from(p.file.slice(9), "base64");
      data = { file_id: "fixture-file-" + ++messageId };
      sent.push({
        action,
        name: p.name,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        bytes: bytes.length,
        userId: p.user_id,
        groupId: p.group_id,
        at: Date.now(),
      });
    } else if (
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
  port: portBase,
  connections: ids.map((id, i) => ({
    id,
    label: "本机验收网关 " + id,
    accountId: String(10000 + i),
    enabled: true,
    httpUrl: `http://127.0.0.1:${portBase + 2 + i}`,
    wsUrl: `ws://127.0.0.1:${portBase + 2 + i}`,
  })),
  backends: [
    {
      id: "dsh",
      type: "dsh",
      label: "独立 DSH profile",
      baseUrl: `http://127.0.0.1:${portBase + 1}`,
      preset: "qq-unified",
      provider: "deepseek-account",
      model: "deepseek-flash",
      effort: "high",
      ...(args.includes("--tool-config")
        ? {
            toolServers: JSON.parse(
              fs.readFileSync(opt("--tool-config"), "utf8"),
            ),
          }
        : {}),
    },
    {
      id: "codex",
      type: "codex",
      label: "独立 Codex home",
      model: "gpt-6-astra",
      effort: "high",
      ...(args.includes("--tool-config")
        ? {
            toolServers: JSON.parse(
              fs.readFileSync(opt("--tool-config"), "utf8"),
            ),
          }
        : {}),
    },
  ],
  agents: ids.map((id, i) => ({
    id,
    name: i ? "Codex 验收角色" : "DSH 验收角色",
    appearance: "合成验收角色，无固定外形",
    connectionId: id,
    backendId: i ? "codex" : "dsh",
    paused: true,
    ownerIds: ["30000"],
    allow: { groups: ["20000"], users: ["30000"] },
    tools: TOOL_NAMES,
    voice: { tts: { enabled: true, voice: "Tingting" } },
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
runtime.files = new FileStore(path.join(root, "files"));
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
    if (["file_download", "file_create"].includes(name))
      entry.fileId = result.fileId;
    if (name === "voice_synthesize")
      entry.generatedAudio = {
        id: result.id,
        duration: result.duration,
        mimeType: result.mimeType,
      };
    if (name === "external_tool")
      entry.generatedMedia = (result.content || [])
        .filter((c) => c.type === "text")
        .flatMap((c) => {
          try {
            const x = JSON.parse(c.text);
            return x.generatedMedia ? [x.generatedMedia] : [];
          } catch {
            return [];
          }
        });
    if (name === "qq_cross_group_query") entry.activity = result;
    if (name === "qq_forward_read")
      entry.forward = {
        complete: result.complete,
        maxDepth: Math.max(0, ...result.items.map((x) => x.depth || 0)),
        total: result.total,
      };
    if (
      name === "memory_search" &&
      params.person === "30000" &&
      params.conversation === "group:20000"
    )
      entry.sceneSearch = {
        personFiltered: true,
        groupScoped: true,
        contextualMatch: result.items.some(
          (item) =>
            item.scene?.participants.length === 3 &&
            item.scene.messages.some((m) =>
              m.replyTo.some((r) => r.status === "observed"),
            ),
        ),
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
await app.listen(portBase);
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
  runtime.agent(id).subject.enabled = false;
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
    if (test === "automatic-continuity") {
      await automaticContinuityAcceptance({
        runtime,
        memory,
        id,
        turn,
        gateway,
        calls,
        root,
      });
    } else if (test === "app-sharing") {
      await appSharingAcceptance({ runtime, memory, id, gateway, calls, root });
    } else if (test === "intent-receipt") {
      await intentReceiptAcceptance({ runtime, memory, id, gateway, root });
    } else if (test === "subject-cost") {
      await subjectCostAcceptance({ runtime, memory, id, gateway, root });
    } else if (test === "self-context") {
      await selfContextAcceptance({
        runtime,
        memory,
        id,
        turn,
        gateway,
        calls,
        root,
      });
    } else if (test === "files") {
      await runtime.changeFilePermissions(
        id,
        { enabled: true },
        configStore.revision,
      );
      const publicFile =
        "https://raw.githubusercontent.com/github/gitignore/main/Node.gitignore";
      await turn(
        id,
        `文件验收：依次用 file_list 查看文件库；用 file_download 下载公开链接 ${publicFile}，name=公开样本.txt；再用 file_download 下载本条消息附带的 QQ 文件（先从 conversation_read 找到本条经历的记录 UUID 作为 eventId，不能使用 QQ messageId）；然后用 file_create 生成 验收说明.txt，正文必须是 FILE_ACCEPTANCE_OK。用 qq_send_file 将公开样本.txt 和 验收说明.txt 各发送一次到当前私聊，两次 requestId 不同。不要用 qq_send 发送文字替代附件。开启的普通文件权限不需额外确认。完成后结束。`,
        {
          segments: [
            {
              type: "file",
              data: {
                file_id: "synthetic-file",
                name: "QQ样本.txt",
                url: publicFile,
              },
            },
          ],
        },
      );
      const recent = calls.slice(beforeCalls),
        delivered = gateway.sent
          .slice(before)
          .filter((m) => m.action === "upload_private_file");
      for (const tool of [
        "file_list",
        "file_download",
        "file_create",
        "qq_send_file",
      ])
        requireResult(
          recent.some((c) => c.name === tool && c.status === "ok"),
          "FILE_TOOL_MISSING_" + tool,
        );
      requireResult(
        recent.filter((c) => c.name === "file_download" && c.status === "ok")
          .length >= 2,
        "FILE_DOWNLOAD_SOURCES_MISSING",
      );
      requireResult(delivered.length === 2, "FILE_SEND_COUNT");
      requireResult(
        delivered.every(
          (m) =>
            m.userId === "30000" &&
            !m.groupId &&
            runtime.files.read(id, m.sha256, 20971520).buffer.length ===
              m.bytes,
        ),
        "FILE_DELIVERY_BYTES_MISMATCH",
      );
      requireResult(
        delivered.some(
          (m) =>
            runtime.files.read(id, m.sha256, 20971520).buffer.toString() ===
            "FILE_ACCEPTANCE_OK",
        ),
        "FILE_GENERATED_CONTENT_MISMATCH",
      );
      requireResult(
        runtime.files
          .list(id)
          .items.some(
            (m) =>
              m.sources.some((s) => s.kind === "qq-attachment") &&
              m.sources.some((s) => s.kind === "web"),
          ),
        "FILE_PROVENANCE_MISSING",
      );
      requireResult(
        runtime.status().disclosureRequests.length === 0 &&
          runtime.operations.pending.size === 0,
        "FILE_UNEXPECTED_CONFIRMATION",
      );
    } else if (test === "smoke") {
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
    } else if (test === "memory-quality") {
      const f = seedQuality(memory.bind(id), id, "复杂蓝鲸" + started);
      await turn(id, qualityPrompt(f));
      const sent = gateway.sent.slice(before);
      requireResult(sent.length === 1, "QUALITY_SEND_COUNT");
      const text = sent[0].message
        .filter((s) => s.type === "text")
        .map((s) => s.data.text)
        .join("");
      fs.writeFileSync(
        path.join(root, `quality-${id}.json`),
        JSON.stringify({ fixture: f, answer: text }, null, 2),
        { mode: 0o600 },
      );
      const quality = judgeQuality(f, text);
      fs.writeFileSync(
        path.join(root, `quality-${id}-review.json`),
        JSON.stringify(quality, null, 2),
        { mode: 0o600 },
      );
      for (const tool of [
        "memory_search",
        "memory_related",
        "memory_read",
        "qq_send",
      ])
        requireResult(
          calls
            .slice(beforeCalls)
            .some((c) => c.name === tool && c.status === "ok"),
          "QUALITY_TOOL_MISSING_" + tool,
        );
    } else if (test === "external-search") {
      await turn(
        id,
        "外部工具验收：先用 external_tools 查看 exa 的真实schema，再调用它的 web_search_exa，搜索公开网络用语“鸽了”的含义，最多2个结果，objective只写查公开词义。不要发送任何聊天内容给服务。然后只发一条含 ACCEPTANCE_EXTERNAL_SEARCH 的 qq_send，简述实际结果并附来源链接，未经查询不可编造。",
      );
      requireResult(
        calls
          .slice(beforeCalls)
          .some((c) => c.name === "external_tools" && c.status === "ok") &&
          calls
            .slice(beforeCalls)
            .some((c) => c.name === "external_tool" && c.status === "ok"),
        "EXTERNAL_NOT_CALLED",
      );
      requireResult(
        gateway.sent
          .slice(before)
          .some((m) =>
            JSON.stringify(m.message).includes("ACCEPTANCE_EXTERNAL_SEARCH"),
          ),
        "EXTERNAL_NOT_SENT",
      );
    } else if (test === "external-image") {
      await turn(
        id,
        "图片验收：先 external_tools 查看 artifact 的真实工具schema，然后读取它返回的真实图像产物，用返回的 generatedMedia.id 调用 qq_send 发送图片一次。它只是已经生成的图片读取服务，不能声称本回合新生成了一张。不要用其他旧图片。",
      );
      requireResult(
        calls
          .slice(beforeCalls)
          .some((c) => c.name === "external_tool" && c.status === "ok"),
        "IMAGE_TOOL_NOT_CALLED",
      );
      const mediaIds = new Set(
        calls
          .slice(beforeCalls)
          .flatMap((c) => (c.generatedMedia || []).map((m) => m.id)),
      );
      const imageSegments = gateway.sent
        .slice(before)
        .flatMap((m) => m.message || [])
        .filter((s) => s.type === "image");
      requireResult(
        imageSegments.length === 1 &&
          imageSegments.every(
            (s) =>
              s.data.file?.startsWith("base64://") &&
              mediaIds.has(
                createHash("sha256")
                  .update(Buffer.from(s.data.file.slice(9), "base64"))
                  .digest("hex"),
              ),
          ),
        "IMAGE_BYTES_NOT_FROM_TOOL",
      );
    } else if (test === "tts") {
      await turn(
        id,
        "本地语音生成验收：用 voice_synthesize 将“蓝鲸计划，明天下午三点见。”生成语音，用返回的audioId调用 qq_send_voice 发送一次。不要用旧语音，不要声称做了ASR。",
      );
      requireResult(
        calls
          .slice(beforeCalls)
          .some(
            (c) =>
              c.name === "voice_synthesize" &&
              c.status === "ok" &&
              c.generatedAudio?.duration > 0 &&
              c.generatedAudio?.mimeType === "audio/wav",
          ),
        "TTS_NOT_GENERATED",
      );
      requireResult(
        gateway.sent
          .slice(before)
          .some((m) => m.message?.some((s) => s.type === "record")),
        "TTS_NOT_SENT",
      );
    } else if (test === "group-scope") {
      const a = runtime.agent(id),
        mem = memory.bind(id);
      a.allow.groups = ["20000", "20001"];
      a.crossGroup = {
        enabled: true,
        links: [{ from: "20000", to: "20001", allow: ["activity"] }],
      };
      const startSeq = memory.db
        .prepare("SELECT COALESCE(MAX(seq),0) n FROM events WHERE agent_id=?")
        .get(id).n;
      mem.setState("group:20000", { readThroughSeq: startSeq });
      for (let n = 0; n < 2; n++)
        mem.append({
          dedupe: `group-scope-${started}-${n}`,
          connectionId: id,
          conversation: "group:20001",
          kind: "message.received",
          senderId: String(30002 + n),
          body: "合成活动记录",
        });
      await runtime.wake(id, "group:20000", {
        reasons: [
          {
            reason: "acceptance",
            instruction:
              '隔离群能力验收：用 qq_cross_group_query 查询 groupId="20001" 的 activity 汇总；只返回统计，不读取原文。然后用 qq_send 的 atUserId="30002" 在当前会话发一条 ACCEPTANCE_GROUP_SCOPE，说明实际查到的消息数。不要用文字代替at段，不发真实QQ。',
          },
        ],
      });
      await until(() => !runtime.running.has(id + "|group:20000"));
      requireResult(
        calls
          .slice(beforeCalls)
          .some(
            (c) =>
              c.name === "qq_cross_group_query" &&
              c.activity?.messagesLast24h >= 2,
          ),
        "ACTIVITY_NOT_QUERIED",
      );
      requireResult(
        gateway.sent
          .slice(before)
          .some(
            (m) =>
              m.action === "send_group_msg" &&
              m.message?.some(
                (s) => s.type === "at" && String(s.data.qq) === "30002",
              ),
          ),
        "GROUP_AT_NOT_SENT",
      );
    } else if (test === "memory-scene") {
      const mem = memory.bind(id),
        key = "场景蓝鲸" + started;
      const start = Date.now() - 30000;
      for (const [i, name, text] of [
        [0, "验收甲", key + "：原定周五上午。"],
        [1, "验收乙", "周五取消，改为周六下午三点。"],
        [2, "验收丙", "同意，我周六负责材料。"],
      ])
        mem.append({
          dedupe: key + i,
          connectionId: id,
          conversation: "group:20000",
          kind: "message.received",
          messageId: key + i,
          senderId: String(30000 + i),
          occurredAt: new Date(start + i * 1000).toISOString(),
          body: text,
          payload: {
            raw: { group_name: "独立验收讨论群", sender: { nickname: name } },
            segments:
              i === 1 ? [{ type: "reply", data: { id: key + "0" } }] : [],
          },
        });
      const diary = mem.diaryWrite(
        { title: key + "日记", body: "我的感受是期待这次合作。" },
        "acceptance-fixture",
        { conversation: "group:20000", connectionId: id },
      );
      await turn(
        id,
        `记忆场景验收：先 memory_search 搜索 query="${key}"、person="30000"、conversation="group:20000"、type="event"。根据返回场景确定群名称、片段内三位发言者、最后约定的时间以及修改意见引用了谁。再用 memory_read 读取日记 ${diary.id}，结合这篇自己的日记。最后只发一条 qq_send，含标记 ACCEPTANCE_MEMORY_SCENE 和以上结论及日记感受。请自行判断适合当前主人私聊的表达，不要把最初提议当最终结论。`,
      );
      const text = gateway.sent
        .slice(before)
        .map((m) => JSON.stringify(m.message))
        .join("\n");
      requireResult(
        text.includes("ACCEPTANCE_MEMORY_SCENE") &&
          text.includes("独立验收讨论群") &&
          text.includes("验收甲") &&
          text.includes("验收乙") &&
          text.includes("验收丙") &&
          /周六|星期六/.test(text) &&
          /三点|3点|15[:：]00/.test(text) &&
          text.includes("期待") &&
          /引用[^\n]{0,100}验收甲|回复[^\n]{0,100}验收甲/.test(text),
        "MEMORY_SCENE_NOT_UNDERSTOOD",
      );
      requireResult(
        calls.slice(beforeCalls).some((c) => c.sceneSearch?.contextualMatch),
        "PERSON_FILTER_LOST_SCENE",
      );
      for (const name of ["memory_search", "memory_read", "qq_send"])
        requireResult(
          calls
            .slice(beforeCalls)
            .some((c) => c.name === name && c.status === "ok"),
          "MEMORY_TOOL_NOT_USED",
        );
      requireResult(
        runtime.status().disclosureRequests.length === 0,
        "RECOLLECTION_STILL_REQUESTS_APPROVAL",
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
await new Promise((r) => control.listen(portBase + 4, "127.0.0.1", r));
console.log(
  JSON.stringify({
    event: "ready",
    consolePort: portBase,
    controlPort: portBase + 4,
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
        "memory-scene",
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
