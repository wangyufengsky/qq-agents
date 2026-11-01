// @ts-check
// @ts-check
// Runtime defaults are source code; examples are generated documentation.
import { validateConfig } from "./config.mjs";

// Reuse schema defaults for the console's new-role form and shipped examples.
export function defaultAgentCapabilities() {
  const agent = validateConfig(defaultConfig()).agents[0];
  const keys = /** @type {const} */ ([
    "tools",
    "network",
    "apps",
    "files",
    "github",
    "games",
    "scheduler",
    "voice",
    "crossGroup",
    "operations",
  ]);
  return Object.fromEntries(keys.map((key) => [key, agent[key]]));
}

export function defaultConfig() {
  return {
    version: 1,
    mode: "isolated",
    port: 3210,
    globalPaused: true,
    privateLikeGroups: [],
    games: {
      enabled: false,
      port: 35824,
      publicOrigin: "",
      maxRooms: 32,
      maxHistoryRooms: 256,
    },
    connections: [
      {
        id: "napcat-a",
        label: "QQ 实例 A",
        accountId: "10001",
        httpUrl: "http://127.0.0.1:23010",
        wsUrl: "ws://127.0.0.1:23011",
        tokenEnv: "QQ_UNIFIED_ONEBOT_A",
        enabled: false,
        deployment: "external",
      },
      {
        id: "napcat-b",
        label: "QQ 实例 B",
        accountId: "10002",
        httpUrl: "http://127.0.0.1:23020",
        wsUrl: "ws://127.0.0.1:23021",
        tokenEnv: "QQ_UNIFIED_ONEBOT_B",
        enabled: false,
        deployment: "external",
      },
    ],
    backends: [
      {
        id: "dsh-desktop",
        type: "dsh",
        label: "DeepSeek Harness",
        provider: "",
        model: "",
        effort: "high",
        preset: "qq-unified",
      },
      {
        id: "codex-cli",
        type: "codex",
        label: "Codex 独立实例",
        model: "",
        effort: "high",
      },
    ],
    agents: [
      {
        id: "agent-a",
        name: "角色 A",
        connectionId: "napcat-a",
        backendId: "dsh-desktop",
        paused: true,
        persona:
          "请在管理台设置此角色的人格。\n\n说话样本：填写 5–10 句这个角色真实会说的话，体现口头禅、标点习惯、笑的写法与常见长度。",
        aliases: [],
        ownerIds: [],
        allow: {
          groups: [],
          users: [],
        },
        maxConsecutiveSends: 3,
        // Two agents on two QQ accounts can tell each other's owners when one
        // goes offline; the administrator turns it on per agent.
        behavior: {
          toneCheck: { mode: "warn", phrases: [], maxLinesCasual: 6 },
          outageNotice: { enabled: false },
          rhythm: {
            enabled: false,
            sleep: { start: "01:00", end: "08:30" },
            sleepMode: "defer",
            urgentOwners: true,
            wakeJitterMs: 1800000,
            lateReply: { probability: 0.1, minMs: 60000, maxMs: 600000 },
          },
        },
        network: {
          publicUrls: [],
        },
        apps: {
          enabled: true,
          hours: {
            enabled: true,
            scope: "autonomous",
            start: "09:00",
            end: "22:00",
            timezone: "Asia/Shanghai",
          },
        },
      },
      {
        id: "agent-b",
        name: "角色 B",
        connectionId: "napcat-b",
        backendId: "codex-cli",
        paused: true,
        persona:
          "请在管理台设置此角色的人格。\n\n说话样本：填写 5–10 句这个角色真实会说的话，体现口头禅、标点习惯、笑的写法与常见长度。",
        aliases: [],
        ownerIds: [],
        allow: {
          groups: [],
          users: [],
        },
        maxConsecutiveSends: 3,
        behavior: {
          toneCheck: { mode: "warn", phrases: [], maxLinesCasual: 6 },
          outageNotice: { enabled: false },
          rhythm: {
            enabled: false,
            sleep: { start: "01:00", end: "08:30" },
            sleepMode: "defer",
            urgentOwners: true,
            wakeJitterMs: 1800000,
            lateReply: { probability: 0.1, minMs: 60000, maxMs: 600000 },
          },
        },
        network: {
          publicUrls: [],
        },
        apps: {
          enabled: true,
          hours: {
            enabled: true,
            scope: "autonomous",
            start: "09:00",
            end: "22:00",
            timezone: "Asia/Shanghai",
          },
        },
      },
    ],
  };
}
