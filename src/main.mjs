import { Diagnostics } from "./core/diagnostics.mjs";
import {
  acquireProcessLock,
  ProcessLifecycle,
} from "./core/process-lifecycle.mjs";
import { FileStore } from "./tools/files.mjs";
import { loadGithubCredentials } from "./github/credentials.mjs";
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
const diagnostics = new Diagnostics();
const lifecycle = new ProcessLifecycle({ diagnostics });
process.on("SIGINT", () => lifecycle.signal());
process.on("SIGTERM", () => lifecycle.signal());
try {
  const timeout = Number(option("--shutdown-timeout-ms") ?? 30000);
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 120000)
    throw Error("INVALID_BUDGET");
  lifecycle.timeoutMs = timeout;
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  lifecycle.lock = acquireProcessLock(root);
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
  const memory = (lifecycle.memory = new MemoryStore(
    path.join(root, "memory.sqlite"),
  ));
  const registry = new BackendRegistry();
  const runtime = (lifecycle.runtime = new Runtime({
    diagnostics,
    configStore,
    memory,
    backendFactory: (c, a) => registry.create(c, a, { root }),
  }));
  runtime.media = new MediaStore(path.join(root, "media"));
  runtime.files = new FileStore(path.join(root, "files"));
  runtime.voices = new VoiceStore(path.join(root, "voices"));
  runtime.lifecycle = new Lifecycle(root);
  const githubSecretFile = path.join(root, "secrets.json");
  loadGithubCredentials(githubSecretFile);
  const server = (lifecycle.server = createServer({
    runtime,
    token,
    allowLive,
    githubSecretFile,
  }));
  const port = await server.listen(
    option("--port") === undefined
      ? configStore.value.port
      : Number(option("--port")),
  );
  runtime.startTimers();
  console.log(
    `QQ Agents: http://127.0.0.1:${port} | ${configStore.value.mode} | paused | admin token in data directory/admin-token`,
  );
} catch (e) {
  diagnostics.report(e, { component: "startup" });
  await lifecycle.stop(1);
}
