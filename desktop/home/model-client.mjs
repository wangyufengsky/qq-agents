import { fork } from "node:child_process";
import { randomUUID } from "node:crypto";
import { delimiter, dirname, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";

export function startModelClient(root, node) {
  if (!node || !isAbsolute(node)) throw Error("DESKTOP_NODE_REQUIRED");
  const child = fork(
    fileURLToPath(new URL("./model-worker.mjs", import.meta.url)),
    [root],
    {
      execPath: node,
      execArgv: [],
      silent: true,
      cwd: root,
      env: {
        ...process.env,
        PATH: [dirname(node), process.env.PATH].filter(Boolean).join(delimiter),
      },
    },
  );
  // Native adapter stderr can include prompts and profile details.
  child.stdout.resume();
  child.stderr.resume();
  const pending = new Map();
  let ready;
  let failed;
  const online = new Promise((resolve, reject) => {
    ready = resolve;
    failed = reject;
  });
  online.catch(() => {});
  function offline() {
    const error = Error("DESKTOP_MODEL_WORKER_OFFLINE");
    failed(error);
    for (const job of pending.values()) job.reject(error);
    pending.clear();
  }
  child.on("error", offline);
  child.on("exit", offline);
  child.on("message", ({ roles, id, decision }) => {
    if (roles) return ready();
    const job = pending.get(id);
    if (!job) return;
    pending.delete(id);
    if (decision) job.resolve(decision);
    else job.reject(Error("DESKTOP_MODEL_TURN_FAILED"));
  });

  function send(message) {
    if (child.connected)
      child.send(message, (error) => {
        if (error) offline();
      });
  }

  return {
    roles: ["dragon", "cat"],
    async run(request, signal) {
      await online;
      signal.throwIfAborted();
      const id = randomUUID();
      const abort = () => send({ type: "abort", id });
      signal.addEventListener("abort", abort, { once: true });
      try {
        return await new Promise((resolve, reject) => {
          if (!child.connected)
            return reject(Error("DESKTOP_MODEL_WORKER_OFFLINE"));
          pending.set(id, { resolve, reject });
          send({ type: "run", id, request });
        });
      } finally {
        signal.removeEventListener("abort", abort);
      }
    },
    retire(actor, session) {
      send({ type: "retire", actor, session });
    },
    close() {
      if (!child.connected) return Promise.resolve();
      return new Promise((resolve) => {
        const timer = setTimeout(() => child.kill(), 8000);
        child.once("exit", () => {
          clearTimeout(timer);
          resolve();
        });
        send({ type: "shutdown" });
      });
    },
  };
}
