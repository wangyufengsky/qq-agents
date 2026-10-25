import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { ConfigStore } from "./core/config.mjs";
import { MemoryStore } from "./memory/store.mjs";
import { MediaStore } from "./tools/media.mjs";
import { Runtime } from "./core/runtime.mjs";
import { BackendRegistry } from "./backends/index.mjs";
import { createServer } from "./server.mjs";
import { Lifecycle } from "./transport/lifecycle.mjs";
import { VoiceStore } from "./tools/voice.mjs";

const args = process.argv.slice(2),
  option = (name) =>
    args.includes(name) ? args[args.indexOf(name) + 1] : undefined;
const root = path.resolve(option("--data") || ".runtime");
fs.mkdirSync(root, { recursive: true, mode: 0o700 });
const lock = path.join(root, "process.lock");
try {
  const fd = fs.openSync(lock, "wx", 0o600);
  fs.writeFileSync(fd, JSON.stringify({ pid: process.pid }));
  fs.closeSync(fd);
} catch {
  throw Error(
    "DATA_DIRECTORY_LOCKED: another process or a stale process.lock exists; verify PID before removing it",
  );
}
let closing = false,
  server,
  runtime,
  memory;
async function close() {
  if (closing) return;
  closing = true;
  await server?.close();
  await runtime?.close();
  memory?.close();
  fs.rmSync(lock, { force: true });
}
try {
  const example = JSON.parse(
    fs.readFileSync(
      new URL("../examples/config.example.json", import.meta.url),
      "utf8",
    ),
  );
  const configStore = new ConfigStore(
    path.resolve(option("--config") || path.join(root, "config.json")),
    example,
  );
  const allowLive = args.includes("--live");
  if (!allowLive && configStore.value.mode === "live")
    throw Error("LIVE_CONFIG_REQUIRES_EXPLICIT_LIVE_FLAG");
  // Every boot begins paused. The console can explicitly resume after connections are checked.
  if (!configStore.value.globalPaused)
    configStore.save(
      { ...configStore.value, globalPaused: true },
      configStore.revision,
    );
  const tokenFile = path.join(root, "admin-token");
  if (!fs.existsSync(tokenFile))
    fs.writeFileSync(tokenFile, randomBytes(32).toString("hex"), {
      mode: 0o600,
    });
  fs.chmodSync(tokenFile, 0o600);
  const token = fs.readFileSync(tokenFile, "utf8").trim();
  if (!/^[a-f0-9]{64}$/.test(token)) throw Error("INVALID_ADMIN_TOKEN_FILE");
  memory = new MemoryStore(path.join(root, "memory.sqlite"));
  const registry = new BackendRegistry();
  runtime = new Runtime({
    configStore,
    memory,
    backendFactory: (c, a) => registry.create(c, a, { root }),
  });
  runtime.media = new MediaStore(path.join(root, "media"));
  runtime.voices = new VoiceStore(path.join(root, "voices"));
  runtime.lifecycle = new Lifecycle(root);
  server = createServer({ runtime, token, allowLive });
  const port = await server.listen(
    option("--port") === undefined
      ? configStore.value.port
      : Number(option("--port")),
  );
  runtime.startTimers();
  console.log(
    `QQ Bridge Unified: http://127.0.0.1:${port} | ${configStore.value.mode} | paused | admin token in data directory/admin-token`,
  );
  process.on("SIGINT", () => void close().then(() => process.exit(0)));
  process.on("SIGTERM", () => void close().then(() => process.exit(0)));
} catch (e) {
  await close();
  console.error(e.message);
  process.exitCode = 1;
}
