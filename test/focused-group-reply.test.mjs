import test from "node:test";
import assert from "node:assert/strict";
import { config, fixture, raw } from "./helpers.mjs";

async function group(t, run, enabled = true) {
  const cfg = config(1);
  cfg.privateLikeGroups = ["20000"];
  Object.assign(cfg.agents[0].wake, {
    private: false,
    participation: 0,
    names: false,
  });
  cfg.agents[0].behavior.focusedGroupReply = enabled;
  const f = fixture(t, { cfg, run });
  const ingest = (id, message) =>
    f.runtime.ingest("qq-0", raw(id, { message }));
  for (let id = 1; id < 42; id++) await ingest(id, "合成积压消息");
  await ingest(42, "当前来信");
  const memory = f.store.bind("agent-0");
  const source = memory.db
    .prepare("SELECT id,seq FROM events WHERE message_id='42'")
    .get();
  return {
    ...f,
    ingest,
    source,
    memory,
    wake: () =>
      f.runtime.wake("agent-0", "group:20000", {
        reasons: [{ reason: "private", seq: source.seq }],
      }),
    sent: () => f.runtime.transports.get("qq-0").sent,
    reviewed: () =>
      memory.db
        .prepare(
          `SELECT e.message_id FROM input_versions v JOIN events e ON e.id=v.id WHERE v.current=1 AND json_array_length(v.reviewed_deliveries)>0 ORDER BY v.seq`,
        )
        .all()
        .map((r) => r.message_id),
  };
}

const quoted = (id, text) => [
  { type: "reply", data: { id: String(id) } },
  { type: "text", data: { text } },
];
const reply = {
  requestId: "focused-test",
  text: "回复当前来信",
  replyTo: "42",
};
const resumeDraft = ({ draft, preparation }) => ({
  action: "continue",
  draftId: draft.draftId,
  expectedVersion: draft.version,
  inputReview: { token: preparation.token, decision: "continue" },
});

test("a quoted reply to the wake input sends despite old and newly arriving unrelated messages", async (t) => {
  let result, prompt;
  const f = await group(t, async (p) => {
    prompt = p.prompt;
    await f.ingest(43, "另一段群聊");
    result = await p.callTool("qq_send", reply);
  });
  await f.wake();
  assert.equal(result?.actionResult, "sent");
  assert(prompt.includes(f.source.id));
  assert.deepEqual(f.reviewed(), ["42"]);
  assert.equal(f.memory.state("group:20000").readThroughSeq || 0, 0);
  assert.deepEqual(f.sent()[0].segments[0], {
    type: "reply",
    data: { id: "42" },
  });
});

test("the current quote's follow-up invalidates its grant while unrelated messages stay queued", async (t) => {
  let first, challenged, result;
  const f = await group(t, async ({ callTool }) => {
    await f.ingest(43, quoted(42, "引用来信补充"));
    first = await callTool("qq_send", reply);
    await f.ingest(44, quoted(42, "再次补充"));
    challenged = await callTool("qq_draft", resumeDraft(first));
    await f.ingest(45, "不相关的新群聊");
    result = await callTool("qq_draft", resumeDraft(challenged));
  });
  await f.wake();
  assert.equal(first?.preparation?.state, "ready");
  assert.equal(challenged?.preparation?.reason, "NEW_INPUT");
  assert.equal(challenged?.attemptedThisCall, false);
  assert.equal(result?.actionResult, "sent");
  assert.equal(f.sent().length, 1);
  assert.deepEqual(f.reviewed(), ["42", "43", "44"]);
});

test("disabled focused replies still require review of the whole pending conversation", async (t) => {
  let result;
  const f = await group(
    t,
    async ({ callTool }) => {
      result = await callTool("qq_send", reply);
    },
    false,
  );
  await f.wake();
  assert.equal(result?.actionResult, "not_sent");
  assert(result.preparation.pendingDecision > 1);
  assert.equal(f.sent().length, 0);
});

test("quoting an old message uses the ordinary review scope", async (t) => {
  let result;
  const f = await group(t, async ({ callTool }) => {
    result = await callTool("qq_send", { ...reply, replyTo: "1" });
  });
  await f.wake();
  assert.equal(result?.actionResult, "not_sent");
  assert(result.preparation.pendingDecision > 1);
  assert.equal(f.sent().length, 0);
});

test("recalling the quoted wake input before confirmation blocks the focused draft", async (t) => {
  let first, after;
  const f = await group(t, async ({ callTool }) => {
    await f.ingest(43, quoted(42, "引用来信补充"));
    first = await callTool("qq_send", reply);
    await f.runtime.ingest(
      "qq-0",
      raw(42, {
        post_type: "notice",
        notice_type: "group_recall",
      }),
    );
    after = await callTool("qq_draft", resumeDraft(first));
  });
  await f.wake();
  assert.equal(first?.preparation?.state, "ready");
  assert.equal(after?.preparation?.reason, "SOURCE_CHANGED");
  assert.equal(f.sent().length, 0);
  assert.deepEqual(f.reviewed(), []);
});

test("a recalled follow-up must be shown before its draft can be confirmed again", async (t) => {
  let challenged, result;
  const f = await group(t, async ({ callTool }) => {
    await f.ingest(43, quoted(42, "合成补充原文"));
    const first = await callTool("qq_send", reply);
    await f.runtime.ingest(
      "qq-0",
      raw(43, {
        post_type: "notice",
        notice_type: "group_recall",
      }),
    );
    challenged = await callTool("qq_draft", resumeDraft(first));
    result = await callTool("qq_draft", resumeDraft(challenged));
  });
  await f.wake();
  assert.equal(challenged?.attemptedThisCall, false);
  assert.deepEqual(
    challenged.preparation.items.map((item) => [
      item.kind,
      item.messageId,
      item.body,
    ]),
    [["message.recalled", "43", "[消息已撤回]"]],
  );
  assert.equal(result?.actionResult, "sent");
  assert.equal(f.sent().length, 1);
});
