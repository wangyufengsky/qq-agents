// @ts-check
// Opt-in real Codex game turn; QQ delivery always terminates at an in-memory fixture.
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { ConfigStore, validateConfig } from "../src/core/config.mjs";
import { MemoryStore } from "../src/memory/store.mjs";
import { Runtime } from "../src/core/runtime.mjs";
import { CodexBackend } from "../src/backends/codex.mjs";
import { GameHost } from "../src/games/framework/host.mjs";
import { secret } from "../src/games/core/value.mjs";
const args = process.argv.slice(2),
  value = (/** @type {string} */ key) => args[args.indexOf(key) + 1];
if (!args.includes("--allow-real-model") || !args.includes("--data"))
  throw Error("EXPLICIT_REAL_MODEL_OPT_IN_REQUIRED");
const root = path.resolve(value("--data")),
  agentId = "game-acceptance";
if (!fs.existsSync(path.join(root, "codex", agentId, "home", "auth.json")))
  throw Error("INDEPENDENT_CODEX_LOGIN_REQUIRED");
if (fs.existsSync(path.join(root, "memory.sqlite")))
  throw Error("FRESH_ACCEPTANCE_DATABASE_REQUIRED");
const cfg = validateConfig({
  version: 1,
  mode: "live",
  globalPaused: false,
  games: { enabled: true },
  connections: [
    {
      id: "fixture",
      label: "Fixture",
      accountId: "10000",
      httpUrl: "http://127.0.0.1:9",
      wsUrl: "ws://127.0.0.1:9",
      enabled: true,
    },
  ],
  backends: [
    {
      id: "codex",
      type: "codex",
      label: "Codex",
      ...(args.includes("--model") ? { model: value("--model") } : {}),
      effort: "low",
    },
  ],
  agents: [
    {
      id: agentId,
      name: "Game acceptance",
      connectionId: "fixture",
      backendId: "codex",
      paused: false,
      allow: { users: ["30000"], groups: [] },
      games: { enabled: true, publicPersona: "谨慎的五子棋对手。" },
      tools: [],
      subject: { enabled: false },
    },
  ],
});
const memory = new MemoryStore(path.join(root, "memory.sqlite")),
  configStore = new ConfigStore(path.join(root, "config.json"), cfg);
let sends = 0;
const runtime = new Runtime({
  configStore,
  memory,
  backendFactory: (/** @type {any} */ b, /** @type {any} */ a) =>
    new CodexBackend(b, a, { root }),
});
runtime.transports.set("fixture", {
  connected: true,
  send: async () => {
    sends++;
    return { messageId: "40001" };
  },
  close: () => {},
});
runtime.games = new GameHost(runtime, { launch: false });
const h = runtime.games;
h.ensure();
try {
  const result = await runtime.withContext(
    agentId,
    "private:30000",
    async (/** @type {any} */ ctx) => {
      const event = memory.bind(agentId).append({
        dedupe: randomUUID(),
        kind: "message.received",
        conversation: "private:30000",
        senderId: "30000",
        body: "下五子棋",
        direction: "in",
        payload: { trustedInput: true },
      });
      return h.create(ctx, {
        eventId: event.id,
        gameType: "gomoku",
        options: {},
        requestId: randomUUID(),
      });
    },
  );
  const k = h.kernel,
    room = k.store.room(result.roomId),
    actor = k.actor(room.owner),
    browser = secret();
  const invitation = h.identity.invite(
      room.id,
      actor,
      room.participants[0].participantId,
    ),
    proof = h.identity.request(
      room.id,
      invitation.bindingId,
      invitation.invite,
      browser,
    );
  const confirmation = h.identity.confirm(
    room.id,
    invitation.bindingId,
    proof.challenge,
    actor,
  );
  h.identity.exchange(
    room.id,
    invitation.bindingId,
    browser,
    confirmation.code,
  );
  const act = (/** @type {string} */ type, /** @type {any} */ payload = {}) =>
    k.act(room.id, actor, {
      actionId: randomUUID(),
      expectedRevision: k.store.room(room.id).revision,
      action: { type, payload },
    });
  act("room.start");
  act("game.place", { x: 7, y: 7 });
  const id = k.store.room(room.id).decision.decisionId;
  h.jobs.receive(id);
  const heartbeat = setInterval(() => h.refreshAccess(), 1000);
  try {
    await h.worker.run(id);
  } finally {
    clearInterval(heartbeat);
  }
  const job = h.jobs.get(id),
    after = k.store.room(room.id);
  const backend = runtime.backends.get(agentId),
    native = await backend.gameRunState(job.run);
  const report = {
    at: new Date().toISOString(),
    realBackend: "codex",
    fakeQqSends: sends,
    status: job.status,
    nativeTerminal: native.terminal,
    modelTurnsInChat: Number(
      memory.db.prepare("SELECT count(*) AS n FROM model_turns").get()?.n,
    ),
    stoneCount: after.state.board.filter((/** @type {number} */ n) => n !== 0)
      .length,
    scopeIsolated: !!job.run.session,
    attempts: Number(
      k.store.db
        .prepare(
          "SELECT count(*) AS attempts FROM game_attempts WHERE job_id=?",
        )
        .get(id).attempts,
    ),
  };
  fs.writeFileSync(
    path.join(root, "result.json"),
    JSON.stringify(report, null, 2),
    { mode: 0o600 },
  );
  console.log(JSON.stringify(report));
  if (job.status !== "completed" || report.stoneCount !== 2 || !native.terminal)
    throw Error("GAME_ACCEPTANCE_FAILED");
} finally {
  await runtime.close();
  memory.close();
}
