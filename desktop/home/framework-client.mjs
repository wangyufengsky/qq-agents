import { readFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

export function createFrameworkClient(root, onState) {
  const client = randomUUID();
  let queue = Promise.resolve();
  let syncing = false;
  let stopped = false;
  const request = async (action, data) => {
    const { port = 3210 } = JSON.parse(
      readFileSync(join(root, "config.json"), "utf8"),
    );
    const token = readFileSync(join(root, "desktop-home-token"), "utf8").trim();
    if (
      !Number.isInteger(port) ||
      port < 1 ||
      port > 65535 ||
      !/^[a-f0-9]{64}$/.test(token)
    )
      throw Error("DESKTOP_CONNECTION_INVALID");
    const response = await fetch(
      `http://127.0.0.1:${port}/api/desktop-home/client`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-desktop-home-token": token,
        },
        body: JSON.stringify({ client, action, data }),
        redirect: "error",
        signal: AbortSignal.timeout(2500),
      },
    );
    if (!response.ok) throw Error("DESKTOP_CONNECTION_FAILED");
    return response.json();
  };
  const act = (action, data) => {
    if (stopped) return;
    queue = queue.then(async () => {
      try {
        const value = await request(action, data);
        if (!stopped) onState(value);
      } catch {
        if (!stopped) onState({ offline: true });
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
    async close() {
      stopped = true;
      clearInterval(timer);
      await queue;
      await request("disconnect").catch(() => {});
    },
  };
}
