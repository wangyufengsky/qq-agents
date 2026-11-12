import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { nativeDesktopVersion } from "../../src/home/desktop-dependencies.mjs";

const protocol = "2.6";
const maxOutputBytes = 1024 * 1024;
const maxElements = 60;
const refLifetimeMs = 20_000;
const windowId = /^w-[a-zA-Z0-9_-]{1,80}$/;
const snapshotId = /^[a-zA-Z0-9_-]{1,80}$/;
const deliveryStates = new Set([
  "unknown",
  "not_delivered",
  "delivery_uncertain",
  "delivered_unverified",
  "delivered_verified",
]);
const refusalCodes = {
  AMBIGUOUS_TARGET: "DESKTOP_NATIVE_AMBIGUOUS",
  STALE_REF: "DESKTOP_NATIVE_STALE",
  APP_NOT_FOUND: "DESKTOP_NATIVE_TARGET_CHANGED",
  WINDOW_NOT_FOUND: "DESKTOP_NATIVE_TARGET_CHANGED",
  ACCESSIBILITY_DENIED: "DESKTOP_NATIVE_PERMISSION",
  PERMISSION_DENIED: "DESKTOP_NATIVE_PERMISSION",
  POLICY_DENIED: "DESKTOP_NATIVE_UNSUPPORTED",
  PLATFORM_NOT_SUPPORTED: "DESKTOP_NATIVE_UNSUPPORTED",
  ACTION_NOT_SUPPORTED: "DESKTOP_NATIVE_UNSUPPORTED",
  TIMEOUT: "DESKTOP_NATIVE_TIMEOUT",
};

function fail(code) {
  throw Error(code);
}

function childEnvironment(root, parent) {
  const env = { AGENT_DESKTOP_HOME: root };
  const allowed = new Set([
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "SYSTEMROOT",
    "WINDIR",
    "SYSTEMDRIVE",
    "TEMP",
    "TMP",
    "TMPDIR",
    "__CF_USER_TEXT_ENCODING",
  ]);
  for (const [key, value] of Object.entries(parent)) {
    if (allowed.has(key.toUpperCase()) && typeof value === "string")
      env[key] = value;
  }
  return env;
}

