import fs from "node:fs";
import path from "node:path";
import { readState, updateDirectory } from "./installation.mjs";
import { randomUUID } from "node:crypto";
import { safeUpdateError } from "./manager.mjs";

export const updateChannel = "qq-agents-update-v1";
export function assertManagedOwner(root, managed) {
  const lock = path.join(root, updateDirectory, "supervisor.lock");
  if (managed) {
    if (
      !process.send ||
      !fs.existsSync(lock) ||
      readState(lock).pid !== process.ppid
    )
      throw Error("UPDATE_MANAGED_START_REQUIRED");
  } else if (fs.existsSync(lock)) throw Error("UPDATE_MANAGED_START_REQUIRED");
}
export function attachManagedUpdates({ runtime, lifecycle, installed, port }) {
  if (!process.send) throw Error("UPDATE_MANAGED_START_REQUIRED");
  const pending = new Map();
  const send = (message) =>
    new Promise((resolve, reject) => {
      if (!process.connected) return reject(Error("UPDATE_MANAGER_OFFLINE"));
      process.send({ channel: updateChannel, ...message }, (error) =>
        error ? reject(Error("UPDATE_MANAGER_OFFLINE")) : resolve(),
      );
    });
  const manager = {
    state: { managed: true, phase: "idle" },
    snapshot() {
      return { ...this.state, managed: !!process.connected };
    },
    async install(tag) {
      const id = randomUUID();
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(Error("UPDATE_MANAGER_OFFLINE"));
        }, 10000);
        pending.set(id, { resolve, reject, timer });
        send({ type: "install", id, tag }).catch((error) => {
          clearTimeout(timer);
          pending.delete(id);
          reject(error);
        });
      });
    },
  };
  process.on("message", async (message) => {
    if (message?.channel !== updateChannel) return;
    if (message.type === "state") {
      manager.state = message.state;
      return;
    }
    if (message.type === "reply") {
      const request = pending.get(message.id);
      if (!request) return;
      clearTimeout(request.timer);
      pending.delete(message.id);
      if (message.error) request.reject(Error(message.error));
      else request.resolve(message.value);
      return;
    }
    if (message.type !== "command") return;
    try {
      let value = {};
      if (message.action === "drain") {
        value = runtime.maintenance.begin();
      } else if (["stop", "stop-now"].includes(message.action)) {
        const drained =
          message.action === "stop" ? await runtime.maintenance.wait() : null;
        runtime.updateMaintenance = true;
        while (runtime.configChanging) await runtime.configSettled;
        const checkpoint = drained || {
          globalPaused: runtime.config.globalPaused,
          connections: runtime.config.connections
            .filter((c) => c.enabled && runtime.transports.get(c.id)?.connected)
            .map((c) => c.id),
        };
        runtime.autoResume.cancel("cancelled");
        await runtime.pause("all", true);
        await send({ type: "reply", id: message.id, value: checkpoint });
        await lifecycle.stop();
        return;
      } else if (message.action === "health") {
        if (!runtime.config.globalPaused) throw Error("UPDATE_HEALTH_FAILED");
        if (runtime.config.mode === "live") {
          for (const id of message.checkpoint.connections) {
            const connection = runtime.config.connections.find(
              (c) => c.id === id && c.enabled,
            );
            if (!connection) throw Error("UPDATE_HEALTH_FAILED");
            await runtime.startConnection(id);
            if (!runtime.transports.get(id)?.connected)
              throw Error("UPDATE_HEALTH_FAILED");
          }
          if (!message.checkpoint.globalPaused) {
            for (const agent of runtime.config.agents.filter(
              (a) => !a.paused,
            )) {
              const backend = runtime.backendConnections.adapter(agent);
              const health = backend.health
                ? await backend.health()
                : { models: await backend.models() };
              if (!Array.isArray(health?.models))
                throw Error("UPDATE_HEALTH_FAILED");
            }
          }
        }
      } else if (message.action === "resume") {
        if (!message.checkpoint.globalPaused && runtime.config.mode === "live")
          await runtime.pause("all", false);
        runtime.updateMaintenance = false;
        runtime.maintenance.clear();
      } else if (message.action === "hold") {
        runtime.updateMaintenance = false;
        runtime.maintenance.clear();
        runtime.autoResume.cancel("cancelled");
        await runtime.pause("all", true);
      } else throw Error("UPDATE_STATE_INVALID");
      await send({ type: "reply", id: message.id, value });
    } catch (error) {
      await send({
        type: "reply",
        id: message.id,
        error: safeUpdateError(error),
      }).catch(() => {});
    }
  });
  // The supervisor's disappearance must never leave an orphan sending messages.
  process.once("disconnect", () => {
    void lifecycle.stop(1);
  });
  void send({ type: "ready", protocol: 1, installed, port }).catch(() =>
    lifecycle.stop(1),
  );
  return manager;
}
