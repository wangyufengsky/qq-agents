import { readFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

export function createFrameworkClient(root, onState, listenPort) {
  const client = randomUUID();
  let queue = Promise.resolve();
  let syncing = false;
  let stopped = false;
  const request = async (action, data, endpoint = "client") => {
    const port =
      listenPort ??
      JSON.parse(readFileSync(join(root, "config.json"), "utf8")).port ??
      3210;
    const token = readFileSync(join(root, "desktop-home-token"), "utf8").trim();
    if (
      !Number.isInteger(port) ||
      port < 1 ||
      port > 65535 ||
      !/^[a-f0-9]{64}$/.test(token)
    )
      throw Error("DESKTOP_CONNECTION_INVALID");
    const response = await fetch(
      `http://127.0.0.1:${port}/api/desktop-home/${endpoint}`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-desktop-home-token": token,
        },
        body: JSON.stringify(
          endpoint === "client"
            ? { client, action, data }
            : { ...data, client },
        ),
        redirect: "error",
        signal: AbortSignal.timeout(endpoint === "client" ? 2500 : 8000),
      },
    );
    if (!response.ok) throw Error("DESKTOP_CONNECTION_FAILED");
    return response.json();
  };
  const enqueue = (run) => {
    const result = queue.then(() => {
      if (stopped) throw Error("DESKTOP_CONNECTION_FAILED");
      return run();
    });
    queue = result.catch(() => {});
    return result;
  };
  const act = (action, data) => {
    if (stopped) return;
    queue = queue.then(async () => {
      try {
        const value = await request(action, data);
        if (!stopped) onState(value, action);
      } catch {
        if (!stopped) onState({ offline: true }, action);
      }
    });
  };
  const sync = () => {
    if (syncing) return;
    syncing = true;
    act("sync");
    void queue.finally(() => {
      syncing = false;
    });
  };
  sync();
  const timer = setInterval(sync, 650);
  return {
    act,
    attach(data) {
      return enqueue(async () => {
        const value = await request(undefined, data, "attachment");
        if (!stopped) onState(value);
      });
    },
    screenCommand(action, data) {
      return enqueue(async () => {
        const value = await request(action, data);
        if (!stopped) onState(value, action);
        return value.room;
      });
    },
    screenResult(data, isCurrent) {
      return enqueue(() => {
        // A revoke may happen while this result waits behind another request.
        if (isCurrent()) return request(undefined, data, "screen-result");
      });
    },
    async close() {
      stopped = true;
      clearInterval(timer);
      await queue;
      await request("disconnect").catch(() => {});
    },
  };
}
