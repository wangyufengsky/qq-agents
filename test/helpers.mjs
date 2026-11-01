import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { ConfigStore, validateConfig } from "../src/core/config.mjs";
import { MemoryStore } from "../src/memory/store.mjs";
import { Runtime } from "../src/core/runtime.mjs";
// Captured at load: some tests stub process.platform while their hooks run.
const windows = process.platform === "win32";
const leftovers = new Set();
process.once("exit", () => {
  for (const root of leftovers)
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {
      // Best effort: the OS temp directory is cleaned eventually.
    }
});
export function temp(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "qq-unified-test-"));
  // This hook runs before hooks registered later close the stores inside
  // root. Windows cannot delete open files, and a throw here would skip those
  // hooks and leave timers running, so retry at exit there instead.
  t.after(() => {
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch (error) {
      if (!windows) throw error;
      leftovers.add(root);
    }
  });
  return root;
}
export function config(n = 3) {
  return validateConfig({
    version: 1,
    mode: "live",
    globalPaused: false,
    connections: Array.from({ length: n }, (_, i) => ({
      id: "qq-" + i,
      label: "Fixture " + i,
      accountId: String(10000 + i),
      httpUrl: "http://127.0.0.1:9",
      wsUrl: "ws://127.0.0.1:9",
      enabled: true,
    })),
    backends: [{ id: "fixture", type: "codex", label: "Fixture" }],
    agents: Array.from({ length: n }, (_, i) => ({
      id: "agent-" + i,
      name: "角色" + i,
      connectionId: "qq-" + i,
      backendId: "fixture",
      paused: false,
      allow: { groups: ["20000", "20001"], users: ["30000"] },
      wake: { participation: 1, cooldownMs: 0 },
      // Timing is tested with fake clocks; unrelated fixtures must not wait for typing.
      behavior: { typing: { enabled: false } },
      tools: [
        "memory_search",
        "memory_read",
        "conversation_read",
        "diary_write",
        "diary_revise",
        "qq_send",
        "qq_mark_read",
        "qq_set_silence",
      ],
      // Most fixtures exercise explicit, restricted permissions. Product
      // defaults are covered independently in capability-defaults.test.mjs.
      network: { autonomous: false },
      apps: { enabled: false, sharing: false, platforms: [] },
      files: { enabled: false },
      github: { enabled: false },
      scheduler: { enabled: false },
      voice: { tts: { enabled: false } },
      crossGroup: { enabled: false },
      operations: { enabled: false },
    })),
  });
}
export const raw = (id = 1, extra = {}) => ({
  post_type: "message",
  self_id: 10000,
  message_type: "group",
  group_id: 20000,
  user_id: 30000,
  message_id: id,
  time: 1800000000,
  message: [{ type: "text", data: { text: "约定下周见" } }],
  sender: { nickname: "Fixture" },
  ...extra,
});
export class FakeTransport extends EventEmitter {
  constructor() {
    super();
    this.connected = true;
    this.sent = [];
    this.failure = null;
  }
  async connect() {
    this.connected = true;
  }
  close() {
    this.connected = false;
  }
  async send(conversation, segments) {
    this.sent.push({ conversation, segments });
    if (this.failure) throw Error(this.failure);
    return { messageId: String(40000 + this.sent.length) };
  }
}
export function fixture(t, { run = async () => {}, cfg = config() } = {}) {
  const root = temp(t),
    store = new MemoryStore(path.join(root, "memory.sqlite")),
    configStore = new ConfigStore(path.join(root, "config.json"), cfg);
  const backends = [];
  const runtime = new Runtime({
    memory: store,
    configStore,
    backendFactory: () => {
      const b = { run, cancel: async () => {}, close: async () => {} };
      backends.push(b);
      return b;
    },
    transportFactory: () => new FakeTransport(),
  });
  for (const c of cfg.connections)
    runtime.transports.set(c.id, new FakeTransport());
  t.after(async () => {
    await runtime.close();
    store.close();
  });
  return { root, store, configStore, runtime, backends };
}
export async function settle(runtime) {
  await Promise.allSettled([...runtime.jobs]);
}
export function context(
  runtime,
  agentId = "agent-0",
  conversation = "group:20000",
) {
  return runtime.makeContext(agentId, conversation);
}
export function disclosureApproval(ctx, pending = ctx.disclosureRequest) {
  return {
    approvalId: pending.approvalId,
    agentId: ctx.agentId,
    conversation: ctx.conversation,
    ids: pending.records,
    ...(pending.requestId ? { requestId: pending.requestId } : {}),
  };
}
