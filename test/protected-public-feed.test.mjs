import test from "node:test";
import assert from "node:assert/strict";
import { config, fixture, context } from "./helpers.mjs";
import { AppBrowsing } from "../src/apps/service.mjs";

const scope = "private:30000";
const browse = { platform: "heybox", entry: "recommend", limit: 3 };
const url = "https://www.xiaoheihe.cn/app/bbs/link/123456";
function setup(t) {
  const cfg = config(1),
    a = cfg.agents[0];
  a.ownerIds = ["30000"];
  a.network.autonomous = true;
  a.apps.enabled = true;
  a.apps.platforms = ["heybox"];
  a.apps.hours.enabled = false;
  a.apps.maxReadsPerTurn = 20;
  a.tools.push(
    "app_capabilities",
    "app_browse",
    "app_read",
    "app_record",
    "app_comments",
    "app_boards",
    "app_search",
    "web_fetch",
    "external_tool",
  );
  cfg.backends[0].toolServers = [
    {
      id: "exa",
      transport: "http",
      url: "https://mcp.exa.ai/mcp",
      allowedTools: ["web_search_exa"],
    },
  ];
  const f = fixture(t, { cfg });
  const calls = [];
  f.runtime.backends.set("agent-0", {
    external: {
      call: async () => {
        throw Error("UNEXPECTED_EXTERNAL_CALL");
      },
    },
    close: async () => {},
  });
  f.runtime.apps = new AppBrowsing(f.runtime, {
    adapter: {
      capabilities: () => [],
      perform: async (job) => {
        calls.push(job);
        return {
          items: [{ url, title: "public result", text: "public body" }],
          next: job.cursor ? null : { page: 2 },
          coverage: "article",
        };
      },
    },
    resolve: async (value, options) => {
      options.authorize(value);
      return { platform: "heybox", url: value };
    },
  });
  return { ...f, calls, m: f.store.bind("agent-0") };
}

test("owner private diary recall still permits fixed public feeds, detail and comments without clearing protection", async (t) => {
  const f = setup(t);
  const diary = f.m.diaryWrite(
    { title: "network", body: "PRIVATE_REPOSITORY_TEXT" },
    "ai-diary",
    {},
    false,
    ["fixture/private"],
  );
  const ctx = context(f.runtime, "agent-0", scope);
  const recall = await f.runtime.callTool(ctx, "memory_search", {
    query: "network",
  });
  assert(recall.diaries.some((x) => x.id === diary.id));
  assert(ctx.privateRead.has("github-private:fixture/private"));
  const page = await f.runtime.callTool(ctx, "app_browse", browse);
  assert.equal(page.items[0].title, "public result");
  const recordId = page.items[0].recordId;
  await f.runtime.callTool(ctx, "app_read", { recordId });
  await f.runtime.callTool(ctx, "app_comments", { recordId });
  await f.runtime.callTool(ctx, "app_record", { recordId });
  await f.runtime.callTool(ctx, "app_browse", {
    ...browse,
    cursor: page.nextCursor,
  });
  assert.equal(f.calls.length, 4);
  assert.doesNotMatch(
    JSON.stringify(f.calls),
    /PRIVATE_REPOSITORY_TEXT|fixture\/private/,
  );
  assert(
    f.m.state(scope).disclosureTaint.includes("github-private:fixture/private"),
  );
  const resumed = context(f.runtime, "agent-0", scope);
  await f.runtime.callTool(resumed, "app_browse", browse);
  await assert.rejects(
    f.runtime.callTool(resumed, "web_fetch", {
      url: "https://www.bing.com/search?format=rss&q=public+games",
    }),
    /EXTERNAL_CALL_BLOCKED/,
  );
});