function runCommand(
  spawnProcess,
  executable,
  env,
  args,
  input,
  signal,
  timeoutMs,
) {
  if (signal.aborted) fail("DESKTOP_NATIVE_CANCELLED");
  return new Promise((resolve) => {
    let child;
    try {
      // A private root without a session manifest keeps upstream tracing off.
      child = spawnProcess(executable, args, {
        env,
        shell: false,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch {
      resolve({ code: "DESKTOP_NATIVE_UNAVAILABLE", started: false });
      return;
    }
    const chunks = [];
    let bytes = 0;
    let started = false;
    let failure;
    function stop(code) {
      if (failure) return;
      failure = code;
      child.kill("SIGKILL");
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
    }
    function onAbort() {
      stop("DESKTOP_NATIVE_CANCELLED");
    }
    function collect(chunk, keep) {
      bytes += chunk.length;
      if (bytes > maxOutputBytes) stop("DESKTOP_NATIVE_OUTPUT_LIMIT");
      else if (keep) chunks.push(chunk);
    }
    const deadline = setTimeout(
      () => stop("DESKTOP_NATIVE_TIMEOUT"),
      timeoutMs,
    );
    deadline.unref();
    signal.addEventListener("abort", onAbort, { once: true });
    child.once("spawn", () => {
      started = true;
    });
    child.on("error", () => {
      failure ||= "DESKTOP_NATIVE_UNAVAILABLE";
    });
    child.stdin.on("error", () => {
      // The native process may refuse the command before consuming stdin.
    });
    child.stdout.on("data", (chunk) => collect(chunk, true));
    child.stderr.on("data", (chunk) => collect(chunk, false));
    child.once("close", (exitCode) => {
      clearTimeout(deadline);
      signal.removeEventListener("abort", onAbort);
      if (signal.aborted) failure ||= "DESKTOP_NATIVE_CANCELLED";
      if (failure) {
        resolve({ code: failure, started });
        return;
      }
      try {
        const response = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        if (
          response?.version !== protocol ||
          response.command !== args[0] ||
          typeof response.ok !== "boolean" ||
          (response.ok &&
            (exitCode !== 0 ||
              !response.data ||
              typeof response.data !== "object")) ||
          (!response.ok &&
            (!response.error || typeof response.error.code !== "string"))
        )
          fail("DESKTOP_NATIVE_BAD_RESPONSE");
        resolve({ response, started });
      } catch {
        resolve({ code: "DESKTOP_NATIVE_BAD_RESPONSE", started });
      }
    });
    if (signal.aborted) onAbort();
    else child.stdin.end(input);
  });
}

function dataOf({ response, code }) {
  if (!response?.ok)
    fail(
      code ||
        Object.getOwnPropertyDescriptor(refusalCodes, response?.error?.code)
          ?.value ||
        "DESKTOP_NATIVE_FAILED",
    );
  return response.data;
}

function selectableApplication(app, pid, processInstance) {
  return (
    Number.isSafeInteger(pid) &&
    pid > 0 &&
    typeof processInstance === "string" &&
    processInstance.length > 0 &&
    processInstance.length <= 256 &&
    typeof app === "string" &&
    app.length > 0 &&
    app.length <= 256 &&
    !app.includes("\0")
  );
}

function selectableWindow(window) {
  return (
    window &&
    typeof window.id === "string" &&
    windowId.test(window.id) &&
    selectableApplication(
      window.app_name,
      window.pid,
      window.process_instance,
    ) &&
    window.accessible === true &&
    window.visible !== false &&
    window.minimized !== true
  );
}

function sameWindow(window, target) {
  return (
    window.id === target.id &&
    window.pid === target.pid &&
    window.processInstance === target.processInstance &&
    window.app === target.app
  );
}

function collectElements(tree, snapshot, refs) {
  const elements = [];
  const nodes = [tree];
  const seen = new Set();
  const prefix = "@" + snapshot + ":";
  let count = 0;
  let truncated = false;
  while (nodes.length) {
    const node = nodes.pop();
    if (
      !node ||
      typeof node.role !== "string" ||
      !/^[a-zA-Z0-9_ -]{1,100}$/.test(node.role) ||
      (node.children !== undefined && !Array.isArray(node.children)) ||
      (node.states !== undefined &&
        (!Array.isArray(node.states) ||
          node.states.some((state) => typeof state !== "string"))) ||
      ++count > 12_000
    )
      fail("DESKTOP_NATIVE_BAD_RESPONSE");
    if (node.states?.includes("secure") || /secure|password/i.test(node.role))
      continue;
    const label =
      typeof node.name === "string"
        ? node.name.replace(/[\p{Cc}\p{Cf}]/gu, " ").slice(0, 240)
        : "";
    const element = { role: node.role, ...(label && { label }) };
    if (node.ref_id !== undefined) {
      if (
        typeof node.ref_id !== "string" ||
        !node.ref_id.startsWith(prefix) ||
        !/^e[1-9][0-9]{0,7}$/.test(node.ref_id.slice(prefix.length)) ||
        seen.has(node.ref_id)
      )
        fail("DESKTOP_NATIVE_BAD_RESPONSE");
      seen.add(node.ref_id);
      if (elements.length < maxElements) {
        element.ref = randomUUID();
        refs.set(element.ref, {
          nativeRef: node.ref_id,
          role: node.role,
          readOnly: node.states?.includes("readonly"),
        });
      }
    }
    if (node.ref_id || label) {
      if (elements.length < maxElements) elements.push(element);
      else truncated = true;
    }
    if (node.children)
      for (let index = node.children.length - 1; index >= 0; index--)
        nodes.push(node.children[index]);
  }
  return { elements, truncated };
}

function actionCommand(action, ref) {
  switch (action.type) {
    case "click":
      return { args: ["click", ref.nativeRef] };
    case "set-value":
      if (
        typeof action.text !== "string" ||
        action.text.includes("\0") ||
        Buffer.byteLength(action.text) > 8192 ||
        !action.text.isWellFormed()
      )
        fail("DESKTOP_NATIVE_INVALID_ACTION");
      if (
        ref.readOnly ||
        !["textfield", "textarea", "text area"].includes(ref.role)
      )
        fail("DESKTOP_NATIVE_UNSUPPORTED");
      return {
        args: ["set-value", ref.nativeRef, "--stdin"],
        input: action.text,
      };
    case "scroll":
      if (
        !["up", "down", "left", "right"].includes(action.direction) ||
        !Number.isInteger(action.amount) ||
        action.amount < 1 ||
        action.amount > 5
      )
        fail("DESKTOP_NATIVE_INVALID_ACTION");
      return {
        args: [
          "scroll",
          ref.nativeRef,
          "--direction",
          action.direction,
          "--amount",
          String(action.amount),
        ],
      };
    default:
      fail("DESKTOP_NATIVE_INVALID_ACTION");
  }
}

function actionReceipt({ response, code, started }) {
  if (!response)
    return { ok: false, delivery: started ? "unknown" : "not_delivered", code };
  const result = response.ok ? response.data : response.error;
  const delivery = result.disposition?.delivery;
  if (!deliveryStates.has(delivery))
    return {
      ok: false,
      delivery: "unknown",
      code: "DESKTOP_NATIVE_BAD_RESPONSE",
    };
  if (!response.ok)
    return {
      ok: false,
      delivery,
      code:
        Object.getOwnPropertyDescriptor(refusalCodes, result.code)?.value ||
        "DESKTOP_NATIVE_FAILED",
    };
  return { ok: true, delivery };
}

/**
 * Owns native child execution. Call open once per operator authorization and
 * turn, and close the scope when either expires or is revoked.
 */
export function createNativeDesktopDriver({
  executable = process.env.QQ_AGENTS_AGENT_DESKTOP_EXECUTABLE,
  platform = process.platform,
  spawnProcess = spawn,
  timeoutMs = 6500,
  stateParent = tmpdir(),
  parentEnv = process.env,
  now = Date.now,
} = {}) {
  const shutdown = new AbortController();
  const scopes = new Set();
  let running;
  let closing;

  function execute(root, args, signal, input) {
    return runCommand(
      spawnProcess,
      executable,
      childEnvironment(root, parentEnv),
      args,
      input,
      signal,
      timeoutMs,
    );
  }
  function exclusive(signal, task) {
    if (signal.aborted) fail("DESKTOP_NATIVE_CANCELLED");
    if (!["darwin", "win32"].includes(platform))
      fail("DESKTOP_NATIVE_UNSUPPORTED");
    if (
      typeof executable !== "string" ||
      !isAbsolute(executable) ||
      (platform === "win32" && !executable.toLowerCase().endsWith(".exe"))
    )
      fail("DESKTOP_NATIVE_UNAVAILABLE");
    if (running) fail("DESKTOP_NATIVE_BUSY");
    const pending = Promise.resolve().then(task);
    running = pending;
    return pending.finally(() => {
      running = undefined;
    });
  }
  async function checkVersion(root, signal) {
    const data = dataOf(await execute(root, ["version"], signal));
    if (
      data.version !== nativeDesktopVersion ||
      data.os !== (platform === "win32" ? "windows" : "macos")
    )
      fail("DESKTOP_NATIVE_VERSION");
  }
  async function windows(root, signal, app) {
    const args = app ? ["list-windows", "--app=" + app] : ["list-windows"];
    const data = dataOf(await execute(root, args, signal));
    if (!Array.isArray(data)) fail("DESKTOP_NATIVE_BAD_RESPONSE");
    const candidates = data.filter(selectableWindow);
    const ids = new Map();
    for (const window of data)
      if (typeof window?.id === "string")
        ids.set(window.id, (ids.get(window.id) || 0) + 1);
    return candidates
      .filter((window) => ids.get(window.id) === 1)
      .map((window) => ({
        id: window.id,
        pid: window.pid,
        processInstance: window.process_instance,
        app: window.app_name,
        title:
          typeof window.title === "string" ? window.title.slice(0, 300) : "",
      }));
  }
  async function inventory(signal, operation) {
    const current = signal
      ? AbortSignal.any([signal, shutdown.signal])
      : shutdown.signal;
    return exclusive(current, async () => {
      const root = await mkdtemp(join(stateParent, "qq-native-"));
      try {
        await checkVersion(root, current);
        if (platform === "darwin") {
          const permissions = dataOf(
            await execute(root, ["permissions"], current),
          );
          if (permissions.accessibility?.state !== "granted")
            fail("DESKTOP_NATIVE_PERMISSION");
        }
        return await operation(root, current);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  }

  function listApplications({ signal } = {}) {
    return inventory(signal, async (root, current) => {
      const { apps } = dataOf(await execute(root, ["list-apps"], current));
      if (!Array.isArray(apps)) fail("DESKTOP_NATIVE_BAD_RESPONSE");
      return apps
        .filter(
          (app) =>
            app?.presentation === "foreground" &&
            selectableApplication(app.name, app.pid, app.process_instance),
        )
        .slice(0, 200)
        .map(({ name: app, pid, process_instance: processInstance }) => ({
          app,
          pid,
          processInstance,
        }));
    });
  }

  function listWindows({ signal, application } = {}) {
    if (
      application &&
      !selectableApplication(
        application.app,
        application.pid,
        application.processInstance,
      )
    )
      fail("DESKTOP_NATIVE_TARGET_CHANGED");
    return inventory(signal, async (root, current) => {
      const available = await windows(root, current, application?.app);
      return (
        application
          ? available.filter(
              (window) =>
                window.pid === application.pid &&
                window.processInstance === application.processInstance,
            )
          : available
      ).slice(0, 200);
    });
  }

  function open(selection) {
    if (shutdown.signal.aborted) fail("DESKTOP_NATIVE_CANCELLED");
    if (
      !selection ||
      !selectableWindow({
        id: selection.id,
        pid: selection.pid,
        process_instance: selection.processInstance,
        app_name: selection.app,
        accessible: true,
      })
    )
      fail("DESKTOP_NATIVE_TARGET_CHANGED");
    const { id, pid, processInstance, app } = selection;
    const target = { id, pid, processInstance, app };
    const lifecycle = new AbortController();
    const active = AbortSignal.any([shutdown.signal, lifecycle.signal]);
    let root;
    let ready = false;
    let pending;
    let closeScope;
    let refs = new Map();
    let expiresAt = 0;
    async function verifyTarget(current) {
      if (
        !(await windows(root, current, app)).some((window) =>
          sameWindow(window, target),
        )
      )
        fail("DESKTOP_NATIVE_TARGET_CHANGED");
    }
    function work(signal, task) {
      const current = signal ? AbortSignal.any([signal, active]) : active;
      const request = exclusive(current, () => task(current));
      pending = request;
      return request.finally(() => {
        pending = undefined;
      });
    }
    const scope = {
      async observe({ signal } = {}) {
        return work(signal, async (current) => {
          refs.clear();
          root ??= await mkdtemp(join(stateParent, "qq-native-"));
          if (!ready) {
            await checkVersion(root, current);
            ready = true;
          }
          await verifyTarget(current);
          const data = dataOf(
            await execute(
              root,
              [
                "snapshot",
                "--app=" + app,
                "--window-id",
                id,
                "--surface",
                "window",
              ],
              current,
            ),
          );
          if (data.complete !== true || data.identity_unproven === true)
            fail("DESKTOP_NATIVE_AMBIGUOUS");
          if (data.window?.id !== id || data.app !== app)
            fail("DESKTOP_NATIVE_TARGET_CHANGED");
          if (
            typeof data.snapshot_id !== "string" ||
            !snapshotId.test(data.snapshot_id)
          )
            fail("DESKTOP_NATIVE_BAD_RESPONSE");
          await verifyTarget(current);
          if (current.aborted) fail("DESKTOP_NATIVE_CANCELLED");
          const nextRefs = new Map();
          const result = collectElements(data.tree, data.snapshot_id, nextRefs);
          refs = nextRefs;
          expiresAt = now() + refLifetimeMs;
          return result;
        });
      },
      async act(action, { signal, beforeDispatch } = {}) {
        return work(signal, async (current) => {
          const ref = refs.get(action?.ref);
          if (!ref || now() >= expiresAt) fail("DESKTOP_NATIVE_STALE");
          const { args, input } = actionCommand(action, ref);
          refs.clear();
          await verifyTarget(current);
          const live = dataOf(
            await execute(
              root,
              ["get", ref.nativeRef, "--property", "states"],
              current,
            ),
          );
          if (
            live.ref !== ref.nativeRef ||
            live.property !== "states" ||
            !Array.isArray(live.value) ||
            live.value.some((state) => typeof state !== "string")
          )
            fail("DESKTOP_NATIVE_BAD_RESPONSE");
          if (live.value.includes("secure")) fail("DESKTOP_NATIVE_UNSUPPORTED");
          if (now() >= expiresAt) fail("DESKTOP_NATIVE_STALE");
          if (typeof beforeDispatch !== "function" || !(await beforeDispatch()))
            return {
              ok: false,
              delivery: "not_delivered",
              code: "DESKTOP_NATIVE_CANCELLED",
            };
          if (current.aborted) fail("DESKTOP_NATIVE_CANCELLED");
          if (now() >= expiresAt) fail("DESKTOP_NATIVE_STALE");
          return actionReceipt(await execute(root, args, current, input));
        });
      },
      close() {
        closeScope ??= (async () => {
          lifecycle.abort();
          refs.clear();
          await pending?.catch(() => {});
          scopes.delete(scope);
          if (root) await rm(root, { recursive: true, force: true });
        })();
        return closeScope;
      },
    };
    scopes.add(scope);
    return scope;
  }

  return {
    listApplications,
    listWindows,
    open,
    close() {
      closing ??= (async () => {
        shutdown.abort();
        await Promise.all([
          running?.catch(() => {}),
          ...[...scopes].map((scope) => scope.close()),
        ]);
      })();
      return closing;
    },
  };
}
