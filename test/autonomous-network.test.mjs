import test from "node:test";
import assert from "node:assert/strict";
import { config, fixture, context, FakeTransport } from "./helpers.mjs";
import { ConfigStore, validateConfig } from "../src/core/config.mjs";
import { AppBrowsing } from "../src/apps/service.mjs";
import { scopedCatalog } from "../src/tools/catalog.mjs";

const search = {
  serverId: "exa",
  tool: "web_search_exa",
  arguments: { query: "public election results" },
};
function setup(t, backend = "codex") {
  const cfg = config(2);
  cfg.backends[0].type = backend;
  cfg.backends[0].toolServers = [
    {
      id: "exa",
      transport: "http",
      url: "https://mcp.exa.ai/mcp",
      allowedTools: ["web_search_exa"],
    },
  ];
  for (const a of cfg.agents) {
    a.tools.push(
      "external_tool",
      "web_fetch",
      "app_capabilities",
      "app_search",
      "app_browse",
      "app_read",
      "app_comments",
      "app_history",
    );
    a.apps.enabled = true;
    a.apps.platforms = ["zhihu", "bilibili", "tieba"];
    a.apps.hours.enabled = false;
  }
  const f = fixture(t, { cfg });
  // Mutate after parsing so old code reaches the real authorization failure.
  f.runtime.agent("agent-0").network.autonomous = true;
  const calls = [];
  f.runtime.backends.set("agent-0", {
    external: {
      call: async (server, tool, args) => {
        calls.push({ server, tool, args });
        return { content: [{ type: "text", text: "public result" }] };
      },
    },
    close: async () => {},
  });
  f.runtime.fetchPublicPage = async (url) => {
    calls.push({ url });
    return { body: "public page" };
  };
  f.runtime.apps = new AppBrowsing(f.runtime, {
    adapter: {
      capabilities: () => [],
      perform: async (job) => {
        calls.push(job);
        return { items: [], coverage: "listing" };
      },
    },
    resolve: async (url) => ({ platform: "zhihu", url }),
  });
  const ctx = context(f.runtime);
  ctx.privateRead.add("context:" + ctx.conversation);
  ctx.privateRead.add("unknown-legacy-source");
  ctx.persistTaint();
  return { ...f, ctx, calls };
}

test("autonomous network is opt-in, persistent and isolated per agent", (t) => {
  const cfg = config(2);
  assert.equal(cfg.agents[0].network.autonomous, false);
  cfg.agents[0].network.autonomous = true;
  const f = fixture(t, { cfg });
  const reopened = new ConfigStore(f.configStore.file);
  assert.equal(reopened.value.agents[0].network.autonomous, true);
  assert.equal(reopened.value.agents[1].network.autonomous, false);
  assert.throws(() =>
    validateConfig({
      ...cfg,
      agents: [{ ...cfg.agents[0], network: { autonomous: "yes" } }],
    }),
  );
});

for (const backend of ["dsh", "codex"])
  test(`${backend} can search and read public pages without commands while retaining provenance`, async (t) => {
    const f = setup(t, backend);
    const before = [...f.ctx.privateRead];
    await f.runtime.callTool(f.ctx, "external_tool", search);
    assert.equal(
      scopedCatalog(f.runtime, f.ctx, { names: ["external_tool"] }).network
        .autonomous,
      true,
    );
    await f.runtime.callTool(f.ctx, "web_fetch", {
      url: "https://example.com/public",
    });
    assert.equal(f.calls.length, 2);
    assert.deepEqual([...f.ctx.privateRead], before);
    assert.equal(f.ctx.externalGrants.size, 0);
    const resumed = context(f.runtime);
    assert.deepEqual([...resumed.privateRead], before);
    await f.runtime.callTool(resumed, "external_tool", search);
    assert.equal(f.calls.length, 3);
    const other = context(f.runtime, "agent-1");
    other.privateRead.add("context:" + other.conversation);
    await assert.rejects(
      f.runtime.callTool(other, "external_tool", search),
      /EXTERNAL_CALL_BLOCKED/,
    );
    f.runtime.agent("agent-0").network.autonomous = false;
    await assert.rejects(
      f.runtime.callTool(resumed, "external_tool", search),
      /EXTERNAL_CALL_BLOCKED/,
    );
    assert.equal(f.calls.length, 3);
  });

