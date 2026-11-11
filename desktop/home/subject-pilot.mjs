import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { ConfigStore, validateConfig } from "../../src/core/config.mjs";
import { MemoryStore } from "../../src/memory/store.mjs";
import { Runtime } from "../../src/core/runtime.mjs";
import { deriveRelayToken } from "../../src/core/relay-auth.mjs";
import {
  DesktopVisits,
  DESKTOP_VISIT_TOOL,
} from "../../src/home/desktop-visits.mjs";
import { createServer } from "../../src/server.mjs";

export async function startSubjectPilot({
  root,
  role,
  dsh,
  registry,
  notify,
  persona,
  fixturePort,
}) {
  const work = join(root, "subject-pilot");
  mkdirSync(work, { recursive: true, mode: 0o700 });
  if (
    fixturePort !== undefined &&
    (!Number.isInteger(fixturePort) ||
      fixturePort < 1024 ||
      fixturePort > 65535)
  )
    throw Error("DESKTOP_FIXTURE_PORT_INVALID");
  const endpoint = `127.0.0.1:${fixturePort ?? 9}`;
  const backend = {
    id: "fish-pilot",
    label: "小鱼隔离试点",
    type: "dsh",
    preset: "qq-unified",
    baseUrl: dsh.baseUrl,
    provider: role.provider,
    model: role.model,
    effort: role.effort,
    toolServers: [],
  };
  const config = validateConfig({
    version: 1,
    mode: "live",
    globalPaused: false,
    board: { enabled: false },
    connections: [
      {
        id: "fixture-qq",
        label: "本地验收网关",
        accountId: "10000",
        httpUrl: `http://${endpoint}`,
        wsUrl: `ws://${endpoint}`,
        enabled: fixturePort !== undefined,
      },
    ],
    backends: [backend],
    agents: [
      {
        id: "fish",
        name: "小鱼",
        persona,
        paused: false,
        connectionId: "fixture-qq",
        backendId: backend.id,
        allow: { users: ["30000"] },
        tools: [],
        network: { autonomous: false },
        apps: { enabled: false },
        files: { enabled: false },
        github: { enabled: false },
        behavior: {
          typing: { enabled: false },
          preSleepWaitMs: 0,
          replyCheckEnabled: false,
        },
        wake: { cooldownMs: 0, participation: 1 },
        subject: {
          enabled: true,
          offlineReview: true,
          intervalMs: fixturePort === undefined ? 3_600_000 : 60_000,
          maxChecksPerDay: 8,
        },
        functionalAgents: {
          subject: {
            kind: "subject",
            tools: [DESKTOP_VISIT_TOOL, "subject_log"],
          },
          qq: { kind: "qq-dialogue", tools: [] },
        },
      },
    ],
  });
  const memory = new MemoryStore(join(work, "memory.sqlite"));
  const token = randomBytes(32).toString("hex");
  const configStore = new ConfigStore(join(work, "config.json"), config);
  // The acceptance gateway is bound to an ephemeral port on each launch.
  const previous = configStore.value.connections[0];
  const connection = config.connections[0];
  if (
    previous.httpUrl !== connection.httpUrl ||
    previous.enabled !== connection.enabled
  )
    configStore.save(config, configStore.revision);
  const runtime = new Runtime({
    configStore,
    memory,
    backendFactory: (settings, agent) =>
      registry.create(settings, agent, { root: work, client: dsh.newClient() }),
  });
  const visits = new DesktopVisits(runtime, "fish", notify);
  runtime.desktopVisits = visits;
  const server = createServer({ runtime, token });
  try {
    const port = await server.listen();
    dsh.attachSubject(port, deriveRelayToken(token));
    if (fixturePort !== undefined) await runtime.startConnection("fixture-qq");
    runtime.startTimers();
    return {
      visits,
      async close() {
        await runtime.close();
        await server.close();
        memory.close();
      },
    };
  } catch (error) {
    await runtime.close();
    await server.close();
    memory.close();
    throw error;
  }
}
