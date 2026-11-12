import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { config, fixture } from "./helpers.mjs";
import { createServer } from "../src/server.mjs";
import { readLocalSession } from "../src/backends/local-session-logs.mjs";

const group = "group:20000";
const epoch = Date.parse("2026-10-29T08:00:00.000Z");
const at = (offset) => new Date(epoch + offset).toISOString();

function writeLog(file, records) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(
    file,
    records.map((record) => JSON.stringify(record)).join("\n"),
  );
}

function turn(memory, session, index, extra = {}) {
  memory.identity.put("model_turns", {
    id: "turn-" + index,
    conversation: group,
    startedAt: epoch + index * 10000,
    endedAt: epoch + index * 10000 + 8000,
    status: "completed-no-send",
    backendSession: session,
    ...extra,
  });
}

test("admin transcript isolates QQ, desktop, subject, protected work and role ownership", async (t) => {
  const f = fixture(t, { cfg: config(2) });
  const m = f.store.bind("agent-0");
  const sid = randomUUID();
  const session = { backend: "codex", id: sid };
  m.setState(group, { ...m.state(group), session });
  for (let index = 0; index < 13; index++) turn(m, session, index);
  turn(m, session, 12, {
    status: "sent",
    backendTurnIds: ["native-12"],
    toolCalls: [
      { name: "conversation_read", ok: false, code: "TOOL_DISABLED" },
    ],
  });
  const shared = { backend: "codex", id: randomUUID() };
  turn(m, shared, 13, { conversation: "private:30000" });
  turn(m, shared, 14, { conversation: "@work:fixture" });
  const subject = { backend: "codex", id: randomUUID() };
  const oldSubject = { backend: "codex", id: randomUUID() };
  m.setState("@subject", { ...m.state("@subject"), session: subject });
  turn(m, subject, 15, { conversation: "@subject" });
  turn(m, oldSubject, 16, { conversation: "@subject" });
  m.identity.put("session_history", {
    id: "retired-subject",
    conversation: "@subject",
    session: oldSubject,
    at: epoch + 170000,
  });
  turn(m, { backend: "codex", id: randomUUID() }, 17, {
    conversation: "@social:fixture",
  });
  const desktop = { backend: "codex", id: randomUUID() };
  m.setState("@desktop", { ...m.state("@desktop"), session: desktop });
  turn(m, desktop, 18, { conversation: "@desktop" });
  m.append({
    dedupe: "desktop-reply",
    conversation: "@desktop",
    kind: "message.sent",
    direction: "out",
    status: "confirmed",
    body: "已显示的桌面回复",
    occurredAt: at(189000),
    observedAt: at(189000),
    payload: { desktop: { turnId: "turn-18" } },
  });
  m.append({
    dedupe: "other-desktop-reply",
    conversation: "@desktop",
    kind: "message.sent",
    direction: "out",
    status: "confirmed",
    body: "其他桌面回合",
    occurredAt: at(185000),
    observedAt: at(185000),
    payload: { desktop: { turnId: "another-turn" } },
  });
  turn(f.store.bind("agent-1"), session, 12);
  const log = (offset, type, payload) => ({
    timestamp: at(offset),
    type,
    payload,
  });
  const capability = "a".repeat(43);
  const credential = "b".repeat(24);
  writeLog(
    path.join(
      f.root,
      "codex",
      "agent-0",
      "home",
      "archived_sessions",
      "rollout-" + sid + ".jsonl",
    ),
    [
      log(1000, "response_item", {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "最早的回合" }],
      }),
      log(120010, "event_msg", { type: "task_started", turn_id: "native-12" }),
      log(120030, "response_item", {
        type: "message",
        role: "user",
        content: [
          {
            type: "input_text",
            text:
              "合成输入 context=" +
              capability +
              " OPENAI_API_KEY=" +
              credential,
          },
        ],
      }),
      log(120050, "response_item", {
        type: "reasoning",
        encrypted_content: "opaque fixture",
        summary: [{ type: "summary_text", text: "合成思考摘要" }],
      }),
      log(120080, "response_item", {
        type: "function_call",
        name: "qq_reply_call",
        arguments: "private tool arguments",
      }),
      log(120090, "response_item", {
        type: "function_call_output",
        output: "private tool output",
      }),
      log(120100, "response_item", {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "合成模型输出" }],
      }),
    ],
  );
  writeLog(
    path.join(
      f.root,
      "codex",
      "agent-0",
      "home",
      "sessions",
      "rollout-" + shared.id + ".jsonl",
    ),
    [
      log(131000, "response_item", {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "ambiguous native scope" }],
      }),
    ],
  );
  writeLog(
    path.join(
      f.root,
      "codex",
      "agent-0",
      "home",
      "sessions",
      "rollout-" + subject.id + ".jsonl",
    ),
    [
      log(150050, "response_item", {
        type: "reasoning",
        summary: [{ type: "summary_text", text: "合成主人格思考" }],
      }),
      log(150100, "response_item", {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "合成主人格输出" }],
      }),
    ],
  );
  m.append({
    dedupe: "subject-delivery-fixture",
    conversation: "@subject",
    kind: "message.sent",
    direction: "out",
    status: "confirmed",
    body: "internal event",
    occurredAt: at(150120),
    observedAt: at(150120),
  });
  for (const [status, body, owner] of [
    ["confirmed", "合成送达", "agent-0"],
    ["unknown", "unknown delivery", "agent-0"],
    ["confirmed", "other role delivery", "agent-1"],
  ]) {
    f.store.bind(owner).append({
      dedupe: body,
      conversation: group,
      kind: "message.sent",
      direction: "out",
      status,
      body,
      occurredAt: at(120120),
      observedAt: at(120120),
    });
  }

  const token = randomBytes(32).toString("hex");
  const server = createServer({ runtime: f.runtime, token });
  const port = await server.listen();
  t.after(() => server.close());
  const request = (params = {}, headers = { "x-admin-token": token }) =>
    fetch(
      `http://127.0.0.1:${port}/api/session-transcripts?${new URLSearchParams({ agentId: "agent-0", ...params })}`,
      { headers },
    );
  assert.equal((await request({}, {})).status, 401);
  assert.equal(
    (
      await request(
        {},
        { "x-admin-token": token, origin: "https://example.invalid" },
      )
    ).status,
    403,
  );
  const { sessions } = await (await request()).json();
  assert.deepEqual(
    sessions.map((s) => [s.scope, s.conversation, s.current, s.count]),
    [
      ["desktop", "@desktop", true, 1],
      ["subject", "@subject", true, 1],
      ["chat", group, true, 13],
      ["subject", "@subject", false, 1],
      ["chat", "private:30000", false, 1],
    ],
  );
  assert(!JSON.stringify(sessions).includes(sid));
  const [desktopEntry, currentSubject, { key }, historicalSubject, ambiguous] =
    sessions;
  assert.equal(
    (await request({ key: desktopEntry.key, agentId: "agent-1" })).status,
    404,
  );
  const desktopPage = await (await request({ key: desktopEntry.key })).json();
  assert.equal(desktopPage.session.scope, "desktop");
  assert.equal(desktopPage.turns[0].id, "turn-18");
  assert.deepEqual(
    desktopPage.turns[0].delivered.map(({ text }) => text),
    ["已显示的桌面回复"],
  );
  assert.equal(
    (await request({ key: currentSubject.key, agentId: "agent-1" })).status,
    404,
  );
  const subjectPage = await (await request({ key: currentSubject.key })).json();
  assert.equal(subjectPage.source, "available");
  assert.deepEqual(
    subjectPage.turns[0].steps.map((step) => [step.kind, step.text]),
    [
      ["summary", "合成主人格思考"],
      ["output", "合成主人格输出"],
    ],
  );
  assert.deepEqual(subjectPage.turns[0].delivered, []);
  assert.equal(
    (await (await request({ key: historicalSubject.key })).json()).turns[0].id,
    "turn-16",
  );
  assert.equal((await request({ key, before: "turn-15" })).status, 400);
  assert.equal((await request({ key, agentId: "agent-1" })).status, 404);
  assert.equal((await request({ key: "../fixture" })).status, 400);
  assert.equal(
    (await (await request({ key, before: "missing" })).json()).error,
    "INVALID_CURSOR",
  );
  const page = await (await request({ key })).json();
  assert.equal(page.source, "available");
  assert.equal(page.turns.length, 12);
  assert.equal(page.nextBefore, "turn-1");
  const latest = page.turns.at(-1);
  assert.deepEqual(
    latest.steps.map((s) => s.kind),
    ["input", "summary", "tool", "output"],
  );
  assert.match(latest.steps[0].text, /OPENAI_API_KEY=\[凭据已隐藏\]/);
  assert.deepEqual(latest.errors, ["TOOL_DISABLED"]);
  assert.deepEqual(
    latest.delivered.map((entry) => entry.text),
    ["合成送达"],
  );
  for (const hidden of [
    capability,
    credential,
    "opaque fixture",
    "private tool",
    "unknown delivery",
    "other role delivery",
    sid,
  ])
    assert(!JSON.stringify(page).includes(hidden));
  const older = await (await request({ key, before: page.nextBefore })).json();
  assert.equal(older.nextBefore, null);
  assert.deepEqual(
    older.turns.map((r) => r.steps[0]?.text),
    ["最早的回合"],
  );
  const blocked = await (await request({ key: ambiguous.key })).json();
  assert.equal(blocked.source, "unavailable");
  assert.deepEqual(blocked.turns[0].steps, []);
  const other = await (await request({ agentId: "agent-1" })).json();
  const otherPage = await (
    await request({ agentId: "agent-1", key: other.sessions[0].key })
  ).json();
  assert.equal(otherPage.source, "unavailable");
});

