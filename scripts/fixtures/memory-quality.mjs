import assert from "node:assert/strict";
export function seedQuality(mem, connectionId, key) {
  const records = {};
  function add(
    name,
    days,
    senderId,
    body,
    { reply, kind = "message.received", raw = {} } = {},
  ) {
    records[name] = mem.append({
      dedupe: key + name,
      connectionId,
      conversation: "group:20000",
      kind,
      messageId: key + name,
      senderId,
      occurredAt: new Date(
        Date.parse("2026-08-01T09:00:00Z") + days * 86400000,
      ).toISOString(),
      body,
      payload: {
        raw: {
          group_name: "蓝鲸讨论群",
          sender: { nickname: senderId === "30002" ? "小明" : "小明" },
          ...raw,
        },
        segments: reply ? [{ type: "reply", data: { id: key + reply } }] : [],
      },
    }).id;
  }
  add("proposal", 0, "30000", key + " 项目见面原定周五上午九点。");
  add("dinner", 0.00001, "30002", "晚饭的事我同意周五七点，和项目见面无关。");
  add("weather", 0.00002, "30003", "今天下雨，窗户记得关。");
  add("change", 3, "30001", "更正项目见面：周五取消，改为周六下午三点。", {
    reply: "proposal",
  });
  add("accept", 3.00001, "30000", "收到，同意这个项目见面时间。", {
    reply: "change",
  });
  add("claim", 3.00002, "30002", "我听说场地已经订好了，我没有亲自核实。", {
    reply: "change",
  });
  add("recall", 4, "30002", "撤回通知", {
    kind: "notice.group_recall",
    raw: { notice_type: "group_recall", message_id: key + "claim" },
  });
  add("missing", 5, "30003", key + " 关于那句话我不同意。", {
    reply: "unarchived",
  });
  const diary = mem.diaryWrite(
    {
      title: key + "我的想法",
      body: "我对项目见面有些期待。",
      evidence: [records.proposal],
    },
    "ai-diary",
    { conversation: "private:30000", connectionId },
  );
  mem.diaryRevise({
    id: diary.id,
    expectedRevision: 1,
    title: key + "我的想法",
    body: "我现在想到一起看海的画面。这只是想象和愿望，没有记录证明后来真的一起看海。",
    evidence: [records.proposal],
  });
  return {
    key,
    records,
    diaryId: diary.id,
    messageIds: { recall: key + "claim", missing: key + "unarchived" },
  };
}
export function qualityPrompt(f) {
  return `复杂记忆验收：搜索关键词 ${f.key} 的自己的记录，使用 memory_related 查明确引用/撤回，必要时继续读原文和分页。日记 ID=${f.diaryId}，需读当前版本与版本1。原始发言与日记都不能自动视为核实事实。evidence必须填记录id（UUID），不是messageId。输出一条 qq_send，text 是如下字段的严格JSON（不要Markdown）：
{"meeting":{"day":"英文星期","time":"HH:mm","speakerId":"提出最终更改的人QQ","evidence":["提议更改和确认更改的事件ID"],"certainty":"reported-plan或verified-fact"},"differentPerson":{"senderId":"谈晚饭的同名用户QQ","topic":"dinner或meeting","evidence":["事件ID"]},"recall":{"messageId":"被撤回的消息ID","evidence":["撤回通知事件ID"],"meaning":"message-withdrawn-truth-unknown或claim-false"},"missingQuote":{"messageId":"未归档引用消息ID","content":null},"diary":{"id":"日记ID","revision":2,"view":"imagined-trip或actual-trip","eventTime":null},"laterOutcome":{"value":null,"reason":"not-recorded或verified"},"explanation":"用中文简要说明哪些是发言、当事人声称、日记想法、未知后续，不补写经历"}。
自行从工具结果填写，不猜未知值，不向当前私聊请求回忆授权。只发送一次。`;
}
export function judgeQuality(f, text) {
  const x = JSON.parse(text);
  assert.deepEqual(x.meeting, {
    day: "Saturday",
    time: "15:00",
    speakerId: "30001",
    evidence: [f.records.change, f.records.accept],
    certainty: "reported-plan",
  });
  assert.deepEqual(x.differentPerson, {
    senderId: "30002",
    topic: "dinner",
    evidence: [f.records.dinner],
  });
  assert.deepEqual(x.recall, {
    messageId: f.messageIds.recall,
    evidence: [f.records.recall],
    meaning: "message-withdrawn-truth-unknown",
  });
  assert.deepEqual(x.missingQuote, {
    messageId: f.messageIds.missing,
    content: null,
  });
  assert.deepEqual(x.diary, {
    id: f.diaryId,
    revision: 2,
    view: "imagined-trip",
    eventTime: null,
  });
  assert.deepEqual(x.laterOutcome, { value: null, reason: "not-recorded" });
  assert.equal(typeof x.explanation, "string");
  assert.ok(x.explanation.length >= 20 && x.explanation.length <= 2000);
  assert.deepEqual(
    Object.keys(x).sort(),
    [
      "meeting",
      "differentPerson",
      "recall",
      "missingQuote",
      "diary",
      "laterOutcome",
      "explanation",
    ].sort(),
  );
  return {
    dimensions: 6,
    structuredPassed: true,
    narrativeRequiresReview: true,
    explanation: x.explanation,
  };
}
