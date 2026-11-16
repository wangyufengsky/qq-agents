import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

let snapshotHelper;
let frameHelper;
async function compileHelper(source) {
  const directory = await mkdtemp(join(tmpdir(), "qq-capture-"));
  const executable = join(directory, "snapshot");
  try {
    await new Promise((resolve, reject) =>
      execFile(
        "/usr/bin/swiftc",
        [fileURLToPath(new URL(source, import.meta.url)), "-o", executable],
        { timeout: 30000 },
        (error) => (error ? reject(error) : resolve()),
      ),
    );
    process.once("exit", () =>
      rmSync(directory, { recursive: true, force: true }),
    );
    return executable;
  } catch {
    await rm(directory, { recursive: true, force: true });
    return undefined;
  }
}

// The snapshot helper returns metadata only, never titles or pixels.
export async function macosCaptureSnapshot({
  signal,
  execute = execFile,
  executable,
} = {}) {
  if (signal?.aborted) return { complete: false };
  const program =
    executable ??
    (await (snapshotHelper ??= compileHelper(
      "./macos-capture-snapshot.swift",
    )));
  if (!program || signal?.aborted) return { complete: false };
  return new Promise((resolve) => {
    execute(
      program,
      [],
      { signal, timeout: 2500, maxBuffer: 1024 * 1024, encoding: "utf8" },
      (error, stdout) => {
        if (error || signal?.aborted) return resolve({ complete: false });
        try {
          const value = JSON.parse(stdout);
          if (
            value?.complete !== true ||
            !Array.isArray(value.windows) ||
            !Number.isSafeInteger(value.foregroundPid)
          )
            return resolve({ complete: false });
          resolve(value);
        } catch {
          resolve({ complete: false });
        }
      },
    );
  });
}

export async function macosWindowFrame(
  identity,
  maxEdge,
  maxBytes,
  signal,
  { execute = execFile, executable } = {},
) {
  const windowId = /^w-([1-9][0-9]*)$/.exec(identity?.id)?.[1];
  if (
    !windowId ||
    !Number.isSafeInteger(identity.pid) ||
    identity.pid <= 0 ||
    signal.aborted
  )
    return;
  const program =
    executable ??
    (await (frameHelper ??= compileHelper("./macos-window-frame.swift")));
  if (!program || signal.aborted) return;
  return new Promise((resolve) => {
    execute(
      program,
      [windowId, String(identity.pid), String(maxEdge), String(maxBytes)],
      { signal, timeout: 4500, maxBuffer: maxBytes, encoding: "buffer" },
      (error, jpeg) => {
        if (signal.aborted) return resolve(undefined);
        if (error) return resolve({ permission: error.code === 2 });
        resolve(
          jpeg.length > 0 ? { data: jpeg.toString("base64") } : undefined,
        );
      },
    );
  });
}

// A classifier must explicitly classify every window owner before any frame.
export function macosCoverageSnapshot(snapshot, classify) {
  if (
    snapshot?.complete !== true ||
    !Array.isArray(snapshot.windows) ||
    !Number.isSafeInteger(snapshot.foregroundPid) ||
    snapshot.foregroundPid <= 0 ||
    typeof classify !== "function"
  )
    return { complete: false };
  const windows = [];
  let foregroundId;
  for (const entry of snapshot.windows) {
    if (
      !/^w-[1-9][0-9]*$/.test(entry?.id) ||
      !Number.isSafeInteger(entry.pid) ||
      entry.pid <= 0 ||
      !Number.isSafeInteger(entry.layer) ||
      typeof entry.owner !== "string" ||
      !entry.owner ||
      typeof entry.name !== "string" ||
      typeof entry.bundle !== "string"
    )
      return { complete: false };
    const sensitive = classify({
      owner: entry.owner,
      name: entry.name,
      bundle: entry.bundle,
      pid: entry.pid,
    });
    if (typeof sensitive !== "boolean") return { complete: false };
    if (!foregroundId && entry.pid === snapshot.foregroundPid)
      foregroundId = entry.id;
    windows.push({
      id: entry.id,
      bounds: entry.bounds,
      sensitive,
      ...(entry.dockSafeBounds && { dockSafeBounds: entry.dockSafeBounds }),
    });
  }
  if (!foregroundId) return { complete: false };
  return { complete: true, foregroundId, windows };
}
