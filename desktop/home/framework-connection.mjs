import { unwatchFile, watchFile } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const configFile = "config.json";
const tokenFile = "desktop-home-token";

export function createFrameworkConnection(root, listenPort) {
  let cached;
  let pending;
  const files = [
    join(root, tokenFile),
    ...(listenPort === undefined ? [join(root, configFile)] : []),
  ];
  let watching = false;
  let closed = false;

  function invalidate(credentials) {
    if (credentials && credentials !== cached) return;
    cached = undefined;
    pending = undefined;
  }

  function changed() {
    invalidate();
  }

  function trackFiles() {
    if (watching) return;
    watching = true;
    // Async stat watches detect atomic replacements even when directory events coalesce.
    for (const file of files)
      watchFile(file, { interval: 1000, persistent: false }, changed);
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
    trackFiles();
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
      if (watching) for (const file of files) unwatchFile(file, changed);
      invalidate();
    },
  };
}
