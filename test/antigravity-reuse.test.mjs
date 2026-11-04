import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { AntigravityBackend } from "../src/backends/antigravity.mjs";
import { validateConfig } from "../src/core/config.mjs";
import { config } from "./helpers.mjs";

const streamFixture = fileURLToPath(
  new URL("./antigravity-stream-fixture.mjs", import.meta.url),
);
const probe = {
  name: "probe",
  description: "Synthetic stream fixture tool",
  inputSchema: {
    type: "object",
    properties: { value: { type: "string" } },
    required: ["value"],
    additionalProperties: false,
  },
};

function setup(
  t,
  { idleTimeoutMs = 30000, maxIdleProcesses = 2, callTool } = {},
) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "qq-agy-reuse-test-"));
  const rawConfig = config();
  const backendConfig = validateConfig({
    ...rawConfig,
    backends: [
      {
        id: "fixture",
        label: "Synthetic Antigravity",
        type: "antigravity",
        model: "synthetic-model",
        effort: "",
        cliReuse: { enabled: true, idleTimeoutMs, maxIdleProcesses },
      },
    ],
  }).backends[0];
  const launches = [];
  const calls = [];
  const backend = new AntigravityBackend(backendConfig, rawConfig.agents[0], {
    root,
    spawn(_command, args, options) {
      const index = launches.length;
      const logFile = path.join(root, `fixture-${index}.jsonl`);
      const controlFile = path.join(root, `fixture-${index}.json`);
      fs.writeFileSync(controlFile, "{}\n");
      const child = spawn(process.execPath, [streamFixture, ...args], {
        ...options,
        env: {
          ...options.env,
          AGY_STREAM_FIXTURE_LOG: logFile,
          AGY_STREAM_FIXTURE_CONTROL: controlFile,
        },
      });
      launches.push({ child, args, logFile, controlFile });
      return child;
    },
  });
  t.after(async () => {
    await backend.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  const dispatchTool =
    callTool ||
    (async (name, args) => {
      calls.push({ name, args });
      return { content: [{ type: "text", text: "synthetic tool result" }] };
    });
  function chat(conversation) {
    const controller = new AbortController();
    const state = { session: null, saved: [] };
    function params(mode = "success", overrides = {}) {
      const { priorEpoch, withoutSession, ...runOverrides } = overrides;
      return {
        conversation,
        prompt: `Synthetic prompt fixtureMode=${mode}${priorEpoch ? ` fixturePriorEpoch=${priorEpoch}` : ""}`,
        instructions: "Synthetic role instructions.",
        tools: [probe],
        signal: controller.signal,
        ...(withoutSession || !state.session ? {} : { session: state.session }),
        callTool: dispatchTool,
        ...runOverrides,
        saveSession(session) {
          state.session = session;
          state.saved.push(session);
        },
      };
    }
    return {
      state,
      controller,
      params,
      run(mode = "success", overrides = {}) {
        return backend.run(params(mode, overrides));
      },
    };
  }
  return { root, backend, launches, calls, chat };
}

const events = (launch) => {
  try {
    return fs
      .readFileSync(launch.logFile, "utf8")
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch {
    return [];
  }
};

function updateControl(launch, update) {
  let current = {};
  try {
    current = JSON.parse(fs.readFileSync(launch.controlFile, "utf8"));
  } catch {
    // A new fixture has an empty control state.
  }
  fs.writeFileSync(
    launch.controlFile,
    `${JSON.stringify({ ...current, ...update })}\n`,
  );
}

async function waitFor(predicate, description, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline)
      throw Error(`Timed out waiting for ${description}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const exited = (child) => child.exitCode !== null || child.signalCode !== null;

test("keeps one CLI for three turns and scopes epochs, terminal calls, idle calls, and usage", async (t) => {
  const { backend, launches, calls, chat } = setup(t);
  const conversation = chat("private:reuse-three-turns");
  const usage = [];

  await conversation.run("idle-probe", {
    onUsage: (value) => usage.push(value),
  });
  const launch = launches[0];
  assert.equal(launches.length, 1);
  assert.equal(launch.child.exitCode, null);
  assert(conversation.state.session);
  const nativeFile = path.join(
    backend.profile,
    "cli",
    "conversations",
    `${conversation.state.session.id}.db`,
  );
  assert.equal(
    fs.readFileSync(nativeFile, "utf8"),
    "synthetic native conversation database\n",
  );

  updateControl(launch, { probeIdle: true });
  await waitFor(
    () =>
      events(launch).some(
        (entry) => entry.type === "call" && entry.phase === "idle-probe",
      ),
    "idle dispatcher probe",
  );
  const idleProbe = events(launch).find(
    (entry) => entry.phase === "idle-probe",
  );
  assert.equal(idleProbe.status, 403);

  const firstEpoch = events(launch).find(
    (entry) => entry.type === "input",
  ).epoch;
  await conversation.run("stale-epoch", {
    priorEpoch: firstEpoch,
    onUsage: (value) => usage.push(value),
  });
  await conversation.run("success", { onUsage: (value) => usage.push(value) });
  await waitFor(
    () =>
      events(launch).filter((entry) => entry.type === "terminal").length === 3,
    "three fixture terminal records",
  );
  await waitFor(
    () =>
      events(launch).filter((entry) => entry.phase === "terminal-late")
        .length === 3,
    "three terminal dispatcher probes",
  );

  const records = events(launch);
  assert.equal(launches.length, 1);
  assert.deepEqual(
    records.filter((entry) => entry.type === "init").map((entry) => entry.turn),
    [1],
  );
  assert.deepEqual(
    records
      .filter((entry) => entry.type === "catalog")
      .map((entry) => entry.minimumStep),
    [-1, 1, 2],
  );
  assert.deepEqual(
    records
      .filter((entry) => entry.type === "input")
      .map((entry) => entry.turn),
    [1, 2, 3],
  );
  assert.equal(
    new Set(
      records
        .filter((entry) => entry.type === "input")
        .map((entry) => entry.epoch),
    ).size,
    3,
  );
  assert(
    records.some(
      (entry) => entry.phase === "stale-epoch" && entry.status === 403,
    ),
  );
  assert(
    records.some(
      (entry) => entry.phase === "current-epoch" && entry.status === 200,
    ),
  );
  assert.equal(
    records.filter(
      (entry) => entry.phase === "terminal-late" && entry.status === 403,
    ).length,
    3,
  );
  assert.deepEqual(
    records
      .filter((entry) => entry.type === "step")
      .map((entry) => entry.stepIndex),
    [1, 2, 3],
  );
  const terminals = records.filter((entry) => entry.type === "terminal");
  assert(terminals.every((entry) => entry.status === "SUCCESS"));
  assert.deepEqual(
    terminals.map((entry) => entry.conversationId),
    Array(3).fill(conversation.state.session.id),
  );
  assert.deepEqual(
    records
      .filter((entry) => entry.type === "input")
      .map((entry) => entry.epoch),
    records
      .filter((entry) => entry.type === "catalog")
      .map((entry) => entry.epoch),
  );
  assert.deepEqual(
    usage.map((entry) => entry.contextTokens),
    [115, 315],
  );
  assert.equal(calls.length, 3);
  assert(calls.every((entry) => entry.name === "probe"));
  assert.equal(backend.workers.size, 1);
});

test("cancelling one conversation leaves another reused worker running", async (t) => {
  const { backend, launches, chat } = setup(t);
  const first = chat("group:cancel-one");
  const second = chat("group:keep-other");
  const firstRun = first.run("hold");
  const secondRun = second.run("hold");
  const firstOutcome = firstRun.then(
    () => null,
    (error) => error,
  );
  const secondOutcome = secondRun.then(
    () => null,
    (error) => error,
  );

  await waitFor(
    () => first.state.session && second.state.session,
    "both synthetic sessions",
  );
  assert.equal(launches.length, 2);
  const firstLaunch = launches.find((launch) =>
    events(launch).some(
      (entry) =>
        entry.type === "spawn" &&
        entry.conversationId === first.state.session.id,
    ),
  );
  const secondLaunch = launches.find((launch) =>
    events(launch).some(
      (entry) =>
        entry.type === "spawn" &&
        entry.conversationId === second.state.session.id,
    ),
  );
  assert(firstLaunch);
  assert(secondLaunch);
  first.controller.abort();
  const firstError = await firstOutcome;
  assert.match(String(firstError?.message), /ABORTED/);
  await waitFor(
    () =>
      ![...backend.workers.values()].some(
        (worker) => worker.nativeId === first.state.session?.id,
      ),
    "cancelled worker removal",
  );
  await waitFor(() => exited(firstLaunch.child), "cancelled process exit");
  assert.equal(
    second.state.session?.id,
    events(secondLaunch).find((entry) => entry.type === "spawn").conversationId,
  );
  assert.equal(exited(secondLaunch.child), false);
  assert.equal(
    await Promise.race([
      secondOutcome.then(() => true),
      new Promise((resolve) => setTimeout(() => resolve(false), 25)),
    ]),
    false,
  );

  updateControl(secondLaunch, { release: true });
  assert.equal(await secondOutcome, null);
  assert(backend.workers.size >= 1);
  await waitFor(
    () => events(secondLaunch).some((entry) => entry.type === "terminal"),
    "unaffected conversation terminal record",
  );
  assert(
    events(secondLaunch).some(
      (entry) => entry.type === "terminal" && entry.status === "SUCCESS",
    ),
  );
});

test("a cancellation during terminal MCP completion retires the session", async (t) => {
  const gate = deferred();
  const { backend, launches, calls, chat } = setup(t, {
    callTool: async (name, args) => {
      calls.push({ name, args });
      return gate.promise;
    },
  });
  const conversation = chat("private:cancel-terminal-race");
  const terminal = deferred();
  const run = conversation.run("pending-terminal", {
    onTiming(value) {
      if (value.phase === "terminal") terminal.resolve();
    },
  });

  await terminal.promise;
  assert.equal(calls.length, 1);
  conversation.controller.abort();
  await assert.rejects(run, /ABORTED/);
  gate.resolve({
    content: [{ type: "text", text: "late synthetic tool result" }],
  });
  await waitFor(
    () => backend.workers.size === 0,
    "cancelled terminal worker removal",
  );
  assert.equal(conversation.state.session, null);
  assert.equal(conversation.state.saved.at(-1), null);
  assert.equal(launches.length, 1);
});

test("rejects duplicate init/results, successful results without a response, and stale response steps", async (t) => {
  const duplicateInit = setup(t);
  const duplicateInitChat = duplicateInit.chat("private:duplicate-init");
  await assert.rejects(
    duplicateInitChat.run("duplicate-init"),
    /ANTIGRAVITY_PROTOCOL_ERROR/,
  );
  assert.equal(duplicateInit.launches.length, 1);

  const duplicate = setup(t);
  const duplicateChat = duplicate.chat("private:duplicate-result");
  await assert.rejects(
    duplicateChat.run("duplicate-result"),
    /ANTIGRAVITY_PROTOCOL_ERROR/,
  );
  assert.equal(duplicate.launches.length, 1);

  const missing = setup(t);
  const missingChat = missing.chat("private:no-response");
  await assert.rejects(
    missingChat.run("no-response"),
    /ANTIGRAVITY_PROTOCOL_ERROR/,
  );
  assert.equal(missing.launches.length, 1);

  const stale = setup(t);
  const staleChat = stale.chat("private:old-step");
  await staleChat.run("success");
  await assert.rejects(staleChat.run("old-step"), /ANTIGRAVITY_PROTOCOL_ERROR/);
  assert.equal(stale.launches.length, 1);
});

test("closes workers at the idle timeout and evicts idle processes above the pool limit", async (t) => {
  const timed = setup(t, { idleTimeoutMs: 1000 });
  const timedChat = timed.chat("private:idle-timeout");
  await timedChat.run("success");
  await waitFor(() => timed.backend.workers.size === 0, "idle timeout", 4000);
  await waitFor(() => exited(timed.launches[0].child), "idle process exit");

  const pooled = setup(t, { maxIdleProcesses: 1 });
  const oldest = pooled.chat("private:pool-oldest");
  const newest = pooled.chat("private:pool-newest");
  await oldest.run("success");
  await new Promise((resolve) => setTimeout(resolve, 30));
  await newest.run("success");
  assert.equal(pooled.backend.workers.size, 1);
  assert.equal(
    [...pooled.backend.workers.values()][0].nativeId,
    newest.state.session.id,
  );
  assert.equal(pooled.launches.length, 2);
  await waitFor(() => exited(pooled.launches[0].child), "evicted process exit");
});

test("idle eviction cleanup failure preserves the successful turn and its session", async (t) => {
  const { backend, launches, calls, chat } = setup(t, { maxIdleProcesses: 1 });
  const oldest = chat("private:pool-cleanup-oldest");
  const newest = chat("private:pool-cleanup-newest");
  await oldest.run("success");
  const oldWorker = [...backend.workers.values()][0];
  const oldSession = oldest.state.session;
  const remove = fs.rmSync;
  const removal = t.mock.method(fs, "rmSync", (target, options) => {
    if (target === oldWorker.mediaRoot)
      throw Error("SYNTHETIC_PRIVATE_LOCK_DETAIL");
    return remove(target, options);
  });
  const warning = t.mock.method(console, "warn", () => {});
  t.after(() => {
    removal.mock.restore();
    remove(oldWorker.mediaRoot, { recursive: true, force: true });
  });

  await newest.run("success");
  const session = newest.state.session;
  assert(session);
  assert(newest.state.saved.every((value) => value !== null));
  assert.deepEqual(oldest.state.session, oldSession);
  assert.equal(backend.workers.size, 1);
  const worker = [...backend.workers.values()][0];
  assert.equal(worker.nativeId, session.id);
  assert.equal(worker.available, true);
  assert.equal(
    JSON.parse(fs.readFileSync(worker.details.binding)).id,
    session.id,
  );
  assert.equal(backend.active.size, 0);
  assert.equal(backend.conversations.size, 0);
  await waitFor(() => exited(launches[0].child), "failed-cleanup process exit");
  assert.deepEqual(
    warning.mock.calls.map((call) => call.arguments),
    [["Antigravity idle worker cleanup failed"]],
  );

  await newest.run("success");
  assert.deepEqual(newest.state.session, session);
  assert.equal(launches.length, 2);
  assert.equal(calls.length, 3);
  await backend.close();
  assert.equal(backend.workers.size, 0);
  await waitFor(() => exited(launches[1].child), "successful worker shutdown");
});

test("restarts the CLI when effort or the bound native session changes", async (t) => {
  const { backend, launches, chat } = setup(t);
  const conversation = chat("private:worker-signature-changes");
  await conversation.run("success");
  const originalId = conversation.state.session.id;

  backend.config.effort = "high";
  await conversation.run("success");
  assert.equal(launches.length, 2);
  assert.equal(conversation.state.session.id, originalId);

  const replacementId = randomUUID();
  const replacementParams = conversation.params("success", {
    withoutSession: true,
  });
  const signature = backend.sessionSignature(replacementParams.tools);
  const details = backend.prepare(replacementParams, signature);
  const databaseDirectory = path.join(backend.profile, "cli", "conversations");
  fs.mkdirSync(databaseDirectory, { recursive: true });
  fs.writeFileSync(
    path.join(databaseDirectory, `${replacementId}.db`),
    "synthetic replacement session\n",
  );
  backend.bindSession(replacementParams, details, replacementId);

  await conversation.run("success");
  assert.equal(launches.length, 3);
  assert.equal(conversation.state.session.id, replacementId);
  assert.equal([...backend.workers.values()][0].nativeId, replacementId);
});

test("does not replay a failed turn automatically and retires its session", async (t) => {
  const { backend, launches, chat } = setup(t);
  const conversation = chat("private:failed-turn-no-replay");

  await assert.rejects(conversation.run("failure"));
  assert.equal(launches.length, 1);
  assert.equal(backend.workers.size, 0);
  assert.equal(conversation.state.session, null);
  assert.equal(conversation.state.saved.at(-1), null);
});
