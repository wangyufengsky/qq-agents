import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { EventEmitter } from "node:events";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { temp, fixture } from "./helpers.mjs";
import {
  NativeQQ,
  nativeEnv,
  nativeProfile,
  ownsProcess,
  writeJson,
} from "../scripts/lib/local-process.mjs";
const exec = promisify(execFile);
function profile(t, id = "fixture", offset = 0) {
  const workdir = temp(t),
    accountId = String(10001 + offset);
  fs.mkdirSync(path.join(workdir, "config"));
  const endpoint = (port) => ({
    host: "127.0.0.1",
    port,
    enable: true,
    token: "fixture-only",
  });
  writeJson(path.join(workdir, "config", `onebot11_${accountId}.json`), {
    network: {
      httpServers: [endpoint(23010 + offset * 10)],
      websocketServers: [endpoint(23011 + offset * 10)],
    },
  });
  writeJson(
    path.join(workdir, "config/webui.json"),
    endpoint(23012 + offset * 10),
  );
  return { id, accountId, workdir };
}
function record(p, pid) {
  return {
    pid,
    account: p.accountId,
    workdir: p.workdir,
    born: "fixture-start",
  };
}
function identity(p, pid) {
  return {
    pgid: pid,
    born: "fixture-start",
    command: `/Applications/QQ.app/Contents/MacOS/QQ --no-sandbox -q ${p.accountId}`,
  };
}
test("native launcher reuses verified legacy ownership and does not spawn a second QQ", async (t) => {
  const p = profile(t);
  writeJson(path.join(p.workdir, "process.json"), record(p, 100));
  const n = new NativeQQ([p], {
    identity: () => identity(p, 100),
    launch: () => {
      throw Error("unexpected spawn");
    },
  });
  await n.start();
  assert.equal(n.status(n.profiles[0]).owned, true);
});
test("native launcher rejects reused PIDs and never kills another process", async (t) => {
  const p = profile(t);
  writeJson(path.join(p.workdir, "process.json"), record(p, 100));
  let kills = 0;
  const n = new NativeQQ([p], {
    identity: () => ({ ...identity(p, 100), born: "different-start" }),
    kill: () => kills++,
  });
  await assert.rejects(n.start(), /OWNERSHIP/);
  await assert.rejects(n.stop(), /OWNERSHIP/);
  assert.equal(kills, 0);
  assert.equal(
    ownsProcess(
      { pid: 100, born: "fixture-start", scope: "a" },
      identity(p, 100),
      identity(p, 100).command,
      "b",
    ),
    false,
  );
});
test("native stop preserves peer QQ and profile files", async (t) => {
  const p = profile(t),
    peer = profile(t, "peer", 1);
  const alive = new Map([
    [100, identity(p, 100)],
    [200, identity(peer, 200)],
  ]);
  writeJson(path.join(p.workdir, "process.json"), record(p, 100));
  writeJson(path.join(peer.workdir, "process.json"), record(peer, 200));
  const n = new NativeQQ([p], {
    identity: (id) => alive.get(id),
    kill: (id) => alive.delete(-id),
    wait: async () => {},
  });
  await n.stop();
  assert.ok(alive.has(200));
  assert.ok(fs.existsSync(path.join(p.workdir, "config/webui.json")));
  assert.ok(fs.existsSync(path.join(peer.workdir, "process.json")));
});
test("native port conflict and invalid binding fail before spawn", async (t) => {
  const p = profile(t);
  const n = new NativeQQ([p], {
    identity: () => null,
    busy: async () => true,
    launch: () => {
      throw Error("unexpected spawn");
    },
  });
  await assert.rejects(n.start(), /PORT_ALREADY/);
  assert.throws(() => new NativeQQ([p, p]), /PORT_COLLISION/);
  const file = path.join(p.workdir, "config/webui.json");
  const x = JSON.parse(fs.readFileSync(file));
  x.host = "0.0.0.0";
  writeJson(file, x);
  assert.throws(() => nativeProfile(p), /LOOPBACK_AUTH/);
});
test("native start isolates environment and persists verified account ownership", async (t) => {
  const p = profile(t);
  let running = false,
    options;
  const n = new NativeQQ([p], {
    identity: () => (running ? identity(p, 100) : null),
    busy: async () => false,
    launch: (cmd, args, opts) => {
      options = opts;
      const child = new EventEmitter();
      child.pid = 100;
      child.unref = () => {};
      process.nextTick(() => {
        running = true;
        child.emit("spawn");
      });
      return child;
    },
  });
  await n.start();
  assert.equal(n.status(n.profiles[0]).owned, true);
  assert.equal(options.env.NAPCAT_QUICK_ACCOUNT, p.accountId);
  const env = nativeEnv(
    {
      HOME: "/fixture",
      DEEPSEEK_API_KEY: "private",
      QQ_UNIFIED_TOKEN: "private",
      PATH: "/bin",
    },
    n.profiles[0],
  );
  assert.equal(env.DEEPSEEK_API_KEY, undefined);
  assert.equal(env.QQ_UNIFIED_TOKEN, undefined);
});
test("launcher resume checks connections first, preserves agent pauses and never sends QQ", async (t) => {
  const root = temp(t),
    calls = [];
  const server = http.createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    calls.push({ path: req.url, body: body ? JSON.parse(body) : null });
    assert.equal(req.headers["x-admin-token"], "fixture");
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify(
        req.url === "/api/status"
          ? { connections: [{ id: "a", connected: true }], agents: [] }
          : { ok: true },
      ),
    );
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => server.close());
  writeJson(path.join(root, "config.json"), {
    port: server.address().port,
    connections: [{ id: "a", enabled: true }],
    agents: [
      { id: "active", paused: false },
      { id: "paused", paused: true },
    ],
  });
  fs.writeFileSync(path.join(root, "admin-token"), "fixture");
  await exec(process.execPath, [
    "scripts/robots.mjs",
    "start",
    "--data",
    root,
    "--resume",
  ]);
  assert.deepEqual(
    calls.filter((x) => x.path === "/api/models").map((x) => x.body.agentId),
    ["active"],
  );
  assert.deepEqual(
    calls.filter((x) => x.path === "/api/pause").map((x) => x.body),
    [{ paused: false }],
  );
  assert.equal(
    calls.some((x) => x.path.includes("send")),
    false,
  );
  assert.ok(
    calls.findIndex((x) => x.path === "/api/pause") >
      calls.findIndex((x) => x.path === "/api/models"),
  );
});
test("successful retry clears stale backend error while safe DSH error is diagnosable", async (t) => {
  let failure = true;
  const f = fixture(t, {
    run: async () => {
      if (failure) throw Error("DSH_UNIFIED_PRESET_BROKEN");
    },
  });
  await f.runtime.wake("agent-0", "private:30000");
  assert.equal(f.runtime.faults.get("agent-0"), "DSH_UNIFIED_PRESET_BROKEN");
  failure = false;
  await f.runtime.wake("agent-0", "private:30000");
  assert.equal(f.runtime.faults.has("agent-0"), false);
});

