import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import { execFileSync, spawn } from "node:child_process";

export const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
export function writeJson(file, value) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(tmp, file);
}
export function processIdentity(pid) {
  if (!Number.isInteger(pid) || pid <= 1) return null;
  try {
    const get = (field) =>
      execFileSync("/bin/ps", ["-p", String(pid), "-o", field + "="], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
    const command = get("command"),
      born = get("lstart"),
      pgid = Number(get("pgid"));
    return command && born ? { command, born, pgid } : null;
  } catch {
    return null;
  }
}
export function ownsProcess(record, identity, command, scope) {
  return (
    !!record &&
    !!identity &&
    record.pid === identity.pgid &&
    record.born === identity.born &&
    identity.command === command &&
    record.scope === scope
  );
}
export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export async function portBusy(port) {
  return new Promise((resolve) => {
    const s = net.connect({ host: "127.0.0.1", port });
    const end = (value) => {
      s.destroy();
      resolve(value);
    };
    s.once("connect", () => end(true));
    s.once("error", () => end(false));
    s.setTimeout(1000, () => end(false));
  });
}
export function nativeProfile(entry) {
  if (
    !/^[a-z][a-z0-9_-]*$/.test(entry.id) ||
    !/^\d{1,20}$/.test(entry.accountId) ||
    !path.isAbsolute(entry.workdir)
  )
    throw Error("INVALID_NATIVE_PROFILE");
  const workdir = fs.realpathSync(entry.workdir);
  const config = readJson(
    path.join(workdir, "config", `onebot11_${entry.accountId}.json`),
  );
  const http = config.network?.httpServers?.filter((x) => x.enable) || [];
  const ws = config.network?.websocketServers?.filter((x) => x.enable) || [];
  const web = readJson(path.join(workdir, "config/webui.json"));
  if (http.length !== 1 || ws.length !== 1)
    throw Error("NATIVE_ENDPOINTS_AMBIGUOUS");
  for (const s of [http[0], ws[0], web]) {
    if (
      s.host !== "127.0.0.1" ||
      !Number.isInteger(s.port) ||
      s.port < 1024 ||
      s.port > 65535 ||
      !s.token
    )
      throw Error("NATIVE_LOOPBACK_AUTH_REQUIRED");
  }
  const ports = [http[0].port, ws[0].port, web.port];
  if (new Set(ports).size !== ports.length)
    throw Error("NATIVE_PORT_COLLISION");
  return {
    ...entry,
    workdir,
    ports,
    webPort: web.port,
    httpUrl: `http://127.0.0.1:${http[0].port}`,
    wsUrl: `ws://127.0.0.1:${ws[0].port}`,
  };
}
export function nativeEnv(parent, profile) {
  const allowed = [
    "HOME",
    "USER",
    "LOGNAME",
    "PATH",
    "TMPDIR",
    "LANG",
    "LC_ALL",
    "SHELL",
    "__CF_USER_TEXT_ENCODING",
  ];
  return {
    ...Object.fromEntries(
      allowed.filter((k) => parent[k] !== undefined).map((k) => [k, parent[k]]),
    ),
    NAPCAT_WORKDIR: profile.workdir,
    NAPCAT_QUICK_ACCOUNT: profile.accountId,
    NAPCAT_WEBUI_PREFERRED_PORT: String(profile.webPort),
    NAPCAT_DISABLE_TIME_SYNC: "1",
  };
}
export class NativeQQ {
  constructor(
    entries,
    {
      identity = processIdentity,
      busy = portBusy,
      launch = spawn,
      kill = process.kill.bind(process),
      wait = sleep,
      fetchImpl = fetch,
      now = Date.now,
    } = {},
  ) {
    this.profiles = entries.map(nativeProfile);
    const ports = this.profiles.flatMap((p) => p.ports);
    if (new Set(ports).size !== ports.length)
      throw Error("NATIVE_PORT_COLLISION");
    Object.assign(this, {
      identity,
      busy,
      launch,
      kill,
      wait,
      fetch: fetchImpl,
      now,
    });
  }
  record(p) {
    const file = path.join(p.workdir, "process.json");
    return fs.existsSync(file) ? readJson(file) : null;
  }
  owns(p, record, identity) {
    // Accept the explicitly configured legacy record format without broad PID adoption.
    let workdir;
    try {
      workdir = fs.realpathSync(record?.workdir);
    } catch {
      return false;
    }
    return (
      record?.account === p.accountId &&
      workdir === p.workdir &&
      ownsProcess(
        { ...record, scope: workdir },
        identity,
        `/Applications/QQ.app/Contents/MacOS/QQ --no-sandbox -q ${p.accountId}`,
        p.workdir,
      )
    );
  }
  status(p) {
    const r = this.record(p),
      i = this.identity(r?.pid);
    return {
      id: p.id,
      running: !!i,
      owned: this.owns(p, r, i),
      webUrl: `http://127.0.0.1:${p.webPort}`,
    };
  }
  async start() {
    for (const p of this.profiles) {
      const r = this.record(p),
        i = this.identity(r?.pid);
      if (i) {
        if (!this.owns(p, r, i)) throw Error("NATIVE_PID_OWNERSHIP_MISMATCH");
        continue;
      }
      for (const port of p.ports)
        if (await this.busy(port)) throw Error("NATIVE_PORT_ALREADY_IN_USE");
      const fd = fs.openSync(path.join(p.workdir, "stdout.log"), "a", 0o600);
      let child;
      try {
        child = this.launch(
          "/Applications/QQ.app/Contents/MacOS/QQ",
          ["--no-sandbox", "-q", p.accountId],
          {
            cwd: p.workdir,
            env: nativeEnv(process.env, p),
            detached: true,
            stdio: ["ignore", fd, fd],
          },
        );
      } finally {
        fs.closeSync(fd);
      }
      await new Promise((resolve, reject) => {
        child.once("spawn", resolve);
        child.once("error", () => reject(Error("NATIVE_START_FAILED")));
      });
      child.unref();
      const id = this.identity(child.pid);
      if (!id) throw Error("NATIVE_EXITED_DURING_START");
      const record = {
        pid: child.pid,
        born: id.born,
        account: p.accountId,
        workdir: p.workdir,
      };
      if (!this.owns(p, record, id))
        throw Error("NATIVE_PID_OWNERSHIP_MISMATCH");
      writeJson(path.join(p.workdir, "process.json"), record);
    }
  }
  async waitReady(ids, timeoutMs = 60000) {
    for (const p of this.profiles.filter((p) => ids.includes(p.id))) {
      const deadline = this.now() + timeoutMs;
      let offline = false;
      while (this.now() < deadline) {
        const r = this.record(p),
          i = this.identity(r?.pid);
        if (!i) throw Error("NATIVE_EXITED_DURING_START");
        if (!this.owns(p, r, i)) throw Error("NATIVE_PID_OWNERSHIP_MISMATCH");
        try {
          const config = readJson(
            path.join(p.workdir, "config", `onebot11_${p.accountId}.json`),
          );
          const endpoint = config.network.httpServers.find((x) => x.enable);
          const call = async (action) => {
            const response = await this.fetch(`${p.httpUrl}/${action}`, {
              method: "POST",
              headers: {
                authorization: `Bearer ${endpoint.token}`,
                "content-type": "application/json",
              },
              body: "{}",
              redirect: "error",
              signal: AbortSignal.timeout(
                Math.max(1, Math.min(3000, deadline - this.now())),
              ),
            });
            if (!response.ok) throw Error("NATIVE_READINESS_HTTP_ERROR");
            const body = await response.json().catch((error) => {
              if (["AbortError", "TimeoutError"].includes(error.name))
                throw error;
              throw Error("NATIVE_READINESS_INVALID_RESPONSE");
            });
            if (body.status !== "ok" || body.retcode !== 0)
              throw Error("NATIVE_READINESS_REJECTED");
            return body.data;
          };
          const status = await call("get_status");
          if (typeof status?.online !== "boolean")
            throw Error("NATIVE_READINESS_INVALID_RESPONSE");
          offline = !status.online;
          if (!offline) {
            const login = await call("get_login_info");
            if (String(login?.user_id) !== p.accountId)
              throw Error("NATIVE_ACCOUNT_MISMATCH");
            if (status.good === false) throw Error("NATIVE_NOT_HEALTHY");
            if (await this.busy(Number(new URL(p.wsUrl).port))) break;
          }
        } catch (error) {
          // Only endpoint startup/timeout failures are retryable; auth, account and protocol errors are terminal.
          if (
            !["ECONNREFUSED", "ECONNRESET"].includes(error.cause?.code) &&
            !["TimeoutError", "AbortError"].includes(error.name)
          )
            throw error;
        }
        await this.wait(Math.min(500, Math.max(0, deadline - this.now())));
      }
      if (this.now() >= deadline)
        throw Error(offline ? "NATIVE_LOGIN_REQUIRED" : "NATIVE_READY_TIMEOUT");
    }
  }
  async stop() {
    for (const p of this.profiles) {
      const r = this.record(p),
        i = this.identity(r?.pid);
      if (!i) continue;
      if (!this.owns(p, r, i)) throw Error("NATIVE_PID_OWNERSHIP_MISMATCH");
      this.kill(-r.pid, "SIGTERM");
      for (let n = 0; n < 50 && this.identity(r.pid); n++) await this.wait(200);
      if (this.identity(r.pid)) throw Error("NATIVE_STOP_INCOMPLETE");
      fs.rmSync(path.join(p.workdir, "process.json"));
    }
  }
}
