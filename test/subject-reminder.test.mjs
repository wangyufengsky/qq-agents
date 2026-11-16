import test from "node:test";
import assert from "node:assert/strict";
import {
  config,
  context,
  fixture,
  raw,
  sendReviewed,
  settle,
} from "./helpers.mjs";

const agentId = "agent-0";
const subject = "@subject";
const group = "group:20000";
const owner = "private:30000";
const note = "提醒我检查项目草稿";
const minute = 60000;

function setup(t, run) {
  const cfg = config(1);
  const agent = cfg.agents[0];
  Object.assign(agent.subject, {
    enabled: true,
    inboxEnabled: true,
    groups: ["20000"],
    maxContactsPerDay: 1,
  });
  agent.ownerIds = ["30000"];
  let now = Date.UTC(2026, 0, 1, 12);
  const f = fixture(t, { cfg, run });
  f.runtime.clock = () => new Date(now);
  return {
    ...f,
    memory: f.store.bind(agentId),
    transport: f.runtime.transports.get("qq-0"),
    async receive(messageId, target, sender = 30000) {
      await f.runtime.ingest(
        "qq-0",
        raw(messageId, {
          message_type: target === owner ? "private" : "group",
          ...(target === owner && { group_id: undefined }),
          user_id: sender,
          time: now / 1000,
          message: [
            { type: "text", data: { text: "10 分钟后提醒我检查项目草稿" } },
          ],
        }),
      );
      return this.memory.db
        .prepare(
          "SELECT id FROM events WHERE agent_id=? AND kind='message.received' AND message_id=?",
        )
        .get(agentId, String(messageId)).id;
    },
    async tick(at = now) {
      now = at;
      f.runtime.tick();
      await settle(f.runtime);
    },
  };
}

function submit(eventId, suffix = "") {
  return {
    requestId: "reminder" + suffix,
    proposal: { kind: "reminder", eventId, minutes: 10, note },
  };
}

for (const [target, timeout] of [
  [group, false],
  [owner, false],
  [group, true],
]) {
  test(`a QQ reminder returns once to ${target} at the original due time despite contact cooldown${timeout ? " even when receipt is unknown" : ""}`, async (t) => {
    let proposal,
      accepted,
      reminderWakes = 0,
      targetTurns = 0;
    const f = setup(t, async (p) => {
      if (p.conversation === subject) {
        if (p.prompt.includes('"reason":"subject-reminder"')) {
          reminderWakes++;
          assert.match(p.prompt, /提醒我检查项目草稿/);
        }
        return;
      }
      assert.equal(p.conversation, target);
      const list = await p.callTool("intent_list", { activeOnly: true });
      const reminder = list.items.find((item) => item.reminder);
      if (!reminder) {
        const { id } = f.memory.db
          .prepare(
            "SELECT id FROM events WHERE agent_id=? AND kind='message.received'",
          )
          .get(agentId);
        proposal = await p.callTool("subject_inbox_submit", submit(id));
        return;
      }
      targetTurns++;
      await p.callTool("intent_decide", {
        id: reminder.id,
        expectedRevision: reminder.revision,
        action: "send",
        reason: "按约提醒",
      });
      const send = (args) => p.callTool("qq_send", args);
      const delivery = sendReviewed(send, {
        requestId: "reminder-send",
        text: "到时间啦，记得检查项目草稿。",
      });
      if (timeout) await assert.rejects(delivery, /DELIVERY_UNKNOWN/);
      else await delivery;
      await assert.rejects(
        send({ requestId: "second-send", text: "再提醒一次。" }),
      );
    });
    const receivedAt = f.runtime.now();
    const autonomousAt = receivedAt + 40 * minute;
    f.memory.setState(subject, {
      ...f.memory.state(subject),
      nextCheckAt: autonomousAt,
      nextCheckNote: "继续自己的工作",
    });
    await f.receive(1, target);
    await f.tick();
    if (!proposal)
      assert.equal(
        (await f.runtime.wake(agentId, target)).status,
        "completed-no-send",
      );
    assert.equal(proposal.status, "pending");
    await f.tick(receivedAt + 2 * minute);
    const approve = { id: proposal.id, expectedRevision: 1, action: "accept" };
    const ctx = context(f.runtime, agentId, subject);
    accepted = await f.runtime.callTool(ctx, "subject_inbox_decide", approve);
    assert.equal(accepted.status, "accepted");
    assert.equal(accepted.dueAt, receivedAt + 10 * minute);
    const duplicate = await f.runtime.callTool(
      ctx,
      "subject_inbox_decide",
      approve,
    );
    assert.equal(duplicate.reminderIntentId, accepted.reminderIntentId);
    const before = f.memory.state(subject);
    f.memory.setState(subject, {
      ...before,
      contacts: [f.runtime.now()],
      lastContactAt: f.runtime.now(),
    });
    f.memory.setState(target, {
      ...f.memory.state(target),
      replyBatchSends: 50,
      proactiveCooldownUntil: autonomousAt,
    });
    assert.deepEqual(
      (
        await f.runtime.callTool(
          context(f.runtime, agentId, "group:20001"),
          "intent_list",
          { activeOnly: true },
        )
      ).items,
      [],
    );
    await f.tick(accepted.dueAt - 1);
    assert.equal(reminderWakes, 0);
    assert.equal(f.transport.sent.length, 0);
    if (timeout) f.transport.failure = "TIMEOUT";
    await f.tick(accepted.dueAt);
    await f.tick();
    assert.equal(reminderWakes, 1);
    assert.equal(targetTurns, 1);
    assert.equal(f.transport.sent.length, 1);
    assert.equal(f.transport.sent[0].conversation, target);
    assert.equal(
      f.memory.delivery("intent:" + accepted.reminderIntentId).status,
      timeout ? "unknown" : "sent",
    );
    assert.equal(f.memory.state(subject).nextCheckAt, autonomousAt);
    assert.deepEqual(f.memory.state(subject).checks, [accepted.dueAt]);
    await f.tick(accepted.dueAt + minute);
    assert.equal(f.transport.sent.length, 1);
    const receipts = await f.runtime.callTool(
      context(f.runtime, agentId, target),
      "subject_inbox_list",
      {},
    );
    assert.equal(
      receipts.items[0].reminderStatus,
      timeout ? "unknown" : "completed",
    );
    assert.equal(
      receipts.items[0].deliveryStatus,
      timeout ? "unknown" : "sent",
    );
  });
}

