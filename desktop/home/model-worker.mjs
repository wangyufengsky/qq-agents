import { appendFileSync, lstatSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  decisionTool,
  promptFor,
  readDecision,
} from "../../src/home/desktop-decision.mjs";
import { BackendRegistry } from "../../src/backends/index.mjs";
import { startSubjectPilot } from "./subject-pilot.mjs";
import { startDshTrial } from "./dsh-trial.mjs";

const instructions = {
  fish: "你是大肥鱼，大家也叫你小鱼。说话随意，偶尔调侃，也愿意安静听别人说。",
  dragon: "你是大肥龙，大家也叫你龙。说话稳当、直接，偶尔开个轻巧的玩笑。",
  cat: "你是哈基米，大家也叫你猫。说话自然随意，关心当下的人，也可以安静待着。",
};

const root = process.argv[2];
const profile = JSON.parse(
  readFileSync(join(root, "trial-profile.json"), "utf8"),
);
if (
  profile.kind !== "desktop-home-p2" ||
  !Array.isArray(profile.roles) ||
  ![2, 3].includes(profile.roles.length)
)
  throw Error("DESKTOP_PROFILE_REQUIRED");

const startup = new AbortController();
process.once("disconnect", () => startup.abort());
function stopStartup({ type }) {
  if (type === "shutdown") startup.abort();
}
process.on("message", stopStartup);
const registry = new BackendRegistry();
const backends = new Map();
const types = { fish: "dsh", dragon: "codex", cat: "antigravity" };
let dsh;
for (const role of profile.roles) {
  const { id, type, command, model, effort, provider } = role;
  if (
    types[id] !== type ||
    backends.has(id) ||
    !isAbsolute(command) ||
    typeof model !== "string" ||
    !model
  )
    throw Error("DESKTOP_PROFILE_INVALID");
  if (
    type === "codex" &&
    !lstatSync(join(root, "codex", id, "home", "auth.json")).isFile()
  )
    throw Error("DESKTOP_PROFILE_LOGIN_REQUIRED");
  if (type === "dsh") {
    try {
      dsh = await startDshTrial(
        root,
        role,
        decisionTool.function,
        startup.signal,
      );
    } catch {
      continue;
    }
  }
  backends.set(
    id,
    registry.create(
      {
        id,
        type,
        command,
        model,
        ...(effort ? { effort } : {}),
        ...(type === "antigravity" ? { cliProtocol: "acp" } : {}),
        ...(type === "dsh"
          ? { preset: "qq-unified", provider, baseUrl: dsh.baseUrl }
          : {}),
        toolServers: [],
      },
      { id },
      { root, ...(type === "dsh" ? { client: dsh.client } : {}) },
    ),
  );
}

let subjectPilot;
if (profile.subjectPilot && dsh && !startup.signal.aborted) {
  subjectPilot = await startSubjectPilot({
    root,
    dsh,
    registry,
    role: profile.roles.find(({ id }) => id === "fish"),
    fixturePort: profile.subjectPilot.fixturePort,
    persona:
      instructions.fish +
      "。你有自己的空闲时间，会在想找管理员闲聊时考虑到桌边串门，是否行动由你决定。",
    notify: (knock) => {
      if (process.connected) process.send({ knock });
    },
  }).catch(async (error) => {
    await dsh.close();
    throw error;
  });
}
const tasks = new Map();
const closing = new Set();
let stopping = false;
const send = (value) => {
  if (process.connected) process.send(value);
};
function trace(event, request, id, code) {
  if (profile.trace === true)
    appendFileSync(
      join(root, "desktop-trace.jsonl"),
      JSON.stringify({
        event,
        id,
        actor: request.actor,
        kind: request.kind,
        at: Date.now(),
        ...(code ? { code } : {}),
      }) + "\n",
      { mode: 0o600 },
    );
}

function retire(actor, session) {
  const backend = backends.get(actor);
  if (!backend) return;
  const cleanup = backend
    .closeSocialSessions({ windowId: session })
    .catch(() => {});
  closing.add(cleanup);
  void cleanup.finally(() => closing.delete(cleanup));
}

