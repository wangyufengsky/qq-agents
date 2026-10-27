import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Worker } from "node:worker_threads";
import { finished } from "node:stream/promises";

export const EXPORT_LIMITS = Object.freeze({
  rowBytes: 8 * 1024 * 1024,
  outputBytes: 512 * 1024 * 1024,
  snapshotBytes: 2 * 1024 * 1024 * 1024,
  timeoutMs: 120000,
  snapshotMs: 10000,
});
const active = new WeakSet();

// The callback owns only a temporary, complete export. It must finish reading before returning.
export async function withExport(
  store,
  agentId,
  consume,
  { signal, limits = EXPORT_LIMITS, tempRoot = os.tmpdir() } = {},
) {
  store.bind(agentId);
  if (active.has(store)) throw Error("EXPORT_DOWNLOAD_BUSY");
  if (!store.file || store.file === ":memory:")
    throw Error("EXPORT_FILE_REQUIRED");
  signal?.throwIfAborted();
  active.add(store);
  let root, worker, timer, onAbort;
  const controller = new AbortController();
  const cancelled = new Int32Array(new SharedArrayBuffer(4));
  controller.signal.addEventListener(
    "abort",
    () => Atomics.store(cancelled, 0, 1),
    { once: true },
  );
  let exited;
  try {
    root = fs.mkdtempSync(path.join(tempRoot, "qq-memory-export-"));
    fs.chmodSync(root, 0o700);
    const output = path.join(root, "export.json");
    const budget = { ...EXPORT_LIMITS, ...limits };
    timer = setTimeout(
      () => controller.abort(Error("EXPORT_TIMEOUT")),
      budget.timeoutMs,
    );
    onAbort = () => controller.abort(Error("EXPORT_CANCELLED"));
    signal?.addEventListener("abort", onAbort, { once: true });
    worker = new Worker(new URL("./export-worker.mjs", import.meta.url), {
      workerData: {
        source: store.file,
        snapshot: path.join(root, "snapshot.sqlite"),
        output,
        agentId,
        limits: budget,
        cancelled: cancelled.buffer,
      },
      resourceLimits: {
        maxOldGenerationSizeMb: 24,
        maxYoungGenerationSizeMb: 2,
      },
      execArgv: [],
    });
    exited = new Promise((resolve) => worker.once("exit", resolve));
    const result = await new Promise((resolve, reject) => {
      const abort = () => reject(controller.signal.reason);
      controller.signal.addEventListener("abort", abort, { once: true });
      worker.once("message", (message) => {
        controller.signal.removeEventListener("abort", abort);
        message.error ? reject(Error(message.error)) : resolve(message);
      });
      worker.once("error", () => reject(Error("EXPORT_FAILED")));
      worker.once("exit", () => reject(Error("EXPORT_FAILED")));
    });
    controller.signal.throwIfAborted();
    return await consume({
      path: output,
      bytes: result.bytes,
      signal: controller.signal,
    });
  } catch (error) {
    if (controller.signal.aborted) throw controller.signal.reason;
    throw error;
  } finally {
    clearTimeout(timer);
    if (onAbort) signal?.removeEventListener("abort", onAbort);
    if (worker) {
      // Let the backup progress callback observe cancellation and close SQLite
      // before terminating the isolate (native backup jobs otherwise delay exit).
      if (controller.signal.aborted) {
        let grace;
        await Promise.race([
          exited,
          new Promise((resolve) => {
            grace = setTimeout(resolve, 250);
          }),
        ]);
        clearTimeout(grace);
      }
      await worker.terminate();
    }
    try {
      if (root) fs.rmSync(root, { recursive: true, force: true });
    } finally {
      active.delete(store);
    }
  }
}

export async function exportToFile(store, agentId, destination, options) {
  // Reserve the destination before doing expensive work; never replace an existing file.
  const handle = await fs.promises.open(destination, "wx", 0o600);
  try {
    await withExport(
      store,
      agentId,
      async ({ path: source, signal }) => {
        await streamExport(
          source,
          handle.createWriteStream({ flush: true }),
          signal,
        );
      },
      options,
    );
  } catch (error) {
    await handle.close();
    await fs.promises.unlink(destination);
    throw error;
  }
  await handle.close();
}

export async function streamExport(source, destination, signal) {
  // Reuse one buffer only after the writable callback releases it. Ordinary
  // read streams obey backpressure but can retain many dead ArrayBuffers until
  // a GC, which inflated RSS on large downloads despite a short stream queue.
  const done = finished(destination, { cleanup: true });
  done.catch(() => {});
  const abort = () =>
    destination.destroy(signal.reason || Error("EXPORT_CANCELLED"));
  signal?.addEventListener("abort", abort, { once: true });
  let handle;
  try {
    signal?.throwIfAborted();
    handle = await fs.promises.open(source, "r");
    const buffer = Buffer.allocUnsafe(65536);
    while (true) {
      signal?.throwIfAborted();
      const { bytesRead } = await handle.read(buffer);
      if (!bytesRead) break;
      await new Promise((resolve, reject) =>
        destination.write(buffer.subarray(0, bytesRead), (error) =>
          error ? reject(error) : resolve(),
        ),
      );
    }
    destination.end();
    await done;
  } catch (error) {
    destination.destroy(error);
    await done.catch(() => {});
    throw error;
  } finally {
    signal?.removeEventListener("abort", abort);
    await handle?.close();
  }
}
