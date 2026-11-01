import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, execFileSync } from "node:child_process";
import { resolveManagedStartup } from "../src/updates/startup-target.mjs";
import { waitForDrain } from "../src/updates/drain.mjs";
import {
  NativeQQ,
  processIdentity,
  ownsProcess,
  readJson,
  writeJson,
  sleep,
  portBusy,
} from "./lib/local-process.mjs";

const args = process.argv.slice(2),
  command = args[0] || "status";
const option = (name) =>
  args.includes(name) ? args[args.indexOf(name) + 1] : undefined;
const root = path.resolve(
  option("--data") || process.env.QQ_UNIFIED_DATA || ".runtime",
);
const config = readJson(path.join(root, "config.json"));
const deployment = fs.existsSync(path.join(root, "deployment.json"))
  ? readJson(path.join(root, "deployment.json"))
  : {};
const codeRoot =
  deployment.codeRoot ||
  path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const base = `http://127.0.0.1:${config.port}`;
const tokenFile = path.join(root, "admin-token");
const recordFile = path.join(root, "launcher-process.json");
const nativeFile = path.join(root, "native-profiles.json");
const native = new NativeQQ(
  fs.existsSync(nativeFile) ? readJson(nativeFile).profiles : [],
);
for (const p of native.profiles) {
  const c = config.connections.find((c) => c.id === p.id);
  if (
    !c ||
    c.accountId !== p.accountId ||
    c.httpUrl !== p.httpUrl ||
    c.wsUrl !== p.wsUrl
  )
    throw Error("NATIVE_CONNECTION_MISMATCH");
}
async function api(route, body) {
  const response = await fetch(base + "/api/" + route, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      "x-admin-token": fs.readFileSync(tokenFile, "utf8").trim(),
      "content-type": "application/json",
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw Error(`CONSOLE_HTTP_${response.status}`);
  return response.json();
}
function bridgeRecord() {
  return fs.existsSync(recordFile) ? readJson(recordFile) : null;
}
function verifiedBridge() {
  const r = bridgeRecord(),
    i = processIdentity(r?.pid);
  if (i && !ownsProcess(r, i, r.command, root))
    throw Error("BRIDGE_PID_OWNERSHIP_MISMATCH");
  return i ? r : null;
}
async function status() {
  const listening = await portBusy(config.port);
  const live = listening ? await api("status") : null;
  return {
    consoleUrl: base,
    bridge: live
      ? {
          mode: live.mode,
          globalPaused: live.globalPaused,
          connections: live.connections,
          agents: live.agents,
          pendingDisclosureCount: live.disclosureRequests?.length || 0,
        }
      : { running: false },
    native: native.profiles.map((p) => native.status(p)),
  };
}
async function connectAndResume() {
  const current = await api("status");
  for (const c of config.connections.filter((c) => c.enabled))
    if (!current.connections.some((x) => x.id === c.id && x.connected))
      await api("connection", { id: c.id, action: "connect" });
  if (args.includes("--resume")) {
    // Preserve per-agent and per-conversation pause preferences. Only lift the boot barrier.
    for (const a of config.agents.filter((a) => !a.paused))
      await api("models", { agentId: a.id });
    const s = await api("status");
    if (
      !config.connections
        .filter((c) => c.enabled)
        .every((c) => s.connections.some((x) => x.id === c.id && x.connected))
    )
      throw Error("QQ_NOT_READY");
    await api("pause", { paused: false });
  }
}
function checkGames() {
  const database = path.join(root, "games", "rooms.sqlite");
  if (!fs.existsSync(database)) return;
  const target =
    deployment.managedUpdates === true
      ? resolveManagedStartup({ root, bundledRoot: codeRoot }).current.codeRoot
      : codeRoot;
  const script = path.join(target, "scripts", "game-compatibility.mjs");
  if (!fs.existsSync(script))
    throw Error("GAME_COMPATIBILITY_CHECK_UNAVAILABLE");
  try {
    execFileSync(process.execPath, [script, database], {
      stdio: "pipe",
      timeout: 15000,
    });
  } catch {
    throw Error("GAME_DEPLOYMENT_INCOMPATIBLE");
  }
}
async function start() {
  checkGames();
  await native.start();
  await native.waitReady(
    config.connections.filter((c) => c.enabled).map((c) => c.id),
  );
  if (await portBusy(config.port)) {
    await api("status");
    await connectAndResume();
    return;
  }
  if (verifiedBridge()) throw Error("BRIDGE_START_IN_PROGRESS");
  const lock = path.join(root, "process.lock");
  if (fs.existsSync(lock)) {
    if (processIdentity(readJson(lock).pid))
      throw Error("DATA_DIRECTORY_LOCKED");
    fs.renameSync(
      lock,
      path.join(root, `stale-process-lock-${Date.now()}.json`),
    );
  }
  const entry = path.join(
    codeRoot,
    deployment.managedUpdates === true
      ? "src/updates/supervisor.mjs"
      : "src/main.mjs",
  );
  if (!fs.existsSync(entry)) throw Error("DEPLOYED_CODE_MISSING");
  const secretsFile = path.join(root, "secrets.json");
  const secrets = fs.existsSync(secretsFile) ? readJson(secretsFile) : {};
  if (Object.values(secrets).some((v) => typeof v !== "string"))
    throw Error("INVALID_LOCAL_SECRETS");
  const fd = fs.openSync(path.join(root, "bridge.log"), "a", 0o600);
  const childArgs = [
    entry,
    "--data",
    root,
    ...(config.mode === "live" ? ["--live"] : []),
  ];
  let child;
  try {
    child = spawn(process.execPath, childArgs, {
      cwd: codeRoot,
      env: { ...process.env, ...secrets },
      detached: true,
      stdio: ["ignore", fd, fd],
    });
  } finally {
    fs.closeSync(fd);
  }
  await new Promise((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", () => reject(Error("BRIDGE_START_FAILED")));
  });
  child.unref();
  const identity = processIdentity(child.pid);
  const record = {
    pid: child.pid,
    born: identity?.born,
    command: [process.execPath, ...childArgs].join(" "),
    scope: root,
  };
  if (!ownsProcess(record, identity, record.command, root))
    throw Error("BRIDGE_PID_OWNERSHIP_MISMATCH");
  writeJson(recordFile, record);
  for (let i = 0; i < 60; i++) {
    if (!processIdentity(child.pid)) throw Error("BRIDGE_EXITED_DURING_START");
    if (await portBusy(config.port)) {
      await connectAndResume();
      return;
    }
    await sleep(500);
  }
  throw Error("BRIDGE_START_TIMEOUT");
}
async function stop() {
  const r = verifiedBridge();
  if (!r) {
    if (await portBusy(config.port))
      throw Error("UNMANAGED_BRIDGE_REQUIRES_EXPLICIT_MIGRATION");
    return;
  }
  // Both entries handle SIGTERM through runtime shutdown. A second HTTP pause
  // would be rejected by the drain gate and prevent an explicitly requested stop.
  process.kill(r.pid, "SIGTERM");
  for (let i = 0; i < 60 && processIdentity(r.pid); i++) await sleep(500);
  if (processIdentity(r.pid)) throw Error("BRIDGE_STOP_INCOMPLETE");
  fs.rmSync(recordFile, { force: true });
}
let lock;
try {
  if (command !== "status") {
    lock = path.join(root, "launcher-operation.lock");
    const fd = fs.openSync(lock, "wx", 0o600);
    fs.writeFileSync(fd, String(process.pid));
    fs.closeSync(fd);
  }
  if (command === "start") await start();
  else if (command === "stop") await stop();
  else if (command === "restart") {
    checkGames();
    if (verifiedBridge() && (await portBusy(config.port)))
      await waitForDrain(() => api("maintenance", {}));
    await stop();
    await start();
  } else if (command === "qq-stop") {
    if (await portBusy(config.port)) throw Error("STOP_BRIDGE_BEFORE_QQ");
    await native.stop();
  } else if (command !== "status" && command !== "open")
    throw Error(
      "Usage: robots.mjs start|stop|restart|status|open|qq-stop --data DIRECTORY [--resume] [--open]",
    );
  if (command === "open" || args.includes("--open"))
    execFileSync("open", [base]);
  console.log(JSON.stringify(await status(), null, 2));
} catch (e) {
  console.error(e.message);
  process.exitCode = 1;
} finally {
  if (
    lock &&
    fs.existsSync(lock) &&
    fs.readFileSync(lock, "utf8") === String(process.pid)
  )
    fs.rmSync(lock);
}