test("reminder proposals require a live administrator message actually presented in the source chat", async (t) => {
  let checked = false;
  const f = setup(t, async (p) => {
    if (p.conversation !== group) return;
    const { id } = f.memory.db
      .prepare(
        "SELECT id FROM events WHERE agent_id=? AND kind='message.received'",
      )
      .get(agentId);
    await assert.rejects(
      p.callTool("subject_inbox_submit", submit(id)),
      /SUBJECT_REMINDER_SOURCE_DENIED/,
    );
    checked = true;
  });
  const id = await f.receive(2, group, 30001);
  await f.tick();
  if (!checked)
    assert.equal(
      (await f.runtime.wake(agentId, group)).status,
      "completed-no-send",
    );
  assert.equal(checked, true);
  await assert.rejects(
    f.runtime.callTool(
      context(f.runtime, agentId, "group:20001"),
      "subject_inbox_submit",
      submit(id),
    ),
    /SUBJECT_REMINDER_SOURCE_DENIED/,
  );
});

test("an approved reminder waits while paused and expires without a late send", async (t) => {
  let proposal;
  const f = setup(t, async (p) => {
    if (p.conversation !== group) return;
    const { id } = f.memory.db
      .prepare(
        "SELECT id FROM events WHERE agent_id=? AND kind='message.received'",
      )
      .get(agentId);
    proposal = await p.callTool("subject_inbox_submit", submit(id));
  });
  await f.receive(3, group);
  await f.tick();
  if (!proposal)
    assert.equal(
      (await f.runtime.wake(agentId, group)).status,
      "completed-no-send",
    );
  const approved = await f.runtime.callTool(
    context(f.runtime, agentId, subject),
    "subject_inbox_decide",
    {
      id: proposal.id,
      expectedRevision: 1,
      action: "accept",
    },
  );
  f.runtime.config.globalPaused = true;
  await f.tick(approved.dueAt);
  assert.equal(
    f.memory.identity.get("intentions", approved.reminderIntentId).reminder
      .wakeStartedAt,
    undefined,
  );
  f.runtime.config.globalPaused = false;
  await f.tick(approved.expiresAt);
  assert.equal(
    f.memory.identity.get("intentions", approved.reminderIntentId).status,
    "expired",
  );
  assert.equal(f.transport.sent.length, 0);
});
