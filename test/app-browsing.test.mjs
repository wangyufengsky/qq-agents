import test from "node:test";
import assert from "node:assert/strict";
import { fixture, config, context } from "./helpers.mjs";
import { AppBrowsing } from "../src/apps/service.mjs";
import { restoreExport } from "../src/memory/migrate.mjs";
import { MemoryStore } from "../src/memory/store.mjs";
const url = "https://www.zhihu.com/question/123/answer/456";
function setup(t, perform, cursorLimits) {
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
    cursorLimits,
  });
  return f;
}
test("a cursor budget failure preserves the old continuation and records no partial success", async (t) => {
  let oversized = false;
  const { runtime } = setup(
    t,
    async (job) => ({
      items: job.cursor
        ? [
            {
              url: "https://www.zhihu.com/question/123/answer/457",
              title: "second",
            },
            {
              url: "https://www.zhihu.com/question/123/answer/458",
              text: oversized ? "大".repeat(2000) : "third",
            },
          ]
        : [{ url, title: "first" }],
      next: job.cursor ? null : { page: 2 },
    }),
    { cursorBytes: 2000 },
  );
  const ctx = context(runtime);
  const args = { platform: "zhihu", entry: "recommend", limit: 1 };
  const first = await runtime.apps.perform(ctx, "browse", args);
  oversized = true;
  await assert.rejects(
    runtime.apps.perform(ctx, "browse", { ...args, cursor: first.nextCursor }),
    /APP_CURSOR_BUDGET/,
  );
  assert.equal(runtime.apps.progress(ctx.agentId)[0].cursor, first.nextCursor);
  assert.equal(
    runtime.apps.history(ctx.agentId).items.filter((x) => x.ok).length,
    1,
  );
  oversized = false;
  const second = await runtime.apps.perform(ctx, "browse", {
    ...args,
    cursor: first.nextCursor,
  });
  assert.equal(second.items[0].title, "second");
  const third = await runtime.apps.perform(ctx, "browse", {
    ...args,
    cursor: second.nextCursor,
  });
  assert.equal(third.items[0].text, "third");
  assert.equal(third.nextCursor, null);
});
test("cursor count and page limits fail explicitly, while buffered pages remain consumable once", async (t) => {
  const { runtime } = setup(
    t,
    async () => ({
      items: [
        { url, title: "one" },
        { url: "https://www.zhihu.com/question/123/answer/457", title: "two" },
      ],
      next: { page: 2 },
    }),
    { count: 1, pages: 1 },
  );
  const ctx = context(runtime),
    args = { platform: "zhihu", entry: "recommend", limit: 1 };
  const first = await runtime.apps.perform(ctx, "browse", args);
  await assert.rejects(
    runtime.apps.perform(ctx, "browse", args),
    /APP_CURSOR_BUDGET/,
  );
  const concurrent = await Promise.allSettled(
    [1, 2].map(() =>
      runtime.apps.perform(ctx, "browse", {
        ...args,
        cursor: first.nextCursor,
      }),
    ),
  );
  assert.equal(concurrent.filter((x) => x.status === "fulfilled").length, 1);
  assert.match(
    concurrent.find((x) => x.status === "rejected").reason.message,
    /APP_CURSOR_INVALID/,
  );
  const second = concurrent.find((x) => x.status === "fulfilled").value;
  assert.equal(second.items[0].title, "two");
  await assert.rejects(
    runtime.apps.perform(ctx, "browse", { ...args, cursor: second.nextCursor }),
    /APP_CURSOR_BUDGET/,
  );
  assert.equal(runtime.apps.progress(ctx.agentId)[0].cursor, second.nextCursor);
});
test("legacy cursor bodies migrate without losing budget calls, survive restore, and expire on runtime ticks", async (t) => {
  const { runtime, store } = setup(t, async () => {
    throw Error("unexpected network");
  });
  const ctx = context(runtime),
    id = "12345678-1234-1234-1234-123456789abc",
    now = runtime.now();
  store.bind(ctx.agentId).setState("internal:app-browsing", {
    calls: [now],
    cursors: {
      [id]: {
        job: { platform: "zhihu", entry: "recommend", limit: 1, streamId: id },
        platform: "zhihu",
        operation: "browse",
        pending: [
          {
            url,
            key: "zhihu:456",
            commentId: null,
            title: "legacy body",
            text: "stored text",
          },
        ],
        seen: [],
        backendCursor: null,
        pages: 1,
        expiresAt: now + 1000,
        epoch: "old-process",
      },
    },
  });
  assert.equal(runtime.apps.progress(ctx.agentId)[0].buffered, 1);
  const snapshot = store.bind(ctx.agentId).export();
  assert.equal(
    store.bind(ctx.agentId).state("internal:app-browsing").cursors,
    undefined,
  );
  assert.deepEqual(
    store.bind(ctx.agentId).state("internal:app-browsing").calls,
    [now],
  );
  const restored = new MemoryStore(":memory:");
  try {
    restoreExport(restored.bind(ctx.agentId), snapshot);
    // Restore through the public browsing interface against a separate real store.
    const saved = runtime.memory;
    runtime.memory = restored;
    try {
      const reopened = new AppBrowsing(runtime, {
        adapter: {
          perform: async () => {
            throw Error("unexpected network");
          },
        },
      });
      const page = await reopened.perform(ctx, "browse", {
        platform: "zhihu",
        entry: "recommend",
        cursor: id,
      });
      assert.equal(page.items[0].text, "stored text");
      assert.equal(page.nextCursor, null);
    } finally {
      runtime.memory = saved;
    }
  } finally {
    restored.close();
  }
  runtime.now = () => now + 2000;
  runtime.tick();
  assert.equal(
    store
      .bind(ctx.agentId)
      .export()
      .tables.runtime.filter((row) =>
        row.conversation.startsWith("internal:app-cursor"),
      ).length,
    0,
  );
  await assert.rejects(
    runtime.apps.perform(ctx, "browse", {
      platform: "zhihu",
      entry: "recommend",
      cursor: id,
    }),
    /APP_CURSOR_INVALID/,
  );
});
test("periodic cleanup removes expired legacy buffers even before browsing is reopened", (t) => {
  const { runtime, store } = setup(t, async () => ({ items: [] }));
  store.bind("agent-0").setState("internal:app-browsing", {
    calls: [runtime.now()],
    cursors: {
      old: {
        expiresAt: runtime.now() - 1,
        pending: [{ text: "expired legacy body" }],
      },
    },
  });
  delete runtime.apps;
  runtime.tick();
  assert.equal(
    store.bind("agent-0").state("internal:app-browsing").cursors,
    undefined,
  );
  assert.equal(
    store.bind("agent-0").state("internal:app-browsing").calls.length,
    1,
  );
});
test("oversized platform batches fail explicitly instead of silently discarding rows after 100", async (t) => {
  const { runtime } = setup(t, async () => ({
    items: Array.from({ length: 101 }, (_, i) => ({
      url: `https://www.zhihu.com/question/123/answer/${1000 + i}`,
    })),
  }));
  const ctx = context(runtime);
  await assert.rejects(
    runtime.apps.perform(ctx, "browse", {
      platform: "zhihu",
      entry: "recommend",
    }),
    /APP_RESULT_BUDGET/,
  );
  assert.equal(
    runtime.apps.history(ctx.agentId).items.filter((x) => x.ok).length,
    0,
  );
});
test("cursor bytes are shared within one role and isolated across roles", async (t) => {
  const { runtime } = setup(
    t,
    async () => ({
      items: [
        { url, title: "one" },
        {
          url: "https://www.zhihu.com/question/123/answer/457",
          text: "x".repeat(1500),
        },
      ],
    }),
    { cursorBytes: 3000, agentBytes: 3500 },
  );
  const a = context(runtime),
    b = context(runtime, "agent-1"),
    args = { platform: "zhihu", entry: "recommend", limit: 1 };
  const first = await runtime.apps.perform(a, "browse", args);
  await assert.rejects(
    runtime.apps.perform(a, "browse", args),
    /APP_CURSOR_BUDGET/,
  );
  assert.ok((await runtime.apps.perform(b, "browse", args)).nextCursor);
  const drained = await runtime.apps.perform(a, "browse", {
    ...args,
    cursor: first.nextCursor,
  });
  assert.equal(drained.nextCursor, null);
  assert.ok((await runtime.apps.perform(a, "browse", args)).nextCursor);
});
test("browser cursors, history and card references are isolated by agent", async (t) => {
  let calls = 0;
  const { runtime } = setup(t, async () => ({
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
test("changing presentation page size does not change backend numbered page boundaries", async (t) => {
  const batches = [];
  const { runtime } = setup(t, async (job) => {
    batches.push(job.backendLimit);
    const offset = ((job.cursor?.page || 1) - 1) * job.backendLimit;
    return {
      items: Array.from({ length: job.backendLimit }, (_, i) => ({
        url: `https://www.zhihu.com/question/123/answer/${offset + i + 1}`,
      })),
      next: { page: (job.cursor?.page || 1) + 1 },
      coverage: "listing",
    };
  });
  const ctx = context(runtime),
    first = await runtime.callTool(ctx, "app_browse", {
      platform: "zhihu",
      entry: "recommend",
      limit: 2,
    });
  const second = await runtime.callTool(ctx, "app_browse", {
    platform: "zhihu",
    entry: "recommend",
    limit: 5,
    cursor: first.nextCursor,
  });
  assert.deepEqual(batches, [2, 2]);
  assert.equal(second.items[0].id, "question/123/answer/3");
});
test("browser scroll cursors retain cached rows but reject live continuation after restart", async (t) => {
  for (const job of [
    { platform: "heybox", operation: "search", query: "游戏" },
    { platform: "xiaohongshu", operation: "browse", entry: "recommend" },
  ]) {
    let calls = 0;
    const prefix =
      job.platform === "heybox"
        ? "https://www.xiaoheihe.cn/app/bbs/link/"
        : "https://www.xiaohongshu.com/explore/";
    const ids =
      job.platform === "heybox"
        ? ["123", "456"]
        : ["1234567890abcdef12345678", "1234567890abcdef12345679"];
    const adapter = {
      capabilities: () => [],
      perform: async () => {
        calls++;
        return {
          items: ids.map((id) => ({ url: prefix + id, title: id })),
          next: { page: 2 },
          coverage: "search-results-scroll",
        };
      },
    };
    const { runtime } = setup(t, adapter.perform);
    runtime.agent("agent-0").apps.platforms = [job.platform];
    const ctx = context(runtime),
      first = await runtime.apps.perform(ctx, job.operation, {
        ...job,
        limit: 1,
      });
    runtime.apps = new AppBrowsing(runtime, { adapter });
    const cached = await runtime.apps.perform(ctx, job.operation, {
      ...job,
      limit: 1,
      cursor: first.nextCursor,
    });
    assert.equal(cached.items.length, 1);
    assert.equal(cached.nextCursor, null);
    assert.equal(cached.completion, "interrupted");
    assert.match(cached.notice, /重启/);
    assert.equal(calls, 1);
    const next = await runtime.apps.perform(ctx, job.operation, {
      ...job,
      limit: 20,
    });
    runtime.apps = new AppBrowsing(runtime, { adapter });
    await assert.rejects(
      runtime.apps.perform(ctx, job.operation, {
        ...job,
        cursor: next.nextCursor,
      }),
      /APP_CURSOR_RESTARTED/,
    );
    assert.equal(calls, 2);
  }
});

test("private recollection can open fixed feeds but cannot submit query text or board names", async (t) => {
  const { runtime, store } = setup(t, async () => ({
    items: [{ url, title: "公开推荐" }],
    next: null,
    coverage: "personalized-recommendations",
  }));
  runtime.agent("agent-0").tools.push("app_search");
  store.bind("agent-0").append({
    connectionId: "qq-0",
    conversation: "private:30000",
    senderId: "30000",
    kind: "message.received",
    direction: "in",
    body: "合成私聊兴趣 科技",
    dedupe: "private-interest",
  });
  const ctx = context(runtime);
  await runtime.callTool(ctx, "memory_search", { query: "合成私聊兴趣" });
  assert(ctx.privateRead.size > 0);
  const feed = await runtime.callTool(ctx, "app_browse", {
    platform: "zhihu",
    entry: "recommend",
  });
  assert.equal(feed.items.length, 1);
  await assert.rejects(
    runtime.callTool(ctx, "app_search", { platform: "zhihu", query: "科技" }),
    /PRIVATE_RECOLLECTION_EXTERNAL_CALL_BLOCKED/,
  );
  await assert.rejects(
    runtime.callTool(ctx, "app_browse", {
      platform: "zhihu",
      entry: "board",
      board: "科技",
    }),
    /PRIVATE_RECOLLECTION_EXTERNAL_CALL_BLOCKED/,
  );
  ctx.privateRead.add("operations:fixture");
  await runtime.callTool(ctx, "app_browse", {
    platform: "zhihu",
    entry: "recommend",
  });
  await assert.rejects(
    runtime.callTool(ctx, "app_search", {
      platform: "zhihu",
      query: "operations text",
    }),
    /RESTRICTED/,
  );
});

test("model app history taints only returned cross-chat QQ sources and persists the restriction", async (t) => {
  let calls = 0;
  const { runtime, store } = setup(t, async () => {
    calls++;
    return { items: [], coverage: "listing" };
  });
  runtime.agent("agent-0").tools.push("app_search");
  const m = store.bind("agent-0"),
    privateCtx = context(runtime, "agent-0", "private:30000");
  const event = m.append({
    connectionId: "qq-0",
    conversation: privateCtx.conversation,
    senderId: "30000",
    kind: "message.received",
    direction: "in",
    body: "[json]",
    dedupe: "private-card-history",
    payload: {
      segments: [
        {
          type: "json",
          data: {
            data: JSON.stringify({
              meta: {
                news: {
                  title: "私聊卡片标题",
                  desc: "合成私密摘要",
                  jumpUrl: url,
                },
              },
            }),
          },
        },
      ],
    },
  });
  const card = (
    await runtime.callTool(privateCtx, "qq_read_share_card", {
      eventId: event.id,
    })
  ).items[0];
  for (let i = 0; i < 20; i++)
    runtime.apps.record(privateCtx, {
      origin: "app-browser",
      platform: "zhihu",
      url,
      title: "公开来源" + i,
      readingScope: "listing",
    });
  const ctx = context(runtime);
  const first = await runtime.callTool(ctx, "app_history", {});
  assert.equal(first.items.length, 20);
  assert.equal(first.nextOffset, 20);
  assert.equal(ctx.privateRead.size, 0);
  await runtime.callTool(ctx, "app_search", {
    platform: "zhihu",
    query: "公开搜索",
  });
  const page = await runtime.callTool(ctx, "app_history", {
    offset: first.nextOffset,
  });
  assert.equal(page.items[0].recordId, card.recordId);
  assert.equal(page.items[0].summary, "合成私密摘要");
  const before = calls;
  await assert.rejects(
    runtime.callTool(ctx, "app_search", {
      platform: "zhihu",
      query: page.items[0].summary,
    }),
    /PRIVATE_RECOLLECTION_EXTERNAL_CALL_BLOCKED/,
  );
  assert.equal(calls, before);
  assert(ctx.privateRead.has(card.recordId));
  const resumed = context(runtime);
  assert(resumed.privateRead.has(card.recordId));
  await assert.rejects(
    runtime.callTool(resumed, "app_search", {
      platform: "zhihu",
      query: "合成私密摘要",
    }),
    /PRIVATE_RECOLLECTION_EXTERNAL_CALL_BLOCKED/,
  );
  assert.equal(calls, before);
  assert.equal(
    (await runtime.callTool(context(runtime, "agent-1"), "app_history", {}))
      .items.length,
    0,
  );
  assert.equal(
    runtime.apps.history("agent-0", 20).items[0].recordId,
    card.recordId,
  );
  const original = context(runtime, "agent-0", "private:30000");
  await runtime.callTool(original, "app_history", { offset: 20 });
  assert.equal(original.privateRead.size, 0);
});

test("stored App reads retain cross-chat QQ provenance even in their recording conversation", async (t) => {
  const { runtime } = setup(t, async () => ({ items: [] }));
  for (const origin of ["qq-card", "app-browser"]) {
    const recorded = context(runtime);
    const card = runtime.apps.record(recorded, {
      origin,
      platform: "zhihu",
      url,
      title: "资料",
      summary: origin === "qq-card" ? "合成摘要" : undefined,
      source: { conversation: "private:30000", senderId: "30000" },
    });
    const reader = context(runtime);
    reader.privateRead.clear();
    runtime.apps.get(reader, card.recordId);
    assert(reader.privateRead.has(card.recordId));
  }
});
