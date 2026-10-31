import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { spawn, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  AntigravityBackend,
  antigravityFailure,
  antigravityShellQuote,
} from "../src/backends/antigravity.mjs";
import { antigravityToolAllowed } from "../src/backends/antigravity-guard.mjs";
import {
  BackendRegistry,
  backendCapabilities,
} from "../src/backends/index.mjs";
import { validateConfig } from "../src/core/config.mjs";
import { buildChildEnv } from "../src/core/child-env.mjs";
import { config, temp, fixture as runtimeFixture } from "./helpers.mjs";
import { toolSpecs } from "../src/tools/specs.mjs";
import { registry } from "../src/tools/registry.mjs";

const fixture = fileURLToPath(
  new URL("./antigravity-fixture.mjs", import.meta.url),
);
const tool = {
  name: "probe",
  description: "Synthetic test",
  inputSchema: { type: "object", properties: {} },
};
function setup(t, mode = "success") {
  const root = temp(t);
  const cfg = config();
  const backendConfig = validateConfig({
    ...cfg,
    backends: [
      {
        id: "fixture",
        label: "Fixture",
        type: "antigravity",
        model: "fixture-model",
        effort: "",
      },
    ],
  }).backends[0];
  const launches = [];
  const backend = new AntigravityBackend(backendConfig, cfg.agents[0], {
    root,
    spawn(command, args, options) {
      const child = spawn(process.execPath, [fixture, ...args], {
        ...options,
        env: { ...options.env, AGY_FIXTURE_MODE: mode },
      });
      launches.push({ command, args, options, pid: child.pid });
      return child;
    },
  });
  t.after(() => backend.close());
  const controller = new AbortController();
  const sessions = [];
  const calls = [];
  const params = {
    conversation: "private:synthetic",
    prompt: "PRIVATE_SYNTHETIC_PROMPT",
    instructions: "Synthetic role.",
    tools: [tool],
    signal: controller.signal,
    saveSession: (s) => sessions.push(s),
    callTool: async (name, args) => {
      calls.push({ name, args });
      return { ok: true };
    },
  };
  return {
    backend,
    params,
    sessions,
    calls,
    launches,
    controller,
    root,
    backendConfig,
  };
}

test("Antigravity registers without changing existing backend defaults", async (t) => {
  const { backend, backendConfig, root } = setup(t);
  assert.equal(backendConfig.command, "agy");
  assert.equal(config().backends[0].command, "codex");
  const registered = new BackendRegistry().create(
    backendConfig,
    { id: "another" },
    { root },
  );
  t.after(() => registered.close());
  assert(registered instanceof AntigravityBackend);
  assert.deepEqual(backendCapabilities("antigravity"), {
    compaction: false,
    imageGeneration: false,
  });
  assert.deepEqual(await backend.models(), [
    { id: "fixture-model", name: "Fixture model" },
  ]);
  for (const extra of [
    { home: "custom" },
    { provider: "other" },
    { baseUrl: "http://127.0.0.1:9" },
    { effort: "invalid" },
    { env: { AGY_ACCOUNT: "EXAMPLE_ACCOUNT" } },
  ])
    assert.throws(() =>
      validateConfig({
        ...config(),
        backends: [{ ...backendConfig, ...extra }],
      }),
    );
});

test("Antigravity resumes only its bound conversation and keeps prompts off argv", async (t) => {
  const { backend, params, sessions, calls, launches } = setup(t);
  await backend.run(params);
  const session = sessions.at(-1);
  assert.equal(session.backend, "antigravity");
  await backend.run({ ...params, session, instructions: undefined });
  assert.equal(sessions.at(-1).id, session.id);
  assert.equal(calls.length, 2);
  assert(launches[1].args.includes(session.id));
  assert(launches.every((x) => !x.args.includes(params.prompt)));
  assert(!launches[0].args.includes("--continue"));
  assert(launches[0].args.includes("--disable-slash-commands"));
  assert(!launches[0].args.includes("--dangerously-skip-permissions"));
  assert.equal(
    fs
      .readFileSync(
        path.join(launches[1].options.cwd, ".agents", "agents", "qq-agents.md"),
        "utf8",
      )
      .includes(params.instructions),
    true,
  );
  await assert.rejects(
    backend.run({ ...params, conversation: "private:other", session }),
    /ANTIGRAVITY_SESSION_UNAVAILABLE/,
  );
  assert.equal(sessions.at(-1), null);
  assert.equal(launches.length, 2);
});

