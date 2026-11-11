// @ts-check
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { dshHomeDir } from "../../vendor/dsh-qq/dsh-endpoint.mjs";

const maxLogBytes = 128 * 1024 * 1024;
const backendNames = new Set(["codex", "antigravity", "dsh"]);
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const roleName = /^[a-z][a-z0-9_-]{0,63}$/;
const zstdNames = /\.jsonl(?:\.zstd)?$/;
const sensitive =
  /((?:(?:x[-_])?(?:[a-z0-9]+[-_])*(?:capability|token|api[-_ ]?key|password|secret|cookie)|context|authorization)["']?\s*[:=]\s*["']?)(?:Bearer\s+)?[A-Za-z0-9_./+=:-]{16,}|\bBearer\s+[A-Za-z0-9_./+=:-]{16,}|\b(?:sk-|gh[pousr]_|github_pat_)[a-zA-Z0-9_-]{16,}\b|(?<![A-Za-z0-9_-])[A-Za-z0-9_-]{43}(?![A-Za-z0-9_-])/gi;

/** @typedef {{at: number, kind: "input" | "output" | "thinking" | "summary" | "tool" | "tool-error", text: string, order: number, nativeTurn?: string}} LogEntry */

/** @param {string} backend @param {unknown} id */
export function validLocalSession(backend, id) {
  return (
    backendNames.has(backend) &&
    typeof id === "string" &&
    uuid.test(backend === "dsh" && id.startsWith("session-") ? id.slice(8) : id)
  );
}

/** @param {unknown} text */
export function sessionDisplayText(text) {
  return typeof text === "string"
    ? text.replace(sensitive, (_, key) => (key || "") + "[凭据已隐藏]")
    : "";
}

/** @param {any} content @param {string[]} [types] */
function blocks(content, types = ["text", "input_text", "output_text"]) {
  if (!Array.isArray(content)) return sessionDisplayText(content);
  return sessionDisplayText(
    content
      .flatMap((item) =>
        typeof item === "string"
          ? [item]
          : types.includes(item?.type) && typeof item.text === "string"
            ? [item.text]
            : [],
      )
      .join("\n"),
  );
}

/** @param {unknown} value */
function toolName(value) {
  return typeof value === "string" && /^[A-Za-z0-9_./:-]{1,100}$/.test(value)
    ? value
    : "";
}

/** @param {unknown} value */
function millis(value) {
  return typeof value === "number"
    ? value
    : typeof value === "string"
      ? Date.parse(value)
      : NaN;
}

/** @param {string} root @param {...string} parts */
async function ownedPath(root, ...parts) {
  try {
    const base = await fsp.realpath(root);
    const file = path.join(base, ...parts);
    const relative = path.relative(base, file);
    if (relative === ".." || relative.startsWith(".." + path.sep))
      return undefined;
    return (await fsp.realpath(file)) === file ? file : undefined;
  } catch {
    return undefined;
  }
}

/** @param {string | undefined} root @param {(entry: import("node:fs").Dirent)=>boolean} matches @param {boolean} [recursive] */
async function findLogs(root, matches, recursive = false) {
  if (!root) return [];
  try {
    const entries = await fsp.readdir(root, { withFileTypes: true, recursive });
    const candidates = await Promise.all(
      entries
        .filter((entry) => entry.isFile() && matches(entry))
        .map((entry) =>
          ownedPath(
            root,
            path.relative(root, path.join(entry.parentPath, entry.name)),
          ),
        ),
    );
    return candidates.filter((file) => file !== undefined).sort();
  } catch {
    return [];
  }
}

/** @param {string} file @param {(value: any)=>void} visit @param {AbortSignal} [signal] */
async function scan(file, visit, signal) {
  let bytes = 0;
  let failed = false;
  // Desktop DSH writes concatenated frames. Node's decoder can stop at the
  // first frame, while the zstd CLI streams the full journal without buffering it.
  const child = file.endsWith(".zstd")
    ? spawn("zstd", ["-dc", "--", file], {
        windowsHide: true,
        stdio: ["ignore", "pipe", "ignore"],
        signal,
      })
    : undefined;
  const input = child?.stdout || fs.createReadStream(file, { signal });
  const exit = child
    ? new Promise((resolve) => {
        child.on("error", () => {
          failed = true;
          input.destroy();
        });
        child.once("close", (code) => resolve(code === 0));
      })
    : undefined;
  const reader = createInterface({ input, crlfDelay: Infinity });
  input.on("data", (/** @type {Buffer} */ chunk) => {
    bytes += chunk.length;
    if (bytes > maxLogBytes) {
      failed = true;
      input.destroy();
      child?.kill();
      reader.close();
    }
  });
  input.on("error", () => {
    failed = true;
    reader.close();
  });
  try {
    for await (const line of reader) {
      if (failed || signal?.aborted) break;
      // A backend can be in the middle of appending the last line.
      let record;
      try {
        record = JSON.parse(line);
      } catch {
        continue;
      }
      if (record && typeof record === "object") visit(record);
    }
  } catch {
    failed = true;
  } finally {
    reader.close();
    if (failed || signal?.aborted) child?.kill();
    input.destroy();
  }
  return (!exit || (await exit)) && !failed && !signal?.aborted;
}

/** @param {string} root @param {string} agentId @param {string} backend @param {string} sid */
async function sessionFiles(root, agentId, backend, sid) {
  if (backend === "codex") {
    const home = await ownedPath(root, "codex", agentId, "home");
    if (!home) return [];
    const directories = await Promise.all(
      ["sessions", "archived_sessions"].map((name) => ownedPath(home, name)),
    );
    return (
      await Promise.all(
        directories.map((dir) =>
          findLogs(dir, (entry) => entry.name.endsWith(`-${sid}.jsonl`), true),
        ),
      )
    ).flat();
  }
  if (backend === "antigravity") {
    const brain = await ownedPath(
      root,
      "antigravity",
      agentId,
      "profile",
      "cli",
      "brain",
      sid,
    );
    const files = await findLogs(
      brain,
      (entry) => entry.name.endsWith(".jsonl"),
      true,
    );
    const complete = files.filter(
      (file) => path.basename(path.dirname(file)) === "logs",
    );
    return complete.length ? complete : files;
  }
  const workspace = path.join(root, "dsh-workspaces", agentId);
  const folder =
    "--" + workspace.replace(/^[\\/]+/, "").replace(/[\\/:]/g, "-") + "--";
  return findLogs(
    await ownedPath(dshHomeDir(), "sessions", folder, sid),
    (entry) => zstdNames.test(entry.name),
  );
}

/** @param {any} record @param {(at: number, kind: LogEntry["kind"], text: string, turn?: string, order?: number)=>void} add @param {{turn?: string}} state */
function codex(record, add, state) {
  const at = millis(record.timestamp);
  const value = record.payload;
  if (!value || typeof value !== "object") return;
  if (record.type === "event_msg") {
    if (value.type === "task_started") state.turn = value.turn_id;
    const item = value.item;
    if (value.type === "item_completed" && item?.type === "Reasoning") {
      add(
        at,
        "thinking",
        blocks(item.raw_content, ["reasoning_text", "text"]),
        state.turn,
      );
      add(
        at,
        "summary",
        blocks(item.summary_text, ["summary_text", "text"]),
        state.turn,
      );
    }
    if (value.type === "task_complete") delete state.turn;
  }
  if (record.type !== "response_item") return;
  if (value.type === "message") {
    if (value.role === "user")
      add(at, "input", blocks(value.content), state.turn);
    if (value.role === "assistant")
      add(at, "output", blocks(value.content), state.turn);
  } else if (["function_call", "custom_tool_call"].includes(value.type)) {
    add(at, "tool", toolName(value.name), state.turn);
  } else if (value.type === "reasoning") {
    add(
      at,
      "summary",
      blocks(value.summary, ["summary_text", "text"]),
      state.turn,
    );
  }
}

/** @param {any} record @param {(at: number, kind: LogEntry["kind"], text: string, turn?: string, order?: number)=>void} add */
function antigravity(record, add) {
  const at = millis(record.created_at),
    order = record.step_index;
  if (record.type === "USER_INPUT") {
    add(at, "input", blocks(record.content), undefined, order);
  } else if (record.type === "PLANNER_RESPONSE") {
    add(at, "thinking", blocks(record.thinking), undefined, order);
    if (Array.isArray(record.tool_calls))
      for (const tool of record.tool_calls)
        add(at, "tool", toolName(tool?.name), undefined, order);
    add(at, "output", blocks(record.content), undefined, order);
  } else if (
    record.type === "ERROR_MESSAGE" ||
    (record.type === "GENERIC" && record.status === "ERROR")
  ) {
    // Native error details can contain paths, credentials, or model input.
    const error = JSON.stringify(
      record.error || record.content || "",
    ).toLowerCase();
    add(
      at,
      "tool-error",
      /unknown tool|no tool named|tool not registered/.test(error)
        ? "NATIVE_TOOL_UNAVAILABLE"
        : "NATIVE_TOOL_ERROR",
      undefined,
      order,
    );
  }
}

/** @param {any} record @param {(at: number, kind: LogEntry["kind"], text: string, turn?: string, order?: number)=>void} add @param {{turn?: string}} state */
function dsh(record, add, state) {
  const data = record.data;
  if (!data || typeof data !== "object") return;
  const at = millis(record.time),
    order = record.seq;
  if (record.type === "turn/start") state.turn = String(data.turn);
  if (record.type === "turn/end") delete state.turn;
  const turn = data.turn == null ? state.turn : String(data.turn);
  if (record.type === "user/message")
    add(at, "input", blocks(data.content), turn, order);
  if (record.type === "assistant/message") {
    add(
      at,
      "thinking",
      blocks(data.message?.content, ["reasoning", "thinking"]),
      turn,
      order,
    );
    add(at, "output", blocks(data.message?.content), turn, order);
  }
  if (record.type === "tool/call") {
    let name = toolName(data.name);
    if (name.endsWith("__bridge_call")) {
      try {
        name = toolName(JSON.parse(data.arguments)?.name) || name;
      } catch {
        // Record the safe tool name when the adapter did not receive valid arguments.
      }
    }
    add(at, "tool", name, turn, order);
  }
  if (record.type === "tool/result" && data.error)
    add(at, "tool-error", "NATIVE_TOOL_ERROR", turn, order);
}

/** @param {{root: string, agentId: string, backend: string, sid: string, from: number, until: number, signal?: AbortSignal}} query */
export async function readLocalSession({
  root,
  agentId,
  backend,
  sid,
  from,
  until,
  signal,
}) {
  if (!validLocalSession(backend, sid) || !roleName.test(agentId))
    return { entries: [], source: "unavailable" };
  const files = await sessionFiles(root, agentId, backend, sid);
  if (!files.length) return { entries: [], source: "unavailable" };
  /** @type {LogEntry[]} */
  const entries = [];
  const seen = new Set();
  let complete = true;
  let size = 0;
  /** @param {number} at @param {LogEntry["kind"]} kind @param {string} text @param {string} [nativeTurn] @param {number} [order] */
  const add = (at, kind, text, nativeTurn, order = 0) => {
    if (!(at >= from && at <= until) || !text) return;
    const key = `${at}/${order}/${kind}/${text}`;
    if (seen.has(key)) return;
    if (size + text.length > 2_000_000 || entries.length >= 2400) {
      complete = false;
      return;
    }
    size += text.length;
    seen.add(key);
    entries.push({ at, kind, text, nativeTurn, order });
  };
  for (const file of files) {
    if (signal?.aborted) {
      complete = false;
      break;
    }
    const state = {};
    const parser =
      backend === "codex" ? codex : backend === "dsh" ? dsh : antigravity;
    const read = await scan(
      file,
      (record) => parser(record, add, state),
      signal,
    );
    complete &&= read;
  }
  entries.sort((a, b) => a.at - b.at || a.order - b.order);
  return {
    entries,
    source: complete ? "available" : entries.length ? "partial" : "unavailable",
  };
}
