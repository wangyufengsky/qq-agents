import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import { waitForTerminalObservation } from "./antigravity-fixture-terminal.mjs";

const args = process.argv.slice(2);
const option = (name) => {
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
};
const endpoint = process.env.QQ_AGY_ENDPOINT;
const token = process.env.QQ_AGY_TOKEN;
const logFile = process.env.AGY_STREAM_FIXTURE_LOG;
const controlFile = process.env.AGY_STREAM_FIXTURE_CONTROL;
const headers = {
  authorization: `Bearer ${token}`,
  "content-type": "application/json",
};
const conversationId = option("--conversation") || randomUUID();
const nativeDirectory = path.join(
  option("--gemini_dir"),
  "cli",
  "conversations",
);
const nativeFile = path.join(nativeDirectory, `${conversationId}.db`);
let turnCount = 0;
let lastStep = 0;

function record(value) {
  fs.appendFileSync(
    logFile,
    `${JSON.stringify({ pid: process.pid, ...value })}\n`,
  );
}

function event(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function result(status = "SUCCESS") {
  return {
    event: "result",
    result: {
      status,
      conversation_id: conversationId,
      response: "Synthetic fixture response.",
      usage: {
        input_tokens: 900000,
        output_tokens: 5000,
        total_tokens: 905000,
      },
      ...(status === "ERROR" ? { error: "Synthetic fixture failure." } : {}),
    },
  };
}

async function postTool(epoch, phase) {
  try {
    const response = await fetch(`${endpoint}/call`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        name: "qq_turn_call",
        arguments: { epoch, name: "probe", arguments: { value: phase } },
      }),
    });
    await response.arrayBuffer();
    record({ type: "call", phase, epoch, status: response.status });
    return response.status;
  } catch {
    record({ type: "call", phase, epoch, status: null });
    return null;
  }
}

function control() {
  try {
    return JSON.parse(fs.readFileSync(controlFile, "utf8"));
  } catch {
    return {};
  }
}

