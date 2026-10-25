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
    /PERMISSION_DISABLED/,
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
    /RESTRICTED_CONTEXT/,
  );
  assert.equal(runtime.transports.get("qq-0").sent.length, 0);
});
