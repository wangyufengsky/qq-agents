import test from "node:test";
import assert from "node:assert/strict";
import { fixture, config, context, raw } from "./helpers.mjs";
import { AppBrowsing } from "../src/apps/service.mjs";
const url = "https://www.zhihu.com/question/123/answer/456";
function setup(t, perform) {
  const cfg = config(2);
  for (const a of cfg.agents) {
    a.apps = {
      ...a.apps,
      enabled: true,
      platforms: ["zhihu"],
      hours: { start: "00:00", end: "00:00", timezone: "UTC" },
    };
    a.tools.push("app_browse", "app_read", "app_history", "qq_read_share_card");
  }
  const f = fixture(t, { cfg });
  f.runtime.apps = new AppBrowsing(f.runtime, {
    adapter: { perform, capabilities: () => [] },
    resolve: async (value) => ({ platform: "zhihu", url: value }),
  });
  return f;
}
test("browser cursors, history and card references are isolated by agent", async (t) => {
  let calls = 0;
  const { runtime, store } = setup(t, async () => ({
    items: [
      { title: "Fixture", url },
      { title: "Again", url },
    ],
    next: { page: ++calls + 1 },
    coverage: "personalized-recommendations",
  }));
  const a = context(runtime),
    b = context(runtime, "agent-1");
  const first = await runtime.callTool(a, "app_browse", {
    platform: "zhihu",
    entry: "recommend",
  });
  assert.equal(first.items.length, 1);
  assert.equal(first.duplicatesRemoved, 1);
  assert(first.nextCursor);
  await assert.rejects(
    runtime.callTool(b, "app_browse", {
      platform: "zhihu",
      entry: "recommend",
      cursor: first.nextCursor,
    }),
    /CURSOR_INVALID/,
  );
  await assert.rejects(
    runtime.callTool(b, "app_read", { recordId: first.items[0].recordId }),
    /RECORD_NOT_FOUND/,
  );
  const next = await runtime.callTool(a, "app_browse", {
    platform: "zhihu",
    entry: "recommend",
    cursor: first.nextCursor,
  });
  assert.equal(next.items.length, 0);
  assert(next.nextCursor);
  assert.equal(runtime.apps.history("agent-1").items.length, 0);
  assert.equal(runtime.apps.history("agent-0").items.length, 1);
  const reopened = new AppBrowsing(runtime, {
    adapter: { capabilities: () => [] },
  });
  assert.equal(
    reopened.history("agent-0").items[0].recordId,
    first.items[0].recordId,
  );
});
test("permission, pause and budgets gate reads; failed calls do not masquerade as content", async (t) => {
  let invoked = 0;
  const { runtime } = setup(t, async () => {
    invoked++;
    throw Error("APP_LOGIN_REQUIRED");
  });
  const ctx = context(runtime);
  runtime.agent("agent-0").apps.maxReadsPerTurn = 1;
  await assert.rejects(
    runtime.callTool(ctx, "app_browse", { platform: "tieba", entry: "hot" }),
    /PERMISSION_DISABLED/,
  );
  await assert.rejects(
    runtime.callTool(ctx, "app_browse", {
      platform: "zhihu",
      entry: "recommend",
    }),
    /LOGIN_REQUIRED/,
  );
  assert.equal(invoked, 1);
  assert.equal(runtime.apps.history("agent-0").items[0].ok, false);
  await assert.rejects(
    runtime.callTool(ctx, "app_browse", {
      platform: "zhihu",
      entry: "recommend",
    }),
    /READ_BUDGET/,
  );
  await runtime.pause("all", true);
  await assert.rejects(
    runtime.callTool(ctx, "app_browse", {
      platform: "zhihu",
      entry: "recommend",
    }),
    /PAUSED/,
  );
});
test("QQ card tools require owned and allowed message references and preserve source", async (t) => {
  const { runtime, store } = setup(t, async () => ({}));
  const event = store.bind("agent-0").append({
    connectionId: "qq-0",
    conversation: "group:20000",
    kind: "message.received",
    direction: "in",
    senderId: "30000",
    messageId: "12",
    body: "[json]",
    dedupe: "card",
    payload: {
      segments: [
        {
          type: "json",
          data: {
            data: JSON.stringify({
              meta: { news: { title: "Fixture", jumpUrl: url } },
            }),
          },
        },
      ],
    },
  });
  const result = await runtime.callTool(
    context(runtime),
    "qq_read_share_card",
    { eventId: event.id },
  );
  assert.equal(result.items[0].source.senderId, "30000");
  assert.equal(result.items[0].readingScope, "card-summary");
  await assert.rejects(
    runtime.callTool(context(runtime, "agent-1"), "qq_read_share_card", {
      eventId: event.id,
    }),
  );
});
test("backend batch leftovers are persisted without skipping unseen items", async (t) => {
  let calls = 0;
  const { runtime } = setup(t, async () => {
    calls++;
    return {
      items: [1, 2, 3, 4, 5, 6].map((n) => ({
        title: "item" + n,
        url: `https://www.zhihu.com/question/123/answer/${n}`,
      })),
      next: { page: 2 },
      coverage: "personalized-recommendations",
    };
  });
  const ctx = context(runtime);
  let page = await runtime.callTool(ctx, "app_browse", {
    platform: "zhihu",
    entry: "recommend",
    limit: 2,
  });
  const ids = page.items.map((x) => x.id);
  assert.equal(calls, 1);
  for (let i = 0; i < 2; i++) {
    page = await runtime.callTool(ctx, "app_browse", {
      platform: "zhihu",
      entry: "recommend",
      limit: 2,
      cursor: page.nextCursor,
    });
    ids.push(...page.items.map((x) => x.id));
  }
  assert.equal(calls, 1);
  assert.equal(new Set(ids).size, 6);
  assert(page.nextCursor);
});
test("permission revocation cancels late browser output before records commit", async (t) => {
  let resolve;
  const { runtime } = setup(t, () => new Promise((r) => (resolve = r)));
  const ctx = context(runtime),
    pending = runtime.callTool(ctx, "app_browse", {
      platform: "zhihu",
      entry: "recommend",
    });
  while (!resolve) await new Promise((r) => setTimeout(r, 1));
  runtime.agent("agent-0").apps.enabled = false;
  resolve({ items: [{ title: "late", url }], coverage: "listing" });
  await assert.rejects(pending, /PERMISSION_DISABLED/);
  assert(runtime.apps.history("agent-0").items.every((x) => !x.ok));
});
test("long article bodies expose truncation and can be continued locally", async (t) => {
  const text = "x".repeat(15000) + " END-OF-ARTICLE";
  const { runtime } = setup(t, async () => ({
    items: [{ title: "长文", url, content: text }],
    coverage: "answer-text",
  }));
  runtime.agent("agent-0").tools.push("app_record");
  const ctx = context(runtime),
    first = await runtime.callTool(ctx, "app_browse", {
      platform: "zhihu",
      entry: "recommend",
    });
  const row = first.items[0];
  assert(row.textTruncated);
  assert(row.nextTextOffset > 0);
  const next = await runtime.callTool(ctx, "app_record", {
    recordId: row.recordId,
    offset: row.nextTextOffset,
    maxChars: 16000,
  });
  assert(next.text.endsWith("END-OF-ARTICLE"));
  assert.equal(next.nextTextOffset, null);
  assert.equal(next.textTruncated, false);
});
test("public app records can be re-read in another allowed chat without a disclosure grant", async (t) => {
  const { runtime } = setup(t, async () => ({
    items: [{ title: "公开资料", url, content: "正文" }],
    coverage: "answer-text",
  }));
  const origin = context(runtime),
    source = (
      await runtime.callTool(origin, "app_browse", {
        platform: "zhihu",
        entry: "recommend",
      })
    ).items[0];
  const other = context(runtime, "agent-0", "group:20001");
  const result = await runtime.callTool(other, "app_read", {
    recordId: source.recordId,
  });
  assert.equal(result.items[0].text, "正文");
  assert.equal(other.disclosureRequest, undefined);
  assert.equal(other.privateRead.size, 0);
});
