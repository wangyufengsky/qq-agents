import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { AntigravityBackend } from "../src/backends/antigravity.mjs";
import { AntigravityMedia } from "../src/backends/antigravity-media.mjs";
import {
  BackendTurnFailure,
  SessionPreparationFailure,
} from "../src/backends/turn-failure.mjs";
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
  {
    idleTimeoutMs = 30000,
    maxIdleProcesses = 2,
    callTool,
    fakeWorkers = false,
  } = {},
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
  const syntheticWorkers = [];
  const calls = [];
  const backend = new AntigravityBackend(backendConfig, rawConfig.agents[0], {
    root,
    spawn(_command, args, options) {
      if (fakeWorkers) {
        const child = createFakeWorker();
        launches.push({ child, args, fake: true });
        syntheticWorkers.push(child);
        return child;
      }
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
    ...(fakeWorkers
      ? {
          stop(child, signal) {
            child.kill(signal);
          },
        }
      : {}),
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
  return { root, backend, launches, syntheticWorkers, calls, chat };
}

function createFakeWorker() {
  const child = new EventEmitter();
  child.pid = 4242;
  child.exitCode = null;
  child.signalCode = null;
  child.inputs = [];
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  let inputBuffer = "";
  child.stdin = new Writable({
    write(chunk, _encoding, callback) {
      inputBuffer += chunk.toString();
      while (inputBuffer.includes("\n")) {
        const end = inputBuffer.indexOf("\n");
        const line = inputBuffer.slice(0, end);
        inputBuffer = inputBuffer.slice(end + 1);
        if (line.trim()) child.inputs.push(JSON.parse(line));
      }
      callback();
    },
  });
  child.kill = (signal) => {
    child.killedBy = signal;
    return true;
  };
  child.emitFrames = (...frames) =>
    child.stdout.write(
      `${frames.map((frame) => JSON.stringify(frame)).join("\n")}\n`,
    );
  child.closeWith = (code, signal = null) => {
    child.exitCode = signal ? null : code;
    child.signalCode = signal;
    child.emit("close", code, signal);
  };
  child.breakStdin = (code = "EPIPE") => {
    const error = Object.assign(Error("SYNTHETIC_PRIVATE_IO_DETAIL"), { code });
    child.stdin.emit("error", error);
  };
  return child;
}

function successfulFrames(id, stepIndex = 1) {
  return [
    {
      event: "init",
      conversation_id: id,
      init: { agent: "qq-agents-fixture" },
    },
    {
      event: "step_update",
      step_update: {
        conversation_id: id,
        step_index: stepIndex,
        step_type: "agent_response",
        state: "DONE",
        usage: { input_tokens: 10, output_tokens: 2, cache_read_tokens: 1 },
      },
    },
    {
      event: "result",
      result: {
        status: "SUCCESS",
        conversation_id: id,
        response: "Synthetic success.",
      },
    },
  ];
}

function assertSafeDiagnostics(entries) {
  const enums = {
    origin: ["terminal", "process-exit", "stdin", "protocol", "finalization"],
    phase: ["preparing", "running", "settling", "terminal-observed", "settled"],
    terminalStatus: ["SUCCESS", "ERROR", "CANCELLED", "unrecognized"],
    ioCode: [
      "EPIPE",
      "ECONNRESET",
      "ERR_STREAM_DESTROYED",
      "ERR_STREAM_WRITE_AFTER_END",
    ],
    signal: ["SIGINT", "SIGTERM", "SIGKILL", "SIGABRT", "SIGSEGV"],
    workerOutcome: ["recycled", "exit-warning", "healthy"],
    sessionDisposition: ["retained", "retiring", "retired"],
    backendOutcome: ["success", "failed", "cancelled"],
  };
  const fields = new Set([
    ...Object.keys(enums),
    "trustedTerminal",
    "exitCode",
    "elapsedMs",
    "wrapperError",
  ]);
  for (const entry of entries) {
    assert.deepEqual(
      Object.keys(entry).filter((key) => !fields.has(key)),
      [],
      "diagnostics expose only approved fields",
    );
    for (const [key, allowed] of Object.entries(enums))
      if (key in entry) assert(allowed.includes(entry[key]), `${key} is safe`);
    if ("trustedTerminal" in entry)
      assert.equal(typeof entry.trustedTerminal, "boolean");
    if ("exitCode" in entry)
      assert(
        Number.isSafeInteger(entry.exitCode) &&
          entry.exitCode >= -2147483648 &&
          entry.exitCode <= 2147483647,
      );
    if ("elapsedMs" in entry)
      assert(
        Number.isFinite(entry.elapsedMs) &&
          entry.elapsedMs >= 0 &&
          entry.elapsedMs <= 86400000,
      );
    if ("wrapperError" in entry)
      assert.equal(typeof entry.wrapperError, "boolean");
  }
  assert(!JSON.stringify(entries).includes("SYNTHETIC_PRIVATE_IO_DETAIL"));
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

  const submittedHold = (conversation) => {
    const session = conversation.state.session;
    return (
      session &&
      launches.some((launch) => {
        const log = events(launch);
        return (
          log.some(
            (entry) =>
              entry.type === "spawn" && entry.conversationId === session.id,
          ) &&
          log.some((entry) => entry.type === "input" && entry.mode === "hold")
        );
      })
    );
  };
  await waitFor(
    () => submittedHold(first) && submittedHold(second),
    "both fixture workers holding submitted turns",
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

test("an accepted terminal tool call settles before successful completion", async (t) => {
  const gate = deferred();
  const { backend, launches, calls, chat } = setup(t, {
    callTool: async (name, args) => {
      calls.push({ name, args });
      return gate.promise;
    },
  });
  const conversation = chat("private:terminal-settlement");
  const terminal = deferred();
  let completed = false;
  const run = conversation
    .run("pending-terminal", {
      onTiming(value) {
        if (value.phase === "terminal") terminal.resolve();
      },
    })
    .then(() => {
      completed = true;
    });

  await terminal.promise;
  assert.equal(calls.length, 1);
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(completed, false);
  gate.resolve({
    content: [{ type: "text", text: "settled synthetic tool result" }],
  });
  await run;
  assert.equal(completed, true);
  assert(conversation.state.session);
  assert.equal(backend.workers.size, 1);
  assert.equal(launches.length, 1);
});

test("trusted success survives worker close and EPIPE while retiring the session", async (t) => {
  for (const failure of ["close-zero", "close-seven", "epipe"]) {
    const fixture = setup(t, { fakeWorkers: true });
    const conversation = fixture.chat(`private:trusted-${failure}`);
    const diagnostics = [];
    const run = conversation.run("success", {
      onDiagnostic: (event) => diagnostics.push(event),
    });
    await waitFor(
      () => fixture.syntheticWorkers[0]?.inputs.length === 1,
      `${failure} fake worker input`,
    );
    const child = fixture.syntheticWorkers[0];
    const sessionId = "00000000-0000-4000-8000-000000000101";
    child.emitFrames(...successfulFrames(sessionId));
    if (failure === "close-zero") child.closeWith(0);
    else if (failure === "close-seven") child.closeWith(7);
    else child.breakStdin("EPIPE");

    await run;
    assert.equal(conversation.state.session, null, failure);
    assert.equal(conversation.state.saved.at(-1), null, failure);
    assert.equal(fixture.backend.workers.size, 0, failure);
    assert.equal(fixture.launches.length, 1, failure);
    assertSafeDiagnostics(diagnostics);
    assert(
      diagnostics.some(
        (event) =>
          event.origin === "terminal" &&
          event.terminalStatus === "SUCCESS" &&
          event.trustedTerminal === true,
      ),
      `${failure} records the trusted terminal`,
    );
    assert(
      diagnostics.some(
        (event) =>
          event.origin === "finalization" && event.backendOutcome === "success",
      ),
      `${failure} preserves the successful backend outcome`,
    );
    assert(
      diagnostics.some(
        (event) =>
          event.origin === "finalization" &&
          event.sessionDisposition === "retired",
      ),
      `${failure} records conservative session retirement`,
    );
    if (failure === "epipe")
      assert(diagnostics.some((event) => event.ioCode === "EPIPE"));
  }
});

test("worker exit or EPIPE without a terminal still fails and retires the session", async (t) => {
  for (const failure of ["exit", "epipe"]) {
    const fixture = setup(t, { fakeWorkers: true });
    const conversation = fixture.chat(`private:no-terminal-${failure}`);
    const run = conversation.run("success");
    await waitFor(
      () => fixture.syntheticWorkers[0]?.inputs.length === 1,
      `${failure} fake worker input`,
    );
    if (failure === "exit") fixture.syntheticWorkers[0].closeWith(7);
    else fixture.syntheticWorkers[0].breakStdin("EPIPE");

    await assert.rejects(run);
    assert.equal(conversation.state.session, null, failure);
    assert.equal(conversation.state.saved.at(-1), null, failure);
    assert.equal(fixture.backend.workers.size, 0, failure);
  }
});

test("a late event from a retired worker cannot change the next worker session", async (t) => {
  const fixture = setup(t, { fakeWorkers: true });
  const conversation = fixture.chat("private:late-retired-worker");
  const firstRun = conversation.run("success");
  await waitFor(
    () => fixture.syntheticWorkers[0]?.inputs.length === 1,
    "first fake worker input",
  );
  const oldWorker = fixture.syntheticWorkers[0];
  const oldId = "00000000-0000-4000-8000-000000000102";
  oldWorker.emitFrames(...successfulFrames(oldId));
  oldWorker.closeWith(7);
  await firstRun;
  assert.equal(conversation.state.session, null);

  const secondRun = conversation.run("success");
  await waitFor(
    () => fixture.syntheticWorkers[1]?.inputs.length === 1,
    "replacement fake worker input",
  );
  const replacement = fixture.syntheticWorkers[1];
  const replacementId = "00000000-0000-4000-8000-000000000103";
  replacement.emitFrames(...successfulFrames(replacementId));
  oldWorker.emitFrames(...successfulFrames(oldId, 2));
  await secondRun;

  assert.equal(conversation.state.session.id, replacementId);
  assert.equal(fixture.backend.workers.size, 1);
  assert.equal(
    [...fixture.backend.workers.values()][0].nativeId,
    replacementId,
  );
});

test("rejects duplicate and invalid terminal frames, missing DONE, and stale response steps", async (t) => {
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

  const wrong = setup(t);
  const wrongChat = wrong.chat("private:wrong-result-id");
  await assert.rejects(
    wrongChat.run("wrong-result"),
    /ANTIGRAVITY_PROTOCOL_ERROR/,
  );
  assert.equal(wrong.launches.length, 1);

  for (const split of [false, true]) {
    const malformedTail = setup(t, { fakeWorkers: true });
    const malformedTailChat = malformedTail.chat("private:malformed-tail");
    const submitted = deferred();
    const run = malformedTailChat.run("success", {
      onInputSubmitted: () => submitted.resolve(),
    });
    const rejected = assert.rejects(run, /ANTIGRAVITY_PROTOCOL_ERROR/);
    await submitted.promise;
    const child = malformedTail.syntheticWorkers[0];
    const frames = successfulFrames("00000000-0000-4000-8000-000000000104");
    const terminalChunk =
      frames.map((frame) => JSON.stringify(frame)).join("\n") + "\n";
    // Pipe writes do not define stdout chunk boundaries. Inject both chunk
    // shapes before settlement instead of racing the native fixture's logger.
    if (split) {
      child.stdout.write(terminalChunk);
      child.stdout.write("{malformed synthetic tail");
    } else child.stdout.write(terminalChunk + "{malformed synthetic tail");
    await rejected;
    assert.equal(malformedTailChat.state.session, null);
    assert.equal(malformedTail.backend.workers.size, 0);
    assert.equal(malformedTail.launches.length, 1);
  }

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
  let wallTime = Date.now();
  const clock = t.mock.method(Date, "now", () => wallTime);
  await oldest.run("success");
  // LRU order follows completed use, even when the system clock moves backward.
  wallTime -= 1000;
  await newest.run("success");
  clock.mock.restore();
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

test("a reused session survives preparation failure before the next input", async (t) => {
  const { backend, launches, chat } = setup(t);
  const conversation = chat("private:reuse-preparation-failure");
  await conversation.run("success");
  const session = conversation.state.session;
  const worker = [...backend.workers.values()][0];
  const binding = fs.readFileSync(worker.details.binding, "utf8");
  const inputCount = events(launches[0]).filter(
    (entry) => entry.type === "input",
  ).length;
  const prepare = backend.prepare;
  let submitted = 0;
  backend.prepare = () => {
    throw Error("SYNTHETIC_PREPARE_FAILURE");
  };

  try {
    await assert.rejects(
      conversation.run("success", { onInputSubmitted: () => submitted++ }),
      (error) =>
        error instanceof SessionPreparationFailure &&
        error.message === "SYNTHETIC_PREPARE_FAILURE",
    );
  } finally {
    backend.prepare = prepare;
  }

  assert.equal(submitted, 0);
  assert.deepEqual(conversation.state.session, session);
  assert.deepEqual(conversation.state.saved, [session]);
  assert.equal(fs.readFileSync(worker.details.binding, "utf8"), binding);
  assert.equal(
    events(launches[0]).filter((entry) => entry.type === "input").length,
    inputCount,
  );

  await conversation.run("success");
  assert.equal(conversation.state.session.id, session.id);
  assert.equal(launches.length, 1);
  assert.equal(
    events(launches[0]).filter((entry) => entry.type === "input").length,
    inputCount + 1,
  );
});

test("a reused session survives an input callback failure before stdin", async (t) => {
  const { backend, launches, chat } = setup(t);
  const conversation = chat("private:reuse-input-callback-failure");
  await conversation.run("success");
  const session = conversation.state.session;
  const worker = [...backend.workers.values()][0];
  const binding = fs.readFileSync(worker.details.binding, "utf8");
  const inputCount = events(launches[0]).filter(
    (entry) => entry.type === "input",
  ).length;
  let callbackCalls = 0;

  await assert.rejects(
    conversation.run("success", {
      onInputSubmitted() {
        callbackCalls++;
        throw Error("SYNTHETIC_INPUT_CALLBACK_FAILURE");
      },
    }),
    (error) =>
      error instanceof SessionPreparationFailure &&
      error.message === "SYNTHETIC_INPUT_CALLBACK_FAILURE",
  );

  assert.equal(callbackCalls, 1);
  assert.deepEqual(conversation.state.session, session);
  assert.deepEqual(conversation.state.saved, [session]);
  assert.equal(fs.readFileSync(worker.details.binding, "utf8"), binding);
  assert.equal(
    events(launches[0]).filter((entry) => entry.type === "input").length,
    inputCount,
  );
  assert.equal(backend.active.size, 0);
  assert.equal(backend.conversations.size, 0);

  await conversation.run("success");
  assert.equal(conversation.state.session.id, session.id);
  assert.equal(launches.length, 2);
  assert(
    events(launches[1]).some(
      (entry) => entry.type === "spawn" && entry.conversationId === session.id,
    ),
  );
});

test("a locked old worker media directory is a preparation failure for the new input", async (t) => {
  const { backend, launches, chat } = setup(t);
  const conversation = chat("private:reuse-effort-cleanup-lock");
  await conversation.run("success");
  const session = conversation.state.session;
  const oldWorker = [...backend.workers.values()][0];
  assert.equal(oldWorker.nativeId, session.id);
  assert.equal(oldWorker.inputSubmitted, true);
  const originalRemove = fs.rmSync;
  const removal = t.mock.method(fs, "rmSync", (target, options) => {
    if (target === oldWorker.mediaRoot)
      throw Error("SYNTHETIC_PRIVATE_MEDIA_LOCK");
    return originalRemove(target, options);
  });
  const warning = t.mock.method(console, "warn", () => {});
  let submitted = 0;
  backend.config.effort = "high";

  try {
    await assert.rejects(
      conversation.run("success", { onInputSubmitted: () => submitted++ }),
      (error) =>
        error instanceof SessionPreparationFailure &&
        error.message === "ANTIGRAVITY_MEDIA_FAILED",
    );
  } finally {
    removal.mock.restore();
    originalRemove(oldWorker.mediaRoot, { recursive: true, force: true });
  }

  assert.equal(submitted, 0);
  assert.deepEqual(conversation.state.session, session);
  assert.deepEqual(conversation.state.saved, [session]);
  assert.equal(backend.active.size, 0);
  assert.equal(backend.conversations.size, 0);
  assert.equal(
    events(launches[0]).filter((entry) => entry.type === "input").length,
    1,
  );

  await conversation.run("success");
  assert.equal(conversation.state.session.id, session.id);
  assert.equal(launches.length, 2);
  assert(
    events(launches[1]).some(
      (entry) => entry.type === "spawn" && entry.conversationId === session.id,
    ),
  );
  assert.equal(backend.active.size, 0);
  assert.equal(backend.conversations.size, 0);
  assert.deepEqual(
    warning.mock.calls.map((call) => call.arguments),
    [["Antigravity worker cleanup failed"]],
  );
});

test("a reported hook denial does not override success or taint the next turn", async (t) => {
  const { backend, launches, chat } = setup(t);
  const conversation = chat("private:hook-denial-success");
  const run = conversation.run("hold");
  await waitFor(
    () =>
      [...backend.workers.values()].some(
        (worker) => worker.turn?.inputSubmitted && worker.nativeId,
      ),
    "held native turn",
  );
  const worker = [...backend.workers.values()][0];
  const address = worker.server.address();
  const response = await fetch(
    `http://127.0.0.1:${address.port}/hook-denied?epoch=${worker.turn.epoch}`,
    {
      method: "POST",
      headers: { authorization: `Bearer ${worker.token}` },
    },
  );
  assert.equal(response.status, 200);
  await response.arrayBuffer();
  assert.equal(worker.turn.hookDenied, true);
  updateControl(launches[0], { release: true });
  await run;
  const session = conversation.state.session;
  assert(session);
  let nextStarted = false;
  await conversation.run("success", {
    onTiming(value) {
      if (value.phase === "prepared") {
        nextStarted = true;
        assert.equal(worker.turn.hookDenied, false);
      }
    },
  });
  assert.equal(nextStarted, true);
  assert.deepEqual(conversation.state.session, session);
  assert.equal(launches.length, 1);
  assert.equal(worker.available, true);
});

test("reused worker media cleanup failures preserve terminal outcomes and retire failed sessions", async (t) => {
  const { backend, launches, calls, chat } = setup(t);
  const conversation = chat("private:reuse-media-finally-cleanup");
  const cleanup = t.mock.method(AntigravityMedia.prototype, "close", () => {
    throw Error("SYNTHETIC_PRIVATE_MEDIA_CLEANUP_DETAIL");
  });
  const warning = t.mock.method(console, "warn", () => {});

  await conversation.run("success");
  const successfulSession = conversation.state.session;
  const reusedWorker = [...backend.workers.values()][0];
  assert(successfulSession);
  assert.equal(reusedWorker.turn, null);
  assert.equal(reusedWorker.available, true);
  assert.equal(backend.active.size, 0);
  assert.equal(backend.conversations.size, 0);

  const terminalErrors = [
    ["quota", "QUOTA", "RESOURCE_EXHAUSTED private synthetic quota detail 31a"],
    [
      "authentication",
      "AUTHENTICATION",
      "UNAUTHENTICATED private synthetic auth detail 42b",
    ],
    [
      "context-limit",
      "CONTEXT_LIMIT",
      "context limit private synthetic context detail 53c",
    ],
    ["permission", "PERMISSION", "", true],
  ];
  for (const [
    category,
    code,
    privateDetail,
    reportDeniedHook,
  ] of terminalErrors) {
    const initialized = deferred();
    const run = conversation.run("hold", {
      onTiming(value) {
        if (value.phase === "initialized") initialized.resolve();
      },
    });
    // Native startup can exceed a fixed polling budget during the full suite.
    // Await protocol readiness, while surfacing a preparation failure immediately.
    await Promise.race([
      initialized.promise,
      run.then(() => {
        throw Error("SYNTHETIC_HELD_TURN_COMPLETED");
      }),
    ]);
    const worker = [...backend.workers.values()].find(
      (value) => value.turn?.inputSubmitted && value.nativeId,
    );
    assert(worker);
    if (category === "quota") {
      assert.equal(worker, reusedWorker);
      assert.equal(worker.nativeId, successfulSession.id);
    }
    const processCount = launches.length;
    const toolCallCount = calls.length;
    if (reportDeniedHook) {
      const epoch = worker.turn.epoch;
      const staleEpoch = `${epoch.slice(0, -1)}${epoch.endsWith("0") ? "1" : "0"}`;
      const address = worker.server.address();
      assert(address && typeof address === "object");
      const endpoint = `http://127.0.0.1:${address.port}/hook-denied?epoch=`;
      async function reportDenied(reportEpoch, token) {
        const response = await fetch(`${endpoint}${reportEpoch}`, {
          method: "POST",
          ...(token ? { headers: { authorization: `Bearer ${token}` } } : {}),
        });
        return response.status;
      }

      assert.equal(await reportDenied(epoch), 403);
      assert.equal(worker.turn.hookDenied, false);
      assert.equal(await reportDenied(staleEpoch, worker.token), 403);
      assert.equal(worker.turn.hookDenied, false);
      assert.equal(await reportDenied(epoch, worker.token), 200);
      assert.equal(worker.turn.hookDenied, true);
    }
    worker.diagnostic = "";
    worker.event({
      event: "result",
      result: {
        status: "ERROR",
        conversation_id: worker.nativeId,
        error: privateDetail,
      },
    });

    let failure;
    await assert.rejects(run, (error) => {
      failure = error;
      return (
        error instanceof BackendTurnFailure &&
        error.category === category &&
        error.code === code &&
        error.message === "ANTIGRAVITY_TURN_FAILED" &&
        error.recoverable === false &&
        error.sessionReusable === false
      );
    });
    if (privateDetail) assert(!String(failure).includes(privateDetail));
    assert.equal(conversation.state.session, null);
    assert.equal(conversation.state.saved.at(-1), null);
    assert.equal(backend.active.size, 0);
    assert.equal(backend.conversations.size, 0);
    assert.equal(worker.turn, null);
    assert.equal(launches.length, processCount);
    assert.equal(calls.length, toolCallCount);
    await waitFor(() => backend.workers.size === 0, "failed worker retirement");
  }

  assert.equal(cleanup.mock.calls.length, terminalErrors.length + 1);
  assert.deepEqual(
    warning.mock.calls.map((call) => call.arguments),
    Array(terminalErrors.length + 1).fill([
      "Antigravity turn media cleanup failed",
    ]),
  );
});

test("isolates a late malformed stdout tail from a saved idle session", async (t) => {
  const fixture = setup(t, { fakeWorkers: true });
  const conversation = fixture.chat("private:late-idle-malformed-tail");
  const diagnostics = [];
  const firstSubmitted = deferred();
  const firstRun = conversation.run("success", {
    onInputSubmitted: () => firstSubmitted.resolve(),
    onDiagnostic: (event) => diagnostics.push(event),
  });
  await Promise.race([
    firstSubmitted.promise,
    firstRun.then(() => {
      throw Error("First fake turn completed before input submission");
    }),
  ]);

  const firstWorker = fixture.syntheticWorkers[0];
  assert(firstWorker);
  assert.equal(firstWorker.inputs.length, 1);
  const nativeId = "00000000-0000-4000-8000-000000000105";
  firstWorker.emitFrames(...successfulFrames(nativeId));
  await firstRun;

  const idleWorker = [...fixture.backend.workers.values()][0];
  assert(idleWorker);
  const session = conversation.state.session;
  assert(session);
  assert.equal(session.id, nativeId);
  const nativeDirectory = path.join(
    fixture.backend.profile,
    "cli",
    "conversations",
  );
  fs.mkdirSync(nativeDirectory, { recursive: true });
  fs.writeFileSync(
    path.join(nativeDirectory, `${nativeId}.db`),
    "synthetic native conversation database\n",
  );
  const binding = idleWorker.details.binding;
  const bindingBefore = fs.readFileSync(binding, "utf8");
  assert.equal(JSON.parse(bindingBefore).id, nativeId);
  const diagnosticsAfterFirstTurn = structuredClone(diagnostics);

  firstWorker.stdout.write("{malformed synthetic idle tail");
  assert.equal(idleWorker.closed, true);
  assert.equal(idleWorker.available, false);
  assert.deepEqual(diagnostics, diagnosticsAfterFirstTurn);

  const secondSubmitted = deferred();
  const secondRun = conversation.run("success", {
    onInputSubmitted: () => secondSubmitted.resolve(),
  });
  await Promise.race([
    secondSubmitted.promise,
    secondRun.then(() => {
      throw Error("Second fake turn completed before input submission");
    }),
  ]);

  const replacement = fixture.syntheticWorkers[1];
  assert(replacement);
  assert.notEqual(replacement, firstWorker);
  const replacementWorker = [...fixture.backend.workers.values()][0];
  assert(replacementWorker);
  assert.notEqual(replacementWorker, idleWorker);
  assert.equal(fixture.launches.length, 2);
  assert.equal(replacement.inputs.length, 1);
  assert.equal(firstWorker.inputs.length + replacement.inputs.length, 2);
  assert.equal(replacementWorker.details.binding, binding);
  assert.equal(fs.readFileSync(binding, "utf8"), bindingBefore);
  assert.equal(conversation.state.session.id, nativeId);

  replacement.emitFrames(...successfulFrames(nativeId));
  await secondRun;

  assert.equal(conversation.state.session.id, nativeId);
  assert.equal(firstWorker.inputs.length + replacement.inputs.length, 2);
  assert.deepEqual(diagnostics, diagnosticsAfterFirstTurn);
  assert.equal(fixture.backend.workers.size, 1);
  assert.equal([...fixture.backend.workers.values()][0], replacementWorker);
  assert.equal(fixture.backend.active.size, 0);
  assert.equal(fixture.backend.conversations.size, 0);
});
