import test from "node:test";
import assert from "node:assert/strict";
import { draftScope } from "../src/core/draft-delivery.mjs";
import { config, context, fixture, raw } from "./helpers.mjs";

function setup(t) {
  const cfg = config(1);
  Object.assign(cfg.agents[0].wake, {
    names: false,
    mentions: false,
    private: false,
    participation: 0,
  });
  const f = fixture(t, { cfg });
  return {
    ...f,
    ctx: context(f.runtime),
    mem: f.store.bind("agent-0"),
    gateway: f.runtime.transports.get("qq-0"),
  };
}

const call = (f, name, args) => f.runtime.callTool(f.ctx, name, args);

async function incoming(f, id, text) {
  await f.runtime.ingest(
    "qq-0",
    raw(id, { message: [{ type: "text", data: { text } }] }),
  );
  return f.store.db
    .prepare("SELECT id,seq FROM events WHERE agent_id=? AND message_id=?")
    .get(f.ctx.agentId, String(id));
}

function draftOf(result) {
  const draft = result.draft ?? result;
  assert.equal(typeof draft.draftId, "string");
  assert(Number.isInteger(draft.version));
  return draft;
}

function action(f, name, draft, args = {}) {
  return call(f, "qq_draft", {
    action: name,
    draftId: draft.draftId,
    expectedVersion: draft.version,
    ...args,
  });
}

function continueWith(f, draft, token) {
  return action(f, "continue", draft, {
    inputReview: { token, decision: "continue" },
  });
}

function preparation(result, expectedState) {
  assert.equal(result.actionResult, "not_sent");
  assert.equal(result.attemptedThisCall, false);
  const value = result.preparation;
  assert.equal(value?.state, expectedState);
  if (expectedState === "ready") assert.equal(typeof value.token, "string");
  else assert(!value.token);
  return value;
}

function accounting(f) {
  const state = f.mem.state(f.ctx.conversation);
  return {
    sent: f.gateway.sent.length,
    attempts: f.store.db
      .prepare(
        "SELECT count(*) AS n FROM events WHERE kind='message.send-attempt'",
      )
      .get().n,
    ledger: f.store.db.prepare("SELECT count(*) AS n FROM deliveries").get().n,
    sendCount: f.ctx.sendCount,
    replyBatchSends: state.replyBatchSends ?? 0,
    sendTimes: state.sendTimes ?? [],
    readThroughSeq: state.readThroughSeq ?? 0,
  };
}

function reasonIncludes(value, code) {
  return [value.reason, ...(value.reasons ?? [])].some(
    (entry) => (entry?.code ?? entry) === code,
  );
}

function material(result) {
  return (result.preparation ?? result.inputReview)?.items ?? [];
}

function assertVisibleMaterial(result, id, body) {
  const item = material(result).find(
    (item) => (item.inputRef?.id ?? item.id) === id,
  );
  assert.equal(item?.body, body);
  return item;
}

test(
  "legacy no-token continue cannot send even when the input set is empty",
  { timeout: 10000 },
  async (t) => {
    const f = setup(t);
    const requestId = "legacy-empty-preparation";
    const { draft } = f.runtime.drafts.stage(draftScope(f.runtime, f.ctx), {
      toolName: "qq_send",
      requestId,
      items: [{ requestId, input: { text: "合成无新增草稿" } }],
      value: { baseline: { revision: 0, ids: [] } },
    });
    const before = accounting(f);
    const current = { draftId: draft.id, version: draft.revision };
    const output = await action(f, "continue", current);
    assert.deepEqual(
      accounting(f),
      before,
      "no-token continue made a delivery attempt",
    );
    const ready = preparation(output, "ready");
    const sent = await continueWith(f, current, ready.token);
    assert.equal(sent.actionResult, "sent");
    assert.equal(f.gateway.sent.length, 1);
  },
);

test(
  "a blocked preparation still returns the already saved revision",
  { timeout: 10000 },
  async (t) => {
    const f = setup(t);
    await incoming(f, 2, "合成初稿输入");
    const opening = await call(f, "qq_send", {
      requestId: "revise-then-blocked",
      text: "合成初稿",
    });
    const draft = draftOf(opening);
    const hidden = await incoming(f, 3, "SYNTHETIC_RESTRICTED_PREPARATION");
    f.mem.db
      .prepare(
        "UPDATE events SET payload=json_set(payload,'$.protectedRepositories',json(?)) WHERE id=?",
      )
      .run(JSON.stringify(["synthetic/private-repo"]), hidden.id);
    const before = accounting(f);
    const revised = await action(f, "revise", draft, {
      position: 0,
      input: { text: "合成已保存修订" },
    });
    assert.equal(revised.revisionApplied, true);
    const saved = draftOf(revised);
    assert.equal(saved.version, draft.version + 1);
    preparation(revised, "blocked");
    assert(!JSON.stringify(revised).includes(hidden.id));
    assert(
      !JSON.stringify(revised).includes("SYNTHETIC_RESTRICTED_PREPARATION"),
    );
    const read = await call(f, "qq_draft", {
      action: "read",
      draftId: saved.draftId,
    });
    assert.equal(read.input.text, "合成已保存修订");
    assert.deepEqual(accounting(f), before);
  },
);

test(
  "one revise returns the new token and one continue sends that version",
  { timeout: 10000 },
  async (t) => {
    const f = setup(t);
    await incoming(f, 4, "合成初稿输入");
    const opening = await call(f, "qq_send", {
      requestId: "ready-in-revise",
      text: "合成初稿",
    });
    const draft = draftOf(opening);
    const before = accounting(f);
    const revised = await action(f, "revise", draft, {
      position: 0,
      input: { text: "合成实际发送新版" },
    });
    assert.equal(revised.revisionApplied, true);
    const saved = draftOf(revised);
    const next = preparation(revised, "ready");
    assert.equal(saved.version, draft.version + 1);
    assert.deepEqual(accounting(f), before);
    const sent = await continueWith(f, saved, next.token);
    assert.equal(sent.actionResult, "sent");
    assert.equal(accounting(f).attempts, 1);
    assert.equal(f.gateway.sent[0].segments[0].data.text, "合成实际发送新版");
  },
);

test("three archived updates each require a new decision without an empty token round trip", async (t) => {
  const f = setup(t);
  await incoming(f, 10, "合成最初输入");
  const started = await call(f, "qq_send", {
    requestId: "three-input-waves",
    text: "合成初稿",
  });
  let draft = draftOf(started);
  let token = preparation(started, "ready").token;
  for (let wave = 1; wave <= 3; wave++) {
    const body = "合成新增输入 " + wave;
    const row = await incoming(f, 10 + wave, body);
    const changed = await continueWith(f, draft, token);
    const ready = preparation(changed, "ready");
    assert(reasonIncludes(ready, "NEW_INPUT"));
    const shown = material(changed).filter(({ body }) => body);
    assert.equal(shown.length, 1);
    assertVisibleMaterial(changed, row.id, body);
    assert.notEqual(ready.token, token);
    assert.equal(accounting(f).attempts, 0);
    token = ready.token;
    if (wave === 1) {
      const revised = await action(f, "revise", draft, {
        position: 0,
        input: { text: "合成纳入补充后的回复" },
      });
      assert.equal(revised.revisionApplied, true);
      draft = draftOf(revised);
      token = preparation(revised, "ready").token;
      assert.equal(material(revised).filter(({ body }) => body).length, 0);
    }
  }
  assert.equal((await continueWith(f, draft, token)).actionResult, "sent");
  assert.equal(accounting(f).attempts, 1);
  assert.equal(f.gateway.sent.length, 1);
});
