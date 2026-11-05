// @ts-check
import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
const delay = (/** @type {number} */ ms) =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** @param {number} pid */
function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code === "ESRCH")
      return false;
    throw error;
  }
}
/** @param {string} controlFile @param {{nonce:string}} control */
async function jobSettled(controlFile, control) {
  if (process.platform !== "win32") return true;
  let established = false;
  try {
    const ready = JSON.parse(
      await fs.readFile(controlFile + ".job-ready", "utf8"),
    );
    established = true;
    const complete = JSON.parse(
      await fs.readFile(controlFile + ".job-clean", "utf8"),
    );
    return (
      complete.cleaned === true &&
      complete.nonce === control.nonce &&
      complete.parentPid === ready.parentPid &&
      complete.helperPid === ready.helperPid &&
      ready.nonce === control.nonce &&
      Number.isSafeInteger(ready.helperPid) &&
      !alive(ready.helperPid)
    );
  } catch (error) {
    // No native ready receipt means the wrapper could not start a browser.
    return (
      !established &&
      /** @type {NodeJS.ErrnoException} */ (error).code === "ENOENT"
    );
  }
}

/** Authenticate to the live wrapper; PID is only used to confirm exit, never kill.
 * @param {string} marker @param {{endpoint:string,nonce:string}} control */
export async function stopHomeBrowser(marker, control) {
  const controlFile = path.join(path.dirname(marker), "control.json");
  const temporary = controlFile + ".stopping";
  await fs.writeFile(
    temporary,
    JSON.stringify({ ...control, stopping: true }),
    { mode: 0o600, flag: "wx" },
  );
  await fs.rename(temporary, controlFile);
  const deadline = Date.now() + (process.platform === "win32" ? 3000 : 1000);
  let pid = 0;
  while (Date.now() < deadline) {
    try {
      pid = Number(await fs.readFile(marker, "utf8"));
    } catch (error) {
      if (/** @type {NodeJS.ErrnoException} */ (error).code !== "ENOENT")
        throw error;
    }
    if (pid > 0 && !alive(pid) && (await jobSettled(controlFile, control)))
      return;
    const accepted = await new Promise((resolve) => {
      const socket = net.connect(control.endpoint);
      let response = "";
      const finish = (/** @type {boolean} */ value) => {
        socket.destroy();
        resolve(value);
      };
      socket.setTimeout(100, () => finish(false));
      socket.on("error", () => finish(false));
      socket.on("close", () => finish(false));
      socket.on("connect", () => socket.write(control.nonce + "\n"));
      socket.on("data", (data) => {
        response += data;
        if (response.includes("stopping\n")) finish(true);
      });
    });
    if (accepted) break;
    await delay(10);
  }
  // No marker means no browser was spawned: both entry and pre-spawn checks
  // reject this tombstone, and a removed directory also fails closed.
  if (!pid) return;
  while (Date.now() < deadline) {
    if (!alive(pid) && (await jobSettled(controlFile, control))) return;
    await delay(10);
  }
  throw Error("HOME_SCENE_RENDER_FAILED", {
    cause: await homeBrowserStatus(marker, control),
  });
}

/** Fixed flags for the packaged renderer; never accepted from bridge arguments.
 * @param {string} profile */
export function homeBrowserArguments(profile) {
  return [
    "--headless",
    "--hide-scrollbars",
    "--mute-audio",
    "--no-sandbox",
    "--disable-background-networking",
    "--disable-component-update",
    "--disable-default-apps",
    "--disable-extensions",
    "--disable-sync",
    "--disable-dev-shm-usage",
    "--no-first-run",
    "--no-default-browser-check",
    "--password-store=basic",
    "--use-mock-keychain",
    "--remote-debugging-pipe",
    "--no-startup-window",
    `--user-data-dir=${profile}`,
  ];
}

/** Only fixed stages, numeric errors and status booleans enter diagnostics.
 * @param {string} marker @param {{nonce:string}} control */
export async function homeBrowserStatus(marker, control) {
  const controlFile = path.join(path.dirname(marker), "control.json");
  const read = async (/** @type {string} */ suffix) => {
    try {
      return JSON.parse(await fs.readFile(controlFile + suffix, "utf8"));
    } catch {
      return null;
    }
  };
  const state = await read(".job-state"),
    ready = await read(".job-ready"),
    complete = await read(".job-clean"),
    setup = await read(".job-launch-state"),
    child = await read(".browser-state");
  const stage = (/** @type {any} */ value) =>
    typeof value?.stage === "string" && /^[a-z-]{1,64}$/.test(value.stage)
      ? value.stage
      : "unavailable";
  let pid = 0;
  try {
    pid = Number(await fs.readFile(marker, "utf8"));
  } catch {
    /* No PID means startup did not announce itself. */
  }
  return {
    stage: stage(state),
    code: Number.isInteger(state?.code) ? state.code : 0,
    active: Number.isInteger(state?.active) ? state.active : -1,
    setup: stage(setup),
    child: stage(child),
    childCode: Number.isInteger(child?.code) ? child.code : null,
    ready: ready?.nonce === control.nonce,
    clean: complete?.nonce === control.nonce && complete.cleaned === true,
    wrapperAlive: Number.isSafeInteger(pid) && pid > 0 ? alive(pid) : false,
    helperAlive: Number.isSafeInteger(ready?.helperPid)
      ? alive(ready.helperPid)
      : false,
  };
}
