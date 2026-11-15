import { watch } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const configFile = "config.json";
const tokenFile = "desktop-home-token";

export function createFrameworkConnection(root, listenPort) {
  let cached;
  let pending;
  let watcher;
  let closed = false;

  function invalidate(credentials) {
    if (credentials && credentials !== cached) return;
    cached = undefined;
    pending = undefined;
  }

  function watchDirectory() {
    if (watcher) return;
    try {
      // Watch the parent directory so atomic replacement keeps the watch valid.
      const handle = watch(root, { persistent: false }, (_, filename) => {
        if (
          filename === null ||
          filename === tokenFile ||
          (listenPort === undefined && filename === configFile)
        ) {
          invalidate();
        }
      });
      watcher = handle;
      handle.on("error", () => {
        if (watcher !== handle) return;
        watcher = undefined;
        handle.close();
        invalidate();
      });
    } catch {
      // The data directory can be created after the desktop client opens.
    }
  }

  async function readConnection() {
    try {
      const [port, tokenText] = await Promise.all([
        listenPort ??
          readFile(join(root, configFile), "utf8").then(
            (value) => JSON.parse(value).port ?? 3210,
          ),
        readFile(join(root, tokenFile), "utf8"),
      ]);
      const token = tokenText.trim();
      if (
        Number.isInteger(port) &&
        port >= 1 &&
        port <= 65535 &&
        /^[a-f0-9]{64}$/.test(token)
      ) {
        return Object.freeze({ port, token });
      }
    } catch {
      // Keep local file paths and parser input out of connection errors.
    }
    throw Error("DESKTOP_CONNECTION_INVALID");
  }

  async function get() {
    if (closed) throw Error("DESKTOP_CONNECTION_FAILED");
    watchDirectory();
    if (cached) return cached;
    if (!pending) {
      const loading = readConnection()
        .then(
          (credentials) => {
            if (pending !== loading) return get();
            cached = credentials;
            return credentials;
          },
          (error) => {
            if (pending !== loading) return get();
            throw error;
          },
        )
        .finally(() => {
          if (pending === loading) pending = undefined;
        });
      pending = loading;
    }
    return pending;
  }

  return {
    get,
    invalidate,
    close() {
      closed = true;
      watcher?.close();
      watcher = undefined;
      invalidate();
    },
  };
}
