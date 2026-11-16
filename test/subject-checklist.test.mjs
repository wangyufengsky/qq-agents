import test from "node:test";
import assert from "node:assert/strict";
import { BackendTurnFailure } from "../src/backends/turn-failure.mjs";
import { config, fixture, settle } from "./helpers.mjs";

const subject = "@subject";
const agentId = "agent-0";
const group = "group:20000";
const personId = "30000";
const start = Date.UTC(2026, 0, 1, 12);
const checklist = (p) => p.prompt.startsWith("收尾检查单");

function setup(t, run, configure = () => {}) {
  const cfg = config(1);
  const agent = cfg.agents[0];
  agent.contextPolicy.capacityTokens = 131072;
  agent.subject.enabled = true;
  agent.subject.inboxEnabled = true;
  configure(agent);
  const calls = [];
  let now = start;
  const f = fixture(t, {
    cfg,
    run: async (p) => {
      calls.push(p);
      if (!p.session)
        p.saveSession({ id: "fixture-session", backend: "fixture" });
      await run?.(p);
    },
  });
  f.runtime.clock = () => new Date(now);
  const memory = f.store.bind(agentId);
  memory.setState(subject, { ...memory.state(subject), nextCheckAt: now });
  return {
    ...f,
    memory,
    calls,
    checks: () => calls.filter(checklist),
    incoming() {
      return memory.append({
        connectionId: "qq-0",
        conversation: group,
        kind: "message.received",
        senderId: personId,
        messageId: "1000",
        dedupe: "checklist-fixture-message",
        body: "以后请叫我小林。",
        occurredAt: new Date(now).toISOString(),
        payload: { trustedInput: true, accountId: "10000" },
      }).id;
    },
    async tick(at = start) {
      now = at;
      f.runtime.subject.tick();
      await settle(f.runtime);
    },
  };
}

test("an idle subject turn with only unread activity has no checklist continuation", async (t) => {
  const f = setup(t);
  f.incoming();
  await f.tick();
  assert.equal(f.calls.length, 1);
  assert.equal(f.checks().length, 0);
});

test("a new person read lights only the unfinished topic, once, and may be skipped", async (t) => {
  let id;
  const f = setup(t, async (p) => {
    if (checklist(p)) return;
    await p.callTool("memory_read", { id });
    await p.callTool("mood_set", {
      mood: "轻松",
      intensity: 2,
      reason: "想清楚了",
      evidence: [id],
    });
    await assert.rejects(
      p.callTool("person_note", {
        personId,
        body: "希望被叫小林",
        evidence: [id],
        expectedRevision: 99,
      }),
      /REVISION_CONFLICT/,
    );
  });
  f.memory.identity.setMood(
    { mood: "平静", intensity: 2, reason: "整理过了" },
    {
      writtenIn: subject,
      now: start - 2 * 86400000,
    },
  );
  id = f.incoming();
  await f.tick();
  const [first, follow] = f.calls;
  assert.equal(f.calls.length, 2);
  assert.match(follow.prompt, /人物卡或相处事项（person_note、person_item）/);
  assert.match(follow.prompt, /可以全部跳过/);
  assert.doesNotMatch(
    follow.prompt,
    /mood_set|subject_log|self_review|subject_next_wake/,
  );
  assert.equal(first.session ?? null, null);
  assert.equal(follow.session.id, "fixture-session");
  assert.deepEqual(follow.tools, first.tools);
  assert.deepEqual(follow.inputImages, []);
  const turns = f.memory.identity.list("model_turns");
  assert.equal(turns.length, 1);
  assert.equal(turns[0].status, "completed-no-send");
});

for (const [label, budget, changePerson] of [
  ["both accomplishments", 8, true],
  ["no remaining tools", 1, false],
]) {
  test(`the checklist is skipped when ${label} leave no actionable item`, async (t) => {
    let id;
    const f = setup(
      t,
      async (p) => {
        await p.callTool("memory_read", { id });
        if (changePerson)
          await p.callTool("person_note", {
            personId,
            body: "希望被叫小林",
            evidence: [id],
          });
      },
      (agent) => {
        agent.subject.maxToolCallsPerTurn = budget;
      },
    );
    id = f.incoming();
    await f.tick();
    assert.equal(f.calls.length, 1);
    if (changePerson)
      assert.equal(f.memory.identity.personCard(personId).body, "希望被叫小林");
  });
}

test("stale mood needs recent interaction and can be offered alongside person notes", async (t) => {
  let id;
  const f = setup(t, async (p) => {
    if (!checklist(p)) await p.callTool("memory_read", { id });
  });
  f.memory.identity.setMood(
    { mood: "平静", intensity: 2, reason: "整理过了" },
    {
      writtenIn: subject,
      now: start - 2 * 86400000,
    },
  );
  id = f.incoming();
  await f.tick();
  assert.equal(f.checks().length, 1);
  assert.match(f.checks()[0].prompt, /心情（mood_set）/);
  assert.match(f.checks()[0].prompt, /人物卡或相处事项/);
});

