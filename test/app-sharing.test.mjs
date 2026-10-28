import { MediaStore } from "../src/tools/media.mjs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fixture, config, context } from "./helpers.mjs";
import { AppBrowsing } from "../src/apps/service.mjs";
const url = "https://www.zhihu.com/question/123/answer/456";
function setup(t) {
  const cfg = config(2);
  for (const a of cfg.agents) {
    a.apps = {
      ...a.apps,
      enabled: true,
      sharing: true,
      platforms: ["zhihu"],
      hours: { start: "00:00", end: "00:00", timezone: "UTC" },
    };
    a.tools.push("app_browse", "app_share_send", "app_read");
  }
  const f = fixture(t, { cfg });
  f.runtime.media = new MediaStore(path.join(f.root, "media"));
  f.runtime.apps = new AppBrowsing(f.runtime, {
    adapter: {
      perform: async () => ({
        items: [{ title: "测试", url, text: "资料" }],
        coverage: "answer-text",
      }),
      capabilities: () => [],
    },
    resolve: async (url) => ({ platform: "zhihu", url }),
  });
  return f;
}
async function read(runtime, ctx) {
  return (
    await runtime.callTool(ctx, "app_browse", {
      platform: "zhihu",
      entry: "recommend",
    })
  ).items[0];
}
test("current chat share uses owned observed source and existing outbox", async (t) => {
  const { runtime } = setup(t),
    ctx = context(runtime),
    source = await read(runtime, ctx);
  const result = await runtime.callTool(ctx, "app_share_send", {
    recordId: source.recordId,
    comment: "这里的观察和我们的话题有关",
  });
  assert.equal(result.status, "sent");
  const sent = runtime.transports.get("qq-0").sent;
  assert.equal(sent.length, 1);
  assert(sent[0].segments[0].data.text.endsWith(url));
  await assert.rejects(
    runtime.callTool(context(runtime, "agent-1"), "app_share_send", {
      recordId: source.recordId,
      comment: "测试",
    }),
    /RECORD_NOT_FOUND/,
  );
});
test("new request cannot replay unknown delivery or bypass duplicate budget", async (t) => {
  const { runtime } = setup(t),
    ctx = context(runtime),
    source = await read(runtime, ctx);
  runtime.transports.get("qq-0").failure = "TIMEOUT";
  await assert.rejects(
    runtime.callTool(ctx, "app_share_send", {
      recordId: source.recordId,
      comment: "测试",
    }),
    /DELIVERY_UNKNOWN/,
  );
  const next = await read(runtime, ctx);
  await assert.rejects(
    runtime.callTool(ctx, "app_share_send", {
      recordId: next.recordId,
      comment: "重试",
    }),
    /DUPLICATE/,
  );
  assert.equal(runtime.transports.get("qq-0").sent.length, 1);
});
test("share gates expiry, permission and image lineage before delivery", async (t) => {
  const { runtime } = setup(t),
    ctx = context(runtime),
    source = await read(runtime, ctx);
  await assert.rejects(
    runtime.callTool(ctx, "app_share_send", {
      recordId: source.recordId,
      comment: "测试",
      mediaId: "a".repeat(64),
    }),
    /IMAGE_SOURCE_MISMATCH/,
  );
  runtime.agent("agent-0").apps.sharing = false;
  await assert.rejects(
    runtime.callTool(ctx, "app_share_send", {
      recordId: source.recordId,
      comment: "测试",
    }),
    /TOOL_DISABLED/,
  );
  runtime.agent("agent-0").apps.sharing = true;
  const old = runtime.now.bind(runtime);
  runtime.now = () => old() + 86400000;
  await assert.rejects(
    runtime.callTool(ctx, "app_share_send", {
      recordId: source.recordId,
      comment: "测试",
    }),
    /SOURCE_EXPIRED/,
  );
  assert.equal(runtime.transports.get("qq-0").sent.length, 0);
});
test("registered app images retain protected Operations provenance after deduplication", async (t) => {
  const { runtime } = setup(t),
    ctx = context(runtime),
    source = await read(runtime, ctx),
    mediaId = "b".repeat(64);
  runtime.media.metadata = () => ({
    id: mediaId,
    appRecordId: source.recordId,
    protectedOperations: true,
  });
  runtime.media.segment = () => ({
    type: "image",
    data: { file: "base64://fixture" },
  });
  await assert.rejects(
    runtime.callTool(ctx, "app_share_send", {
      recordId: source.recordId,
      comment: "测试",
      mediaId,
    }),
    /RECALL_SOURCE_NOT_ALLOWED|RESTRICTED_CONTEXT/,
  );
  assert.equal(runtime.transports.get("qq-0").sent.length, 0);
});
test("subject exploration hands one intent to the target chat and cannot send directly", async (t) => {
  const { runtime, store } = setup(t),
    a = runtime.agent("agent-0");
  a.subject.enabled = true;
  a.subject.groups = ["20000"];
  a.tools.push("app_share_propose", "intent_decide");
  const subject = runtime.makeContext(a.id, "@subject");
  subject.allowedTools = runtime.toolsFor(a, "@subject");
  assert(subject.allowedTools.includes("app_browse"));
  assert(subject.allowedTools.includes("app_share_propose"));
  assert(!subject.allowedTools.includes("app_share_send"));
  const source = await read(runtime, subject);
  await assert.rejects(
    runtime.callTool(subject, "app_share_send", {
      recordId: source.recordId,
      comment: "不应发送",
    }),
    /TOOL_DISABLED/,
  );
  const i = await runtime.callTool(subject, "app_share_propose", {
    recordId: source.recordId,
    target: "group:20000",
    reason: "与目标当前讨论的资料相关",
  });
  assert.equal(i.status, "waiting");
  const handed = [];
  runtime.conversations.request = (...args) => handed.push(args);
  runtime.subject.tick();
  assert.equal(handed.length, 1);
  const target = runtime.makeContext(a.id, "group:20000");
  runtime.subject.begin(target, [{ intentId: i.id }]);
  const current = store.bind(a.id).identity.get("intentions", i.id);
  await runtime.callTool(target, "intent_decide", {
    id: i.id,
    expectedRevision: current.revision,
    action: "send",
    reason: "当前话题合适",
  });
  await assert.rejects(
    runtime.callTool(target, "qq_send", {
      requestId: "wrong-tool",
      text: "绕开来源",
    }),
    /APP_SHARE_TOOL_REQUIRED/,
  );
  await runtime.callTool(target, "app_share_send", {
    recordId: source.recordId,
    comment: "这条观察值得对照一下",
  });
  assert.equal(
    store.bind(a.id).identity.get("intentions", i.id).status,
    "completed",
  );
  assert.equal(store.bind(a.id).delivery("intent:" + i.id).status, "sent");
  assert.equal(runtime.transports.get("qq-0").sent.length, 1);
});
test("administrator cancellation and permission changes invalidate selected share before outbox", async (t) => {
  const { runtime, store } = setup(t),
    a = runtime.agent("agent-0");
  a.subject.enabled = true;
  a.subject.groups = ["20000"];
  a.tools.push("app_share_propose", "intent_decide");
  const ctx = runtime.makeContext(a.id, "group:20000"),
    source = await read(runtime, ctx);
  const i = await runtime.callTool(ctx, "app_share_propose", {
    recordId: source.recordId,
    target: ctx.conversation,
    reason: "测试",
  });
  runtime.subject.transition(a.id, i, "handedoff", "fixture");
  runtime.subject.begin(ctx, [{ intentId: i.id }]);
  await runtime.callTool(ctx, "intent_decide", {
    id: i.id,
    expectedRevision: 2,
    action: "send",
    reason: "测试",
  });
  const { cancelShare } = await import("../src/apps/sharing.mjs");
  await cancelShare(runtime.apps, a.id, i.id, 3);
  assert.equal(
    store.bind(a.id).identity.get("intentions", i.id).status,
    "cancelled",
  );
  await assert.rejects(
    runtime.callTool(ctx, "app_share_send", {
      recordId: source.recordId,
      comment: "晚到",
    }),
  );
  assert.equal(runtime.transports.get("qq-0").sent.length, 0);
});
test("peer reflections and same-target duplicate shares are blocked across agents", async (t) => {
  const { runtime } = setup(t),
    first = context(runtime),
    one = await read(runtime, first);
  await runtime.callTool(first, "app_share_send", {
    recordId: one.recordId,
    comment: "一次分享",
  });
  const second = context(runtime, "agent-1"),
    two = await read(runtime, second);
  await assert.rejects(
    runtime.callTool(second, "app_share_send", {
      recordId: two.recordId,
      comment: "同伴重复",
    }),
    /PEER_ALREADY_SHARED/,
  );
  assert.equal(runtime.transports.get("qq-1").sent.length, 0);
});
test("outbox and app attempt index roll back together when append fails", async (t) => {
  const { runtime, store } = setup(t),
    ctx = context(runtime),
    source = await read(runtime, ctx),
    mem = store.bind(ctx.agentId);
  mem.db.exec(
    "CREATE TEMP TRIGGER app_fail BEFORE INSERT ON events WHEN NEW.kind='message.send-attempt' BEGIN SELECT RAISE(ABORT,'FIXTURE_APPEND_FAILED'); END;",
  );
  await assert.rejects(
    runtime.callTool(ctx, "app_share_send", {
      recordId: source.recordId,
      comment: "事务失败",
    }),
    /FIXTURE_APPEND_FAILED/,
  );
  assert.equal(
    mem.db
      .prepare("SELECT COUNT(*) AS n FROM deliveries WHERE agent_id=?")
      .get(ctx.agentId).n,
    0,
  );
  assert.equal(runtime.transports.get("qq-0").sent.length, 0);
});