test("protected sources cannot escape through query, URL, board, QQ card or search cursor", async (t) => {
  const f = setup(t),
    ctx = context(f.runtime, "agent-0", scope);
  const search = await f.runtime.callTool(ctx, "app_search", {
    platform: "heybox",
    query: "old query",
  });
  const card = f.runtime.apps.record(ctx, {
    platform: "heybox",
    url,
    origin: "qq-card",
    source: { conversation: scope },
    ok: true,
  });
  ctx.privateRead.add("github-private:fixture/private");
  const before = f.calls.length;
  for (const [name, args] of [
    ["web_fetch", { url: "https://example.com/?q=PRIVATE" }],
    [
      "external_tool",
      {
        serverId: "exa",
        tool: "web_search_exa",
        arguments: { query: "PRIVATE" },
      },
    ],
    ["app_search", { platform: "heybox", query: "PRIVATE" }],
    ["app_browse", { platform: "heybox", entry: "board", board: "PRIVATE" }],
    ["app_browse", { ...browse, board: "PRIVATE" }],
    ["app_read", { recordId: card.recordId }],
    ["app_comments", { recordId: card.recordId }],
    [
      "app_search",
      { platform: "heybox", query: "old query", cursor: search.nextCursor },
    ],
    ["app_browse", { ...browse, cursor: search.nextCursor }],
  ])
    await assert.rejects(
      f.runtime.callTool(ctx, name, args),
      /EXTERNAL_CALL_BLOCKED|APP_RESTRICTED_CONTEXT|APP_CURSOR_INVALID/,
    );
  assert.equal(f.calls.length, before);
  assert.throws(
    () => f.runtime.apps.active(ctx, "heybox", { fixed: true, sharing: true }),
    /APP_RESTRICTED_CONTEXT/,
  );
});

test("fixed feed capability reflects protected durable records without losing permissions, hours or budgets", async (t) => {
  const f = setup(t),
    ctx = context(f.runtime, "agent-0", scope);
  const diary = f.m.diaryWrite(
    { title: "protected", body: "secret" },
    "ai-diary",
    {},
    true,
    [],
  );
  ctx.privateRead.add(diary.id); // Legacy context has the durable id without a literal marker.
  const caps = await f.runtime.callTool(ctx, "app_capabilities", {});
  assert.equal(caps.contextGate.allowed, false);
  assert.equal(caps.fixedPublicReads.allowed, true);
  await assert.rejects(
    f.runtime.callTool(ctx, "app_search", {
      platform: "heybox",
      query: "secret",
    }),
    /APP_RESTRICTED_CONTEXT/,
  );
  await f.runtime.callTool(ctx, "app_boards", { platform: "heybox" });
  f.runtime.agent(ctx.agentId).apps.maxReadsPerTurn = 1;
  await assert.rejects(
    f.runtime.callTool(ctx, "app_browse", browse),
    /APP_READ_BUDGET/,
  );
  f.runtime.agent(ctx.agentId).apps.maxReadsPerTurn = 20;
  f.runtime.agent(ctx.agentId).apps.maxReadsPerDay = 1;
  await assert.rejects(
    f.runtime.callTool(
      context(f.runtime, "agent-0", scope),
      "app_browse",
      browse,
    ),
    /APP_READ_BUDGET/,
  );
  f.runtime.agent(ctx.agentId).apps.maxReadsPerDay = 30;
  f.runtime.agent(ctx.agentId).apps.hours = {
    enabled: true,
    timezone: "UTC",
    start: "01:00",
    end: "02:00",
    scope: "all",
  };
  f.runtime.clock = () => new Date("2026-01-01T12:00:00Z");
  await assert.rejects(
    f.runtime.callTool(ctx, "app_browse", browse),
    /APP_OUTSIDE_HOURS/,
  );
  assert.equal(
    (await f.runtime.callTool(ctx, "app_capabilities", {})).fixedPublicReads
      .allowed,
    false,
  );
  f.runtime.agent(ctx.agentId).apps.hours.enabled = false;
  f.runtime.agent(ctx.agentId).apps.platforms = [];
  await assert.rejects(
    f.runtime.callTool(ctx, "app_browse", browse),
    /APP_PERMISSION_DISABLED/,
  );
  assert.equal(f.calls.length, 1);
});

test("fixed read still rechecks cancellation after awaiting the platform", async (t) => {
  const f = setup(t),
    ctx = context(f.runtime, "agent-0", scope);
  ctx.privateRead.add("operations:fixture");
  f.runtime.apps.adapter.perform = async () => {
    ctx.controller.abort();
    return { items: [] };
  };
  await assert.rejects(f.runtime.callTool(ctx, "app_browse", browse));
  assert.equal(
    f.runtime.apps.history(ctx.agentId).items.filter((x) => x.ok).length,
    0,
  );
});
