import test from "node:test";
import assert from "node:assert/strict";
import { config, fixture } from "./helpers.mjs";
const role = "agent-0";
const group = "group:20000";
const cfg = () => {
  const result = config();
  result.agents[0].dream.enabled = true;
  return result;
};
const add = (evidenceIds, other = {}) => ({
  schemaVersion: 1,
  awakeningSummary: "",
  noChangesReason: null,
  operations: [
    {
      op: "ADD",
      category: "fact",
      scopeId: group,
      subjectKey: "user:30000:cake",
      content: "有用户谈到蛋糕。",
      epistemicStatus: "reported",
      evidenceIds,
      importance: 0.4,
      confidence: 0.7,
      reason: "讨论中提及。",
      ...other,
    },
  ],
});

test("protected sources never enter prompts or tool results, while private provenance remains transitive", async (t) => {
  const restricted = [];
  let groupSource, derived;
  const f = fixture(t, {
    cfg: cfg(),
    run: async (p) => {
      for (const id of restricted) {
        assert.doesNotMatch(p.prompt, new RegExp(id));
        await assert.rejects(
          p.callTool("memory_read", { id }),
          /RECALL_SOURCE_NOT_ALLOWED/,
        );
      }
      const response = await p.callTool("memory_search", {
        query: "隐藏的材料",
      });
      assert.deepEqual(response.items, []);
      assert.match(p.prompt, /JSON/);
      assert.ok(
        JSON.parse(p.prompt.split("任务资料（JSON）：\n")[1]).some(
          ({ id }) => id === derived.id,
        ),
      );
      await assert.rejects(
        p.callTool(
          "dream_cognition_submit",
          add([derived.id], { scopeId: "group:20001" }),
        ),
        /DREAM_SCOPE_VIOLATION/,
      );
      const result = await p.callTool(
        "dream_cognition_submit",
        add([groupSource.id, derived.id]),
      );
      assert.equal(result.status, "accepted");
    },
  });
  const m = f.store.bind(role);
  const append = (dedupe, conversation, payload = {}) =>
    m.append({
      dedupe,
      conversation,
      body: "隐藏的材料",
      kind: "message.received",
      payload: { trustedInput: true, ...payload },
    });
  groupSource = m.append({
    dedupe: "group-source",
    conversation: group,
    body: "关于蛋糕",
    kind: "message.received",
    payload: { trustedInput: true },
  });
  const privateSource = m.append({
    dedupe: "private-source",
    conversation: "private:30000",
    body: "私聊提起蛋糕",
    kind: "message.received",
    payload: { trustedInput: true },
  });
  const diary = m.diaryWrite({
    title: "安全日记",
    body: "私聊谈话",
    evidence: [privateSource.id],
  });
  derived = m.diaryWrite({
    title: "附有所见的日记",
    body: "沿用上篇",
    evidence: [diary.id],
  });
  for (const [scope, payload] of [
    [group, { protectedOperations: true }],
    [group, { protectedRepositories: ["fixture/repository"] }],
    [group, { protectedPeerQzoneTargets: ["30000"] }],
    ["@work:fixture", {}],
  ])
    restricted.push(
      append("restricted-" + restricted.length, scope, payload).id,
    );
  const restrictedDiary = m.diaryWrite({
    title: "隐藏的材料",
    body: "受保护日记",
    evidence: [restricted[0]],
  });
  restricted.push(restrictedDiary.id);
  m.corrections.put({
    id: "restricted-correction",
    sourceId: restricted[1],
    oldBelief: "隐藏的材料",
    current: "保护数据",
  });
  restricted.push("restricted-correction");
  const result = await f.runtime.dreams.run(role);
  assert.equal(result.status, "COMMITTED");
  const row = f.store.db
    .prepare("SELECT from_private,source_scopes_json FROM cognitions")
    .get();
  assert.equal(row.from_private, 1);
  assert.deepEqual(JSON.parse(row.source_scopes_json), [
    group,
    "private:30000",
  ]);
});

test("a robot's narrative and a role's diary cannot by themselves become observed facts", async (t) => {
  let out, diary;
  const f = fixture(t, {
    cfg: cfg(),
    run: async (p) => {
      await assert.rejects(
        p.callTool(
          "dream_cognition_submit",
          add([out.id, diary.id], { epistemicStatus: "observed" }),
        ),
        /DREAM_SELF_EVIDENCE_ONLY/,
      );
      await assert.rejects(
        p.callTool(
          "dream_cognition_submit",
          add([out.id], { epistemicStatus: "fictional" }),
        ),
        /DREAM_FICTIONAL_IN_COGNITION/,
      );
      await p.callTool(
        "dream_cognition_submit",
        add([out.id], { content: "角色说自己梦见了蛋糕。" }),
      );
    },
  });
  const m = f.store.bind(role);
  out = m.append({
    dedupe: "out",
    conversation: group,
    body: "我梦见吃了蛋糕。",
    kind: "message.sent",
    status: "confirmed",
    direction: "out",
  });
  diary = m.diaryWrite({ title: "梦的反思", body: "醒来后觉得很有趣。" });
  assert.equal((await f.runtime.dreams.run(role)).status, "COMMITTED");
  assert.equal(
    f.store.db.prepare("SELECT epistemic_status FROM cognitions").get()
      .epistemic_status,
    "reported",
  );
});