test("Antigravity makes only allowed parameter schemas visible before the first call", async (t) => {
  const { backend, params, launches } = setup(t, "usage");
  const tools = toolSpecs(["qq_send", "qq_mark_read"]);
  await backend.run({ ...params, tools });
  const instructions = fs.readFileSync(
    path.join(launches[0].options.cwd, ".agents", "agents", "qq-agents.md"),
    "utf8",
  );
  for (const { name, inputSchema } of tools) {
    assert(instructions.includes(JSON.stringify({ name, inputSchema })));
  }
  assert(!instructions.includes('"name":"qq_send_burst"'));
  assert(!instructions.includes(launches[0].options.env.QQ_AGY_TOKEN));
});

test("Antigravity returns the called tool schema after argument validation fails", async (t) => {
  const { backend, params } = setup(t, "schema-error");
  const spec = { ...toolSpecs(["qq_send"])[0], name: "probe" };
  await backend.run({
    ...params,
    tools: [spec],
    callTool: async () => {
      registry.qq_send.schema.parse({
        text: "PRIVATE_ARGUMENT",
        chatId: "PRIVATE_ARGUMENT",
      });
    },
  });
});

test("Antigravity occupancy uses the last response and includes cached input, not cumulative or checkpoint usage", async (t) => {
  const { backend, params } = setup(t, "usage"),
    reports = [];
  await backend.run({ ...params, onUsage: (u) => reports.push(u) });
  assert.equal(reports.length, 1);
  assert.equal(reports[0].source, "measured");
  assert.equal(reports[0].contextTokens, 23100);
  assert.equal(reports[0].capacityTokens, undefined);
});

test("Antigravity falls back when the latest response has invalid usage", async (t) => {
  const { backend, params } = setup(t, "invalid-usage"),
    reports = [];
  await backend.run({ ...params, onUsage: (u) => reports.push(u) });
  assert.equal(reports.length, 0);
});

test("the runtime keeps a default-capacity Antigravity session with the complete tool catalogue", async (t) => {
  const { backend } = setup(t, "usage");
  const cfg = config(1);
  cfg.agents[0].tools = toolSpecs().map((s) => s.name);
  const f = runtimeFixture(t, { cfg });
  f.runtime.backends.set("agent-0", backend);
  const mem = f.store.bind("agent-0"),
    scope = "private:30000";
  await f.runtime.wake("agent-0", scope);
  const first = mem.state(scope);
  assert(first.session);
  assert.equal(first.usage.contextTokens, 23100);
  assert.equal(cfg.agents[0].contextPolicy.capacityTokens, 32768);
  assert(
    mem.identity.get("model_turns", first.lastTurnId).estimatedTextChars >
      32768,
  );
  await f.runtime.wake("agent-0", scope);
  assert.equal(mem.state(scope).session.id, first.session.id);
  assert.equal(
    mem.identity.get("model_turns", mem.state(scope).lastTurnId).initialSession,
    false,
  );
  // A deliberately smaller administrator limit still triggers the hard guard.
  f.runtime.config.agents[0].contextPolicy.capacityTokens = 24000;
  await f.runtime.wake("agent-0", scope);
  assert.equal(mem.state(scope).session, null);
  assert.equal(mem.state(scope).lifecycle.reason, "capacity-guard");
});

test("Antigravity rejects polluted profiles before spawning", async (t) => {
  const { backend, params, launches } = setup(t);
  fs.mkdirSync(path.join(backend.profile, "config"), { recursive: true });
  fs.writeFileSync(path.join(backend.profile, "config", "hooks.json"), "{}");
  await assert.rejects(backend.run(params), /ANTIGRAVITY_PROFILE_UNSAFE/);
  assert.equal(launches.length, 0);
});