async function waitForControl(name) {
  const deadline = Date.now() + 10000;
  while (!control()[name]) {
    if (Date.now() >= deadline) throw Error(`FIXTURE_CONTROL_TIMEOUT_${name}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function handleInput(line) {
  const input = JSON.parse(line);
  const content = input?.message?.content;
  const epochMatch =
    typeof content === "string" && /epoch=([a-f0-9]{32})/.exec(content);
  if (input.event !== "user" || !epochMatch)
    throw Error("FIXTURE_INPUT_MISSING_EPOCH");
  const epoch = epochMatch[1];
  const modeMatch = /fixtureMode=([a-z-]+)/.exec(content);
  const mode = modeMatch?.[1] || "success";
  turnCount += 1;
  record({ type: "input", turn: turnCount, epoch, mode });

  const catalogueResponse = await fetch(`${endpoint}/catalog`, { headers });
  const catalogue = await catalogueResponse.json();
  if (
    !catalogueResponse.ok ||
    catalogue.turnEpoch !== epoch ||
    !catalogue.tools?.some((tool) => tool.name === "qq_turn_call") ||
    !catalogue.turnTools?.some((tool) => tool.name === "probe") ||
    !Array.isArray(catalogue.images) ||
    catalogue.conversationId !== (turnCount === 1 ? "" : conversationId) ||
    catalogue.minimumStep !== (turnCount === 1 ? -1 : lastStep)
  )
    throw Error("FIXTURE_CATALOG_MISMATCH");
  record({
    type: "catalog",
    turn: turnCount,
    epoch,
    conversationId: catalogue.conversationId,
    minimumStep: catalogue.minimumStep,
  });

  if (!fs.existsSync(nativeFile)) {
    fs.mkdirSync(nativeDirectory, { recursive: true });
    fs.writeFileSync(nativeFile, "synthetic native conversation database\n");
  }
  const init = {
    event: "init",
    conversation_id: conversationId,
    init: { agent: "qq-agents-fixture" },
  };
  if (mode === "duplicate-init") {
    const line = JSON.stringify(init);
    process.stdout.write(`${line}\n${line}\n`);
    record({ type: "init", turn: turnCount, conversationId, duplicate: true });
    return;
  }
  if (turnCount === 1) {
    event(init);
    record({ type: "init", turn: turnCount, conversationId });
  }

  if (mode === "hold") {
    await waitForControl("release");
  } else if (mode === "pending-terminal") {
    void postTool(epoch, "pending");
    // The parent acknowledges actual tool admission, not elapsed wall time.
    await waitForControl("pendingEntered");
    lastStep += 1;
    event({
      event: "step_update",
      step_update: {
        conversation_id: conversationId,
        step_index: lastStep,
        step_type: "agent_response",
        state: "DONE",
        usage: { input_tokens: 10, output_tokens: 2, cache_read_tokens: 1 },
      },
    });
    record({ type: "step", turn: turnCount, stepIndex: lastStep });
    process.stdout.write(`${JSON.stringify(result())}\n`);
    record({
      type: "terminal",
      turn: turnCount,
      conversationId,
      status: "SUCCESS",
    });
    return;
  } else if (mode === "stale-epoch") {
    // The test's previous epoch is supplied separately through this marker.
    const prior = /fixturePriorEpoch=([a-f0-9]{32})/.exec(content)?.[1];
    if (!prior) throw Error("FIXTURE_PRIOR_EPOCH_MISSING");
    await postTool(prior, "stale-epoch");
    await postTool(epoch, "current-epoch");
  } else if (
    ["success", "idle-probe", "stale-epoch", "invalid-usage"].includes(mode)
  ) {
    if (mode !== "stale-epoch") await postTool(epoch, "current-epoch");
  }

  if (mode === "duplicate-result") {
    lastStep += 1;
    event({
      event: "step_update",
      step_update: {
        conversation_id: conversationId,
        step_index: lastStep,
        step_type: "agent_response",
        state: "DONE",
        usage: { input_tokens: 100, output_tokens: 10, cache_read_tokens: 5 },
      },
    });
    record({ type: "step", turn: turnCount, stepIndex: lastStep });
    const terminal = JSON.stringify(result());
    process.stdout.write(`${terminal}\n${terminal}\n`);
    record({
      type: "terminal",
      turn: turnCount,
      conversationId,
      status: "SUCCESS",
      duplicate: true,
    });
    return;
  }

  if (mode === "no-response") {
    event(result());
    record({
      type: "terminal",
      turn: turnCount,
      conversationId,
      status: "SUCCESS",
    });
    return;
  }

  if (mode === "old-step") {
    event({
      event: "step_update",
      step_update: {
        conversation_id: conversationId,
        step_index: lastStep,
        step_type: "agent_response",
        state: "DONE",
        usage: { input_tokens: 100, output_tokens: 10, cache_read_tokens: 5 },
      },
    });
    record({ type: "step", turn: turnCount, stepIndex: lastStep, stale: true });
    event(result());
    record({
      type: "terminal",
      turn: turnCount,
      conversationId,
      status: "SUCCESS",
      staleStep: lastStep,
    });
    return;
  }

  const usage =
    mode === "stale-epoch" || mode === "invalid-usage"
      ? { input_tokens: -1, output_tokens: 10, cache_read_tokens: 0 }
      : {
          input_tokens: turnCount * 100,
          output_tokens: 10,
          cache_read_tokens: 5,
        };
  if (mode !== "no-response") {
    if (mode !== "old-step") lastStep += 1;
    event({
      event: "step_update",
      step_update: {
        conversation_id: conversationId,
        step_index: lastStep,
        step_type: "agent_response",
        state: "DONE",
        usage,
      },
    });
    record({ type: "step", turn: turnCount, stepIndex: lastStep });
  }

  const terminal = result(mode === "failure" ? "ERROR" : "SUCCESS");
  if (mode === "wrong-result") terminal.result.conversation_id = randomUUID();
  event(terminal);
  record({
    type: "terminal",
    turn: turnCount,
    conversationId,
    status: terminal.result.status,
  });
  if (terminal.result.status === "SUCCESS") {
    await waitForTerminalObservation(endpoint, headers, epoch);
    if ((await postTool(epoch, "terminal-late")) !== 403)
      throw Error("COMPLETED_TURN_ALLOWED");
  }
  if (mode === "idle-probe") {
    await waitForControl("probeIdle");
    await postTool(epoch, "idle-probe");
  }
}

record({ type: "spawn", conversationId, nativeFile });
const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of input) {
  if (!line.trim()) continue;
  try {
    await handleInput(line);
  } catch (error) {
    record({ type: "fixture-error", message: String(error?.message || error) });
    process.exitCode = 1;
    break;
  }
}