function readiness(
  t,
  {
    responses = [],
    online = true,
    account = "10001",
    alive = true,
    wsReady = true,
  } = {},
) {
  const p = profile(t);
  writeJson(path.join(p.workdir, "process.json"), record(p, 100));
  let now = 0;
  const calls = [];
  const n = new NativeQQ([p], {
    identity: () => (alive ? identity(p, 100) : null),
    now: () => now,
    wait: async (ms) => {
      now += ms;
    },
    busy: async () => wsReady,
    fetchImpl: async (url, options) => {
      calls.push(url);
      assert.equal(options.redirect, "error");
      assert.equal(options.headers.authorization, "Bearer fixture-only");
      if (responses.length) {
        const response = responses.shift();
        if (response instanceof Error) throw response;
        return response;
      }
      return Response.json({
        status: "ok",
        retcode: 0,
        data: url.endsWith("get_status")
          ? { online, good: true }
          : { user_id: account },
      });
    },
  });
  return { n, p, calls, elapsed: () => now };
}
test("native readiness waits through cold endpoint startup before bridge connection", async (t) => {
  const f = readiness(t, {
    responses: [
      new TypeError("fetch failed", { cause: { code: "ECONNREFUSED" } }),
    ],
  });
  await f.n.waitReady([f.p.id], 2000);
  assert.equal(f.elapsed(), 500);
  assert.equal(f.calls.length, 3);
});
test("native readiness bounds login and websocket waits and detects exited process", async (t) => {
  const offline = readiness(t, { online: false });
  await assert.rejects(
    offline.n.waitReady([offline.p.id], 1000),
    /NATIVE_LOGIN_REQUIRED/,
  );
  assert.equal(offline.elapsed(), 1000);
  const ws = readiness(t, { wsReady: false });
  await assert.rejects(ws.n.waitReady([ws.p.id], 1000), /NATIVE_READY_TIMEOUT/);
  const dead = readiness(t, { alive: false });
  await assert.rejects(dead.n.waitReady([dead.p.id]), /NATIVE_EXITED/);
});
test("native readiness fails immediately on auth, protocol or account mismatch", async (t) => {
  for (const options of [
    { responses: [new Response("credential", { status: 401 })] },
    { responses: [new Response("credential")] },
    { responses: [Response.json({ status: "failed", retcode: 1 })] },
    { account: "99999" },
  ]) {
    const f = readiness(t, options);
    await assert.rejects(
      f.n.waitReady([f.p.id]),
      /NATIVE_(READINESS_|ACCOUNT_MISMATCH)/,
    );
    assert.equal(f.elapsed(), 0);
  }
});

test("native readiness retries response-body timeout but rejects malformed status", async (t) => {
  const f = readiness(t, {
    responses: [
      {
        ok: true,
        json: async () => {
          throw new DOMException("timeout", "AbortError");
        },
      },
    ],
  });
  await f.n.waitReady([f.p.id], 2000);
  assert.equal(f.elapsed(), 500);
  const bad = readiness(t, {
    responses: [Response.json({ status: "ok", retcode: 0, data: {} })],
  });
  await assert.rejects(
    bad.n.waitReady([bad.p.id]),
    /NATIVE_READINESS_INVALID_RESPONSE/,
  );
  assert.equal(bad.elapsed(), 0);
});