test("Antigravity guards exact server/tool names and drops inherited credentials", () => {
  const call = (server, name) => ({
    name: "call_mcp_tool",
    args: { ServerName: server, ToolName: name },
  });
  assert.equal(
    antigravityToolAllowed(call("qq-agents", "probe"), ["probe"]),
    true,
  );
  assert.equal(
    antigravityToolAllowed(call("other", "probe"), ["probe"]),
    false,
  );
  assert.equal(
    antigravityToolAllowed(call("qq-agents", "unknown"), ["probe"]),
    false,
  );
  for (const name of [
    "run_command",
    "view_file",
    "schedule",
    "invoke_subagent",
    "manage_task",
    "call_mcp_tool",
  ])
    assert.equal(antigravityToolAllowed({ name }, ["probe"]), false);
  assert.equal(antigravityToolAllowed({ name: "finish" }, []), true);
  const env = buildChildEnv(
    "antigravity",
    {},
    {
      parent: {
        PATH: "fixture",
        HOME: "fixture-home",
        AGY_ACCOUNT: "private",
        GEMINI_API_KEY: "private",
        QQ_UNIFIED_TOKEN: "private",
        ANTIGRAVITY_GEMINI_DIR: "other",
      },
    },
  );
  assert.deepEqual(Object.keys(env).sort(), ["HOME", "PATH"]);
});

test("Antigravity hook quoting handles Unix apostrophes and rejects Windows expansion", () => {
  assert.equal(antigravityShellQuote("a'b", "darwin"), "'a'\\''b'");
  assert.equal(
    antigravityShellQuote("C:\\Program Files\\node.exe", "win32"),
    '"C:\\Program Files\\node.exe"',
  );
  assert.throws(
    () => antigravityShellQuote("C:\\%PATH%\\node.exe", "win32"),
    /ANTIGRAVITY_COMMAND_UNSAFE/,
  );
});

for (const mode of ["malformed", "wrong-result", "duplicate-result", "quota"])
  test(`Antigravity retires ${mode} sessions without replay`, async (t) => {
    const { backend, params, sessions, launches } = setup(t, mode);
    await assert.rejects(backend.run(params), (error) => {
      assert(!error.message.includes("fixture-private"));
      if (mode === "quota") {
        assert.equal(error.category, "quota");
        assert.equal(error.recoverable, false);
        assert.equal(error.sessionReusable, false);
      }
      return true;
    });
    assert.equal(sessions.at(-1), null);
    assert.equal(launches.length, 1);
  });

test("Antigravity cancellation revokes tools and cannot revive a session with late success", async (t) => {
  const { backend, params, sessions, controller, launches } = setup(
    t,
    "cancel",
  );
  let calls = 0;
  const run = backend.run({
    ...params,
    callTool: async () => {
      calls++;
      setImmediate(() => controller.abort());
      await new Promise((resolve) =>
        controller.signal.addEventListener("abort", resolve, { once: true }),
      );
      throw Error("ABORTED");
    },
  });
  await assert.rejects(run, /ABORTED/);
  assert.equal(calls, 1);
  assert.equal(sessions.at(-1), null);
  assert.equal(backend.active.size, 0);
  const url = launches[0].options.env.QQ_AGY_ENDPOINT;
  await assert.rejects(fetch(url + "/catalog"));
});

test("Antigravity close also terminates an in-flight model probe", async (t) => {
  const { backend } = setup(t, "probe-wait");
  const pending = backend.models();
  const rejected = assert.rejects(pending, /ANTIGRAVITY_PROBE_FAILED/);
  await backend.close();
  await rejected;
  assert.equal(backend.active.size, 0);
});

test(
  "POSIX cancellation kills descendants after the CLI group leader exits",
  { skip: process.platform === "win32" },
  async (t) => {
    const { backend, params, controller, sessions, launches } = setup(
      t,
      "orphan",
    );
    let deadline;
    const run = backend.run({
      ...params,
      callTool: async () => {
        setImmediate(() => controller.abort());
        await new Promise((resolve) =>
          controller.signal.addEventListener("abort", resolve, { once: true }),
        );
        throw Error("ABORTED");
      },
    });
    try {
      await Promise.race([
        assert.rejects(run, /ABORTED/),
        new Promise((_, reject) => {
          deadline = setTimeout(
            () => reject(Error("ORPHAN_NOT_TERMINATED")),
            8000,
          );
        }),
      ]);
      assert.equal(sessions.at(-1), null);
      assert.equal(backend.active.size, 0);
    } finally {
      clearTimeout(deadline);
      for (const launch of backend.active.size ? launches : []) {
        try {
          process.kill(-launch.pid, "SIGKILL");
        } catch {
          /* No test descendant survives a failed assertion. */
        }
      }
      await run.catch(() => {});
    }
  },
);