test("project progress and unreviewed Self can share an actionable continuation in the same turn", async (t) => {
  const review = (id) => ({
    id,
    expectedRevision: 1,
    expectedVersion: 1,
    action: "observe",
    reason: "证据还不够",
  });
  const f = setup(t, async (p) => {
    if (checklist(p)) {
      await p.callTool("subject_next_wake", {
        minutes: 10,
        note: "继续写下段",
      });
      await p.callTool("self_review", review("candidate-other"));
      return;
    }
    await p.callTool("self_review", review("candidate-observed"));
    await p.callTool("project", {
      title: "小项目",
      why: "想试一试",
      progress: "写完开头",
      next: "继续写下段",
    });
    await p.callTool("subject_log", { did: "wrote", summary: "写完开头" });
  });
  for (const id of ["candidate-observed", "candidate-other"])
    f.memory.identity.put("self_candidates", {
      id,
      revision: 1,
      status: "pending",
      createdAt: start - 60000,
      reviewAfter: start - 1,
      body: "记录一点观察",
      reviews: [],
    });
  await f.tick();
  const [follow] = f.checks();
  assert.equal(f.calls.length, 2);
  assert.match(follow.prompt, /Self（self_review）/);
  assert.match(
    follow.prompt,
    /下次唤醒或休息（subject_next_wake、subject_rest）/,
  );
  assert.doesNotMatch(follow.prompt, /subject_log|人物卡|心情/);
  assert.equal(
    f.memory.identity.get("self_candidates", "candidate-other").revision,
    2,
  );
  assert.equal(f.memory.state(subject).nextCheckAt, start + 600000);
  const [turn] = f.memory.identity.list("model_turns");
  assert(
    turn.toolCalls.some(({ name, ok }) => name === "subject_next_wake" && ok),
  );
});

test("a completed project can suggest a log without a continuing plan", async (t) => {
  const f = setup(t, async (p) => {
    if (checklist(p)) return;
    const project = await p.callTool("project", {
      title: "小项目",
      why: "整理资料",
    });
    await p.callTool("project", {
      id: project.id,
      expectedRevision: project.revision,
      status: "done",
      outcome: "整理完毕",
    });
  });
  await f.tick();
  assert.equal(f.checks().length, 1);
  assert.match(f.checks()[0].prompt, /记录进展（subject_log、diary_write）/);
  assert.doesNotMatch(f.checks()[0].prompt, /subject_next_wake/);
});

for (const proposalKind of ["reminder", "rest"]) {
  test(`only handling a reminder makes an inbox decision eligible for the checklist (${proposalKind})`, async (t) => {
    const f = setup(t, async (p) => {
      if (checklist(p)) return;
      const { items } = await p.callTool("subject_inbox_list", {});
      await p.callTool("subject_inbox_decide", {
        id: items[0].id,
        expectedRevision: items[0].revision,
        action: "dismiss",
      });
      if (proposalKind === "rest")
        await p.callTool("project", {
          title: "小项目",
          why: "想试一试",
          progress: "写完开头",
          next: "继续写下段",
        });
    });
    f.memory.setState("@subject-inbox", {
      items: [
        {
          id: group + "/proposal",
          source: group,
          status: "pending",
          revision: 1,
          createdAt: start,
          reviewAt: start,
          proposal: { kind: proposalKind },
          ...(proposalKind === "reminder" && {
            reminder: { dueAt: start + 600000, expiresAt: start + 1500000 },
          }),
        },
      ],
    });
    await f.tick();
    assert.equal(f.checks().length, proposalKind === "reminder" ? 1 : 0);
    if (proposalKind === "reminder")
      assert.match(f.checks()[0].prompt, /subject_next_wake/);
  });
}

test("a recoverable checklist failure ends the original turn without retrying the checklist", async (t) => {
  let id;
  const f = setup(t, async (p) => {
    if (checklist(p)) {
      const error = new BackendTurnFailure(
        "openai",
        "TRANSPORT",
        "response-stream",
        "fixture-checklist",
        true,
      );
      error.sessionReusable = true;
      throw error;
    }
    await p.callTool("memory_read", { id });
  });
  id = f.incoming();
  await f.tick();
  assert.equal(f.calls.length, 2);
  const [turn] = f.memory.identity.list("model_turns");
  assert.equal(turn.status, "completed-no-send");
  assert.equal(turn.inputStage, "submission-attempted");
  assert.equal(f.memory.state(subject).session.id, "fixture-session");
});

test("ordinary group and private turns never run the dynamic checklist", async (t) => {
  const f = setup(t, async (p) => {
    await p.callTool("project", {
      title: "小项目",
      why: "想试一试",
      progress: "写完开头",
      next: "继续写下段",
    });
  });
  for (const conversation of [group, "private:30000"])
    assert.equal(
      (await f.runtime.wake(agentId, conversation)).status,
      "completed-no-send",
    );
  assert.equal(f.calls.length, 2);
  assert.equal(f.checks().length, 0);
});