async function run(id, request) {
  const backend = backends.get(request.actor);
  if (
    !backend ||
    !["invitation", "chat", "opportunity"].includes(request.kind)
  ) {
    send({ id, error: true });
    return;
  }
  const controller = new AbortController();
  const signal = AbortSignal.any([
    controller.signal,
    AbortSignal.timeout(85_000),
  ]);
  const binding = {
    runId: randomUUID(),
    windowId: request.kind === "opportunity" ? null : request.session,
    actorIdentity: { generation: request.actor },
    target: {
      kind:
        request.kind === "opportunity" ? "desktop-opportunity" : "desktop-room",
    },
  };
  let decision;
  const callTool = (name, args) => {
    signal.throwIfAborted();
    if (name !== decisionTool.function.name || decision)
      throw Error("DESKTOP_DECISION_DENIED");
    const choice = readDecision(request.kind, args);
    if (!choice || (scope && choice.text?.includes(scope.id)))
      throw Error("DESKTOP_DECISION_INVALID");
    decision = choice;
    return { content: [{ type: "text", text: "已记录本回合的决定。" }] };
  };
  const scope =
    request.actor === "fish" ? dsh.scope(signal, callTool) : undefined;
  tasks.set(id, controller);
  let release;
  try {
    if (request.actor === "fish")
      release = subjectPilot?.visits.beginDesktop(controller);
    await backend.runDesktop({
      binding,
      budget: null,
      instructions: `${instructions[request.actor]} 你正在独立的桌面小窝试用环境中。聊天只发生在当前桌面房间。使用当前提供的决定工具，不使用电脑、文件、QQ 或其他工具。`,
      prompt: promptFor(request),
      signal,
      tools: [decisionTool],
      maxToolResultBytes: 4096,
      beforeInput: () => signal.throwIfAborted(),
      onRunStarted: () => trace("started", request, id),
      callTool,
      ...(scope ? { socialContextToken: scope.id } : {}),
    });
    signal.throwIfAborted();
    if (!decision) throw Error("DESKTOP_DECISION_MISSING");
    trace("completed", request, id);
    send({ id, decision });
  } catch (error) {
    const code = [
      controller.signal.reason?.message,
      error?.code,
      error?.message,
      error?.cause?.message,
    ].find(
      (value) =>
        typeof value === "string" &&
        /^(?:DSH|SOCIAL|DESKTOP|ANTIGRAVITY|CODEX|BACKEND|ABORTED)[A-Z0-9_]{0,70}$/.test(
          value,
        ),
    );
    const stage = /^(?:workspace|session|presets|model|prompt):/.exec(
      error?.message,
    )?.[0];
    trace(
      controller.signal.aborted ? "cancelled" : "failed",
      request,
      id,
      code ?? stage ?? "UNCLASSIFIED",
    );
    send({
      id,
      error: code === "DESKTOP_QQ_PRIORITY" ? code : true,
      desktopSessionUntouched: error?.desktopSessionUntouched === true,
    });
  } finally {
    scope?.close();
    release?.();
    tasks.delete(id);
  }
}

async function shutdown() {
  if (stopping) return;
  stopping = true;
  for (const controller of tasks.values()) controller.abort();
  await Promise.allSettled(
    [...backends.values()]
      .map((backend) => backend.close())
      .concat(subjectPilot?.close() ?? []),
  );
  await Promise.allSettled(closing);
  await dsh?.close();
  if (process.connected) process.disconnect();
}

process.on(
  "message",
  ({ type, id, request, actor, session, open, epoch, direct }) => {
    if (type === "shutdown") void shutdown();
    if (stopping) return;
    if (
      type === "door" &&
      typeof open === "boolean" &&
      Number.isSafeInteger(epoch)
    )
      subjectPilot?.visits.setDoor(open, epoch, direct === true);
    if (type === "run") void run(id, request);
    if (type === "abort") tasks.get(id)?.abort();
    if (type === "retire") retire(actor, session);
  },
);
process.on("disconnect", () => void shutdown());
process.off("message", stopStartup);
if (startup.signal.aborted) await shutdown();
else
  send({
    roles: [...backends.keys()],
    subjectActor: subjectPilot ? "fish" : null,
  });