test("Antigravity failure classification never exposes provider diagnostics", () => {
  const error = antigravityFailure("UNAUTHENTICATED private-provider-detail");
  assert.equal(error.category, "authentication");
  assert.equal(error.message, "ANTIGRAVITY_TURN_FAILED");
  assert.equal(error.sessionReusable, false);
});

test("Antigravity hook process denies invalid, expired and unavailable policies", async (t) => {
  let active = true;
  const server = http.createServer((req, res) => {
    const valid = active && req.headers.authorization === "Bearer synthetic";
    res.writeHead(valid ? 200 : 403, { "content-type": "application/json" });
    res.end(JSON.stringify({ tools: [tool] }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const endpoint = `http://127.0.0.1:${server.address().port}`;
  const hook = fileURLToPath(
    new URL("../src/backends/antigravity-guard.mjs", import.meta.url),
  );
  async function guard(input, token = "synthetic") {
    const child = spawn(process.execPath, [hook], {
      env: {
        ...buildChildEnv("antigravity"),
        QQ_AGY_ENDPOINT: endpoint,
        QQ_AGY_TOKEN: token,
      },
    });
    let output = "";
    child.stdout.on("data", (data) => {
      output += data;
    });
    const done = new Promise((resolve) => child.once("close", resolve));
    child.stdin.end(
      typeof input === "string" ? input : JSON.stringify({ toolCall: input }),
    );
    assert.equal(await done, 0);
    return JSON.parse(output).decision;
  }
  const call = {
    name: "call_mcp_tool",
    args: { ServerName: "qq-agents", ToolName: "probe" },
  };
  assert.equal(await guard(call), "auto_approve");
  assert.equal(await guard({ name: "run_command" }), "deny");
  assert.equal(await guard("invalid json"), "deny");
  assert.equal(await guard(call, "invalid"), "deny");
  active = false;
  assert.equal(await guard(call), "deny");
  await new Promise((resolve) => server.close(resolve));
  assert.equal(await guard(call), "deny");
});

test("Antigravity refuses session contract changes before launching", async (t) => {
  const { backend, params, sessions, launches } = setup(t);
  await backend.run(params);
  await assert.rejects(
    backend.run({ ...params, session: sessions.at(-1), tools: [] }),
    /SESSION_REQUIRES_HANDOFF/,
  );
  assert.equal(launches.length, 1);
});

test("Antigravity creates Git boundaries even when data sits inside another repository", async (t) => {
  const { backend, root, params, launches } = setup(t);
  execFileSync("git", ["init", "--quiet", "--template=", root]);
  await backend.run(params);
  const launch = launches[0];
  for (const directory of [backend.root, launch.options.cwd]) {
    const actual = execFileSync(
      "git",
      ["-C", directory, "rev-parse", "--show-toplevel"],
      { encoding: "utf8" },
    ).trim();
    const expected = fs.statSync(directory, { bigint: true });
    const resolved = fs.statSync(actual, { bigint: true });
    assert.equal(resolved.dev, expected.dev);
    assert.equal(resolved.ino, expected.ino);
  }
  assert.equal(launch.options.env.GIT_CONFIG_NOSYSTEM, "1");
  assert.equal(
    launch.options.env.GIT_CONFIG_GLOBAL,
    process.platform === "win32" ? "NUL" : "/dev/null",
  );
});

test("Antigravity rejects an invalid Git boundary before CLI startup", async (t) => {
  const { backend, params, launches } = setup(t);
  fs.writeFileSync(path.join(backend.root, ".git"), "gitdir: unrelated");
  await assert.rejects(backend.run(params), /ANTIGRAVITY_WORKSPACE_UNSAFE/);
  assert.equal(launches.length, 0);
});

test("Antigravity rejects Git configuration redirecting its working tree to an ancestor", async (t) => {
  const { backend, root, params, launches } = setup(t);
  backend.checkProfile();
  execFileSync("git", ["-C", backend.root, "config", "core.worktree", root]);
  await assert.rejects(backend.run(params), /ANTIGRAVITY_WORKSPACE_UNSAFE/);
  assert.equal(launches.length, 0);
});