test("Antigravity and DSH journals expose saved reasoning, omitting raw tool data", async (t) => {
  const f = fixture(t);
  const agentId = "agent-0";
  const sid = randomUUID();
  const dshHome = path.join(f.root, "dsh-home");
  const oldHome = process.env.DSH_HOME;
  process.env.DSH_HOME = dshHome;
  t.after(() => {
    if (oldHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = oldHome;
  });
  writeLog(
    path.join(
      f.root,
      "antigravity",
      agentId,
      "profile",
      "cli",
      "brain",
      sid,
      "trajectory",
      "logs",
      "records.jsonl",
    ),
    [
      {
        created_at: at(10),
        step_index: 0,
        type: "USER_INPUT",
        content: "合成请求",
      },
      {
        created_at: at(20),
        step_index: 1,
        type: "PLANNER_RESPONSE",
        thinking: "合成思考",
        tool_calls: [{ name: "bridge_call", arguments: "hidden args" }],
        content: "合成输出",
      },
      {
        created_at: at(30),
        step_index: 2,
        type: "ERROR_MESSAGE",
        error: "unknown tool hidden args",
      },
    ],
  );
  const dshSid = "session-" + sid;
  const folder =
    "--" +
    path
      .join(f.root, "dsh-workspaces", agentId)
      .replace(/^[\\/]+/, "")
      .replace(/[\\/:]/g, "-") +
    "--";
  writeLog(path.join(dshHome, "sessions", folder, dshSid, "journal.jsonl"), [
    { time: at(10), seq: 0, type: "turn/start", data: { turn: 2 } },
    {
      time: at(20),
      seq: 1,
      type: "assistant/message",
      data: {
        message: {
          content: [
            { type: "reasoning", text: "合成思考" },
            { type: "text", text: "合成输出" },
          ],
        },
      },
    },
    {
      time: at(30),
      seq: 2,
      type: "tool/call",
      data: {
        name: "mcp__fixture__bridge_call",
        arguments: JSON.stringify({
          name: "conversation_read",
          context: "hidden args",
        }),
      },
    },
  ]);
  for (const [backend, id, expected] of [
    [
      "antigravity",
      sid,
      [
        "合成请求",
        "合成思考",
        "bridge_call",
        "合成输出",
        "NATIVE_TOOL_UNAVAILABLE",
      ],
    ],
    ["dsh", dshSid, ["合成思考", "合成输出", "conversation_read"]],
  ]) {
    const result = await readLocalSession({
      root: f.root,
      agentId,
      backend,
      sid: id,
      from: epoch,
      until: epoch + 100,
    });
    assert.equal(result.source, "available");
    assert.deepEqual(
      result.entries.map((entry) => entry.text),
      expected,
    );
    assert.equal(
      result.entries.find((entry) => entry.kind === "thinking").nativeTurn,
      backend === "dsh" ? "2" : undefined,
    );
  }
});
