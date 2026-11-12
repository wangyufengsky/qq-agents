import { readFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

export function createFrameworkClient(root, onState, listenPort) {
  const client = randomUUID();
  let queue = Promise.resolve();
  let syncing = false;
  let stopped = false;
  const request = async (action, data, attachment = false) => {
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
      `http://127.0.0.1:${port}/api/desktop-home/${attachment ? "attachment" : "client"}`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-desktop-home-token": token,
        },
        body: JSON.stringify(
          attachment ? { ...data, client } : { client, action, data },
        ),
        redirect: "error",
        signal: AbortSignal.timeout(attachment ? 8000 : 2500),
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
    attach(data) {
      if (stopped) return Promise.reject(Error("DESKTOP_CONNECTION_FAILED"));
      const upload = queue.then(async () => {
        if (stopped) throw Error("DESKTOP_CONNECTION_FAILED");
        const value = await request(undefined, data, true);
        if (!stopped) onState(value);
      });
      queue = upload.catch(() => {});
      return upload;
    },
    async close() {
      stopped = true;
      clearInterval(timer);
      await queue;
      await request("disconnect").catch(() => {});
    },
  };
}