test("autonomous platform search, board browsing and private-origin card reads use existing permissions", async (t) => {
  const f = setup(t);
  await f.runtime.callTool(f.ctx, "app_search", {
    platform: "zhihu",
    query: "公开新闻",
  });
  assert.equal(
    (await f.runtime.callTool(f.ctx, "app_capabilities", {})).autonomousNetwork,
    true,
  );
  await f.runtime.callTool(f.ctx, "app_browse", {
    platform: "tieba",
    entry: "board",
    board: "新闻",
  });
  const card = f.runtime.apps.record(f.ctx, {
    platform: "zhihu",
    url: "https://www.zhihu.com/question/12345",
    title: "public card",
    source: { conversation: "private:30000" },
  });
  await f.runtime.callTool(f.ctx, "app_history", {});
  assert(f.ctx.privateRead.has(card.recordId));
  await f.runtime.callTool(f.ctx, "app_read", { recordId: card.recordId });
  await f.runtime.callTool(f.ctx, "app_comments", { recordId: card.recordId });
  assert.equal(f.calls.length, 4);
  await assert.rejects(
    f.runtime.callTool(f.ctx, "app_search", {
      platform: "xiaohongshu",
      query: "公开新闻",
    }),
    /APP_PERMISSION_DISABLED/,
  );
  f.runtime.agent("agent-0").apps.maxReadsPerTurn = 4;
  await assert.rejects(
    f.runtime.callTool(f.ctx, "app_search", {
      platform: "zhihu",
      query: "公开新闻",
    }),
    /APP_READ_BUDGET/,
  );
  f.runtime.agent("agent-0").apps.hours = {
    enabled: true,
    scope: "autonomous",
    start: "09:00",
    end: "22:00",
    timezone: "Asia/Shanghai",
  };
  f.runtime.clock = () => new Date("2030-01-01T18:00:00Z");
  await assert.rejects(
    f.runtime.callTool(f.ctx, "app_browse", {
      platform: "zhihu",
      entry: "hot",
    }),
    /APP_OUTSIDE_HOURS/,
  );
});

test("autonomy cannot authorize operations content, media disclosure, secrets or unconfigured external tools", async (t) => {
  const f = setup(t);
  for (const request of [
    { ...search, serverId: "other" },
    { ...search, tool: "unconfigured" },
    {
      ...search,
      audioInput: { audioId: "a".repeat(64), dataArgument: "audio" },
    },
  ])
    assert.throws(
      () =>
        f.runtime.authorizeExternal(f.ctx, {
          tool: "external_tool",
          args: request,
        }),
      /EXTERNAL_CALL_BLOCKED/,
    );
  for (const query of [
    f.ctx.token,
    "Bearer " + "x".repeat(30),
    "http://127.0.0.1/private",
    "file:///tmp/private",
  ]) {
    await assert.rejects(
      f.runtime.callTool(f.ctx, "external_tool", {
        ...search,
        arguments: { query },
      }),
      /BLOCKED|EXTERNAL_URL_REQUIRES_WEB_FETCH/,
    );
  }
  // Use the production page fetcher here so DNS/IP checks, not a stub, run.
  delete f.runtime.fetchPublicPage;
  for (const url of [
    "http://127.0.0.1/private",
    "file:///tmp/private",
    "https://user:pass@example.com/",
  ])
    await assert.rejects(
      f.runtime.callTool(f.ctx, "web_fetch", { url }),
      /URL|PRIVATE|LOOPBACK|PROTOCOL|SCHEME|CREDENTIAL|内网/,
    );
  f.ctx.privateRead.add("operations:fixture");
  await assert.rejects(
    f.runtime.callTool(f.ctx, "external_tool", search),
    /EXTERNAL_CALL_BLOCKED/,
  );
  await assert.rejects(
    f.runtime.callTool(f.ctx, "web_fetch", { url: "https://example.com/" }),
    /EXTERNAL_CALL_BLOCKED/,
  );
  await assert.rejects(
    f.runtime.callTool(f.ctx, "app_search", {
      platform: "zhihu",
      query: "operations text",
    }),
    /APP_RESTRICTED_CONTEXT/,
  );
  assert.equal(f.calls.length, 0);
  await f.runtime.callTool(f.ctx, "app_browse", {
    platform: "zhihu",
    entry: "hot",
  });
  assert.equal(f.calls.length, 1);
});

test("enabling autonomy replaces command-only instructions through normal session handoff", async (t) => {
  const cfg = config(1),
    captured = [];
  cfg.agents[0].tools.push("external_tool", "web_fetch", "app_capabilities");
  const f = fixture(t, {
    cfg,
    run: async (p) => {
      captured.push(p);
      p.saveSession({ id: "synthetic-session", backend: "codex" });
    },
  });
  await f.runtime.wake("agent-0", "group:20000");
  assert.match(captured[0].instructions, /\/search/);
  const next = structuredClone(f.runtime.config);
  next.agents[0].network.autonomous = true;
  await f.runtime.changeConfig(next, f.configStore.revision);
  f.runtime.transports.set("qq-0", new FakeTransport());
  await f.runtime.wake("agent-0", "group:20000");
  assert.match(captured[1].instructions, /自主联网已开启/);
  assert.doesNotMatch(
    captured[1].instructions,
    /明确请求使用 \/search|否则需要控制台按具体请求批准/,
  );
  assert.equal(captured[1].session, null);
});
