import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import dns from "node:dns";
import path from "node:path";
import { VoiceStore } from "../src/tools/voice.mjs";
import { wav } from "./audio-fixture.mjs";
import { EventEmitter } from "node:events";
import { fixture, config, context, raw } from "./helpers.mjs";
import { AppBrowsing } from "../src/apps/service.mjs";
import { appsPolicySchema, inAppHours } from "../src/apps/policy.mjs";
import { sourceCounts } from "../src/core/outbound-policy.mjs";
import {
  safeFetch,
  validateFetchUrl,
  isPrivateIp,
} from "../vendor/social-reader/safe-fetch.js";

function setup(t, backend = "codex") {
  const cfg = config(2);
  cfg.backends[0].type = backend;
  const a = cfg.agents[0];
  a.wake = { ...a.wake, private: false, participation: 0, names: false };
  a.maxSendsPerTurn = 8;
  a.behavior.maxSendPerMinute = 60;
  a.behavior.maxSendPerHour = 200;
  a.tools.push(
    "web_fetch",
    "external_tool",
    "app_search",
    "app_browse",
    "app_read",
    "app_comments",
    "app_boards",
  );
  a.apps = appsPolicySchema.parse({
    enabled: true,
    platforms: ["zhihu", "heybox"],
    hours: { enabled: false },
  });
  const f = fixture(t, { cfg });
  const calls = [];
  f.runtime.fetchPublicPage = async (url, maxChars, { authorize }) => {
    await authorize(url);
    calls.push({ url });
    return { url, body: "synthetic public page", statusCode: 200 };
  };
  f.runtime.apps = new AppBrowsing(f.runtime, {
    adapter: {
      capabilities: () => [],
      perform: async (job) => {
        calls.push(job);
        return { items: [], coverage: "listing" };
      },
    },
    resolve: async (url, { authorize }) => {
      await authorize(url);
      return { platform: "zhihu", url };
    },
  });
  f.runtime.backends.set("agent-0", {
    external: {
      call: async (server, tool, args) => {
        calls.push({ server, tool, args });
        return { content: [{ type: "text", text: "fixture result" }] };
      },
    },
  });
  return { ...f, calls };
}
let seq = 100;
async function incoming(
  f,
  ctx,
  text = "next question",
  extra = {},
  read = true,
) {
  const id = ++seq;
  const msg = raw(id, {
    message: [{ type: "text", data: { text } }],
    ...extra,
  });
  if (ctx.conversation.startsWith("private:")) {
    delete msg.group_id;
    msg.message_type = "private";
  }
  await f.runtime.ingest("qq-0", msg);
  const row = f.store
    .bind(ctx.agentId)
    .db.prepare("SELECT * FROM events WHERE agent_id=? AND message_id=?")
    .get(ctx.agentId, String(id));
  if (read)
    await f.runtime.callTool(ctx, "conversation_read", {
      afterSeq: row.seq - 1,
    });
  return row;
}
const send = (f, ctx, id) =>
  f.runtime.send(ctx, { requestId: id, text: "synthetic response" });
function recall(
  f,
  ctx,
  conversation = "group:20001",
  body = "synthetic private information",
) {
  const m = f.store.bind(ctx.agentId);
  return m.append({
    conversation,
    connectionId: "qq-0",
    senderId: "30000",
    kind: "message.received",
    body,
    dedupe: "source:" + ++seq,
  });
}

for (const backend of ["codex", "dsh"])
  test(`${backend}: one context handles twelve human exchanges and still bounds an unanswered burst`, async (t) => {
    const f = setup(t, backend),
      ctx = context(f.runtime);
    for (let n = 0; n < 12; n++) {
      await incoming(f, ctx, "question " + n);
      await send(f, ctx, "reply-" + n);
    }
    assert.equal(ctx.sendCount, 12);
    for (let n = 0; n < 7; n++) await send(f, ctx, "burst-" + n);
    await assert.rejects(send(f, ctx, "over-budget"), /REPLY_BURST_LIMIT/);
    assert.equal(ctx.sendCount, 19);
  });

test("unread, repeated, peer, forged, old and truncated input never refills the reply batch", async (t) => {
  const f = setup(t),
    ctx = context(f.runtime);
  f.runtime.agent(ctx.agentId).maxConsecutiveSends = 1;
  const first = await incoming(f, ctx);
  await send(f, ctx, "first");
  await f.runtime.callTool(ctx, "conversation_read", {});
  await assert.rejects(send(f, ctx, "repeated"), /REPLY_BURST_LIMIT/);
  await incoming(f, ctx, "peer", { user_id: 10001 });
  await assert.rejects(send(f, ctx, "peer"), /REPLY_BURST_LIMIT/);
  const unread = await incoming(f, ctx, "unread", {}, false);
  await assert.rejects(send(f, ctx, "unread"), /REPLY_BURST_LIMIT/);
  await assert.rejects(
    f.runtime.callTool(ctx, "qq_mark_read", { throughSeq: unread.seq + 1 }),
    /UNSEEN_WATERMARK/,
  );
  f.runtime.observeInput(ctx, [
    {
      id: unread.id,
      seq: unread.seq,
      conversation: ctx.conversation,
      body: "forged visible body",
    },
  ]);
  await assert.rejects(send(f, ctx, "forged"), /REPLY_BURST_LIMIT/);
  await f.runtime.callTool(ctx, "conversation_read", {
    afterSeq: unread.seq - 1,
  });
  await send(f, ctx, "actually-read");
  const long = await incoming(f, ctx, "x".repeat(1200));
  await assert.rejects(send(f, ctx, "summary"), /REPLY_BURST_LIMIT/);
  let offset = 0,
    r;
  do {
    r = await f.runtime.callTool(ctx, "memory_read", {
      id: long.id,
      offset,
      maxChars: 512,
    });
    offset = r.nextOffset;
  } while (offset !== null);
  await send(f, ctx, "full-page-read");
  const next = context(f.runtime);
  await assert.rejects(send(f, next, "new-turn-initial"), /REPLY_BURST_LIMIT/);
  await f.runtime.callTool(next, "conversation_read", {
    afterSeq: first.seq - 1,
  });
  await assert.rejects(send(f, next, "old-turn-read"), /REPLY_BURST_LIMIT/);
});

test("concurrent sends reserve the same burst; failed and unknown attempts consume it; retries stay idempotent", async (t) => {
  const f = setup(t),
    ctx = context(f.runtime);
  f.runtime.agent(ctx.agentId).maxConsecutiveSends = 1;
  const results = await Promise.allSettled([
    send(f, ctx, "one"),
    send(f, ctx, "two"),
  ]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal((await send(f, ctx, "one")).duplicate, true);
  for (const [i, failure] of [
    "ONEBOT_REJECTED",
    "DELIVERY_UNCONFIRMED",
  ].entries()) {
    await incoming(f, ctx);
    f.runtime.transports.get("qq-0").failure = failure;
    await assert.rejects(
      send(f, ctx, "failure-" + i),
      /DELIVERY_(FAILED|UNKNOWN)/,
    );
    await assert.rejects(send(f, ctx, "failure-" + i), /ALREADY_ATTEMPTED/);
    await assert.rejects(send(f, ctx, "replacement-" + i), /REPLY_BURST_LIMIT/);
  }
});

test("fresh human input does not reset minute/hour or autonomous-intent restrictions", async (t) => {
  const f = setup(t),
    ctx = context(f.runtime);
  f.runtime.agent(ctx.agentId).behavior.maxSendPerMinute = 1;
  await send(f, ctx, "first");
  await incoming(f, ctx);
  await assert.rejects(send(f, ctx, "rate"), /SEND_RATE_LIMIT/);
  ctx.intentOnly = true;
  await assert.rejects(send(f, ctx, "intent"), /INTENT_DECISION_REQUIRED/);
});

test("legacy group taint survives resume yet a configured exact public URL remains readable", async (t) => {
  const f = setup(t),
    ctx = context(f.runtime, "agent-0", "private:30000");
  const source = recall(f, ctx);
  await f.runtime.callTool(ctx, "memory_search", {
    query: "synthetic private information",
  });
  assert(ctx.privateRead.has(source.id));
  f.runtime.agent(ctx.agentId).network.publicUrls = ["https://example.com/"];
  const resumed = context(f.runtime, ctx.agentId, ctx.conversation);
  assert(resumed.privateRead.has(source.id));
  assert.equal(sourceCounts(f.runtime, resumed)["group-conversation"], 1);
  await f.runtime.callTool(resumed, "web_fetch", {
    url: "https://example.com",
  });
  assert.equal(f.calls.length, 1);
  await assert.rejects(
    f.runtime.callTool(resumed, "web_fetch", {
      url: "https://example.com/?q=synthetic-private-information",
    }),
    /EXTERNAL_CALL_BLOCKED/,
  );
  assert.equal(f.calls.length, 1);
});

test("same-private history, other private history, diary, missing legacy and operations keep egress provenance", async (t) => {
  const f = setup(t),
    ctx = context(f.runtime, "agent-0", "private:30000");
  const same = recall(f, ctx, ctx.conversation),
    other = recall(f, ctx, "private:30001");
  const diary = f.store
    .bind(ctx.agentId)
    .diaryWrite({ title: "fixture", body: "diary", evidence: [other.id] });
  for (const id of [same.id, other.id, diary.id])
    await f.runtime.callTool(ctx, "memory_read", { id });
  ctx.privateRead.add("missing-legacy");
  ctx.privateRead.add("operations:fixture");
  ctx.persistTaint();
  const resumed = context(f.runtime, ctx.agentId, ctx.conversation);
  const classes = sourceCounts(f.runtime, resumed);
  assert.equal(classes["private-conversation"], 2);
  assert.equal(classes["personal-diary"], 1);
  assert.equal(classes["operations"], 1);
  assert.equal(classes["unknown-legacy"], 1);
  await assert.rejects(
    f.runtime.callTool(resumed, "external_tool", {
      serverId: "fixture",
      tool: "search",
      arguments: { q: "private detail" },
    }),
    /EXTERNAL_CALL_BLOCKED/,
  );
  assert.equal(f.calls.length, 0);
});

test("visible human URL authorizes only that URL, not model extensions or peer/old references", async (t) => {
  const f = setup(t),
    ctx = context(f.runtime);
  ctx.privateRead.add("operations:synthetic");
  const human = await incoming(
    f,
    ctx,
    "请打开 https://example.com/public?q=hello",
  );
  await f.runtime.callTool(ctx, "web_fetch", {
    url: "https://example.com/public?q=hello",
    requestEventId: human.id,
  });
  for (const url of [
    "https://example.com/public?q=secret",
    "https://example.com/other",
  ])
    await assert.rejects(
      f.runtime.callTool(ctx, "web_fetch", { url, requestEventId: human.id }),
      /EXTERNAL_CALL_BLOCKED/,
    );
  const peer = await incoming(f, ctx, "https://peer.example.org/", {
    user_id: 10001,
  });
  await assert.rejects(
    f.runtime.callTool(ctx, "web_fetch", {
      url: "https://peer.example.org/",
      requestEventId: peer.id,
    }),
    /EXTERNAL_CALL_BLOCKED/,
  );
  const resumed = context(f.runtime);
  await assert.rejects(
    f.runtime.callTool(resumed, "web_fetch", {
      url: "https://example.com/public?q=hello",
      requestEventId: human.id,
    }),
    /EXTERNAL_CALL_BLOCKED/,
  );
});

test("exact admin grants bind tool, full arguments and source set, never all future calls", async (t) => {
  const f = setup(t),
    ctx = context(f.runtime);
  ctx.privateRead.add("old-private-source");
  const args = {
    serverId: "fixture",
    tool: "search",
    arguments: { q: "synthetic approved query", limit: 1 },
  };
  await assert.rejects(
    f.runtime.callTool(ctx, "external_tool", args),
    /EXTERNAL_CALL_BLOCKED/,
  );
  const pending = ctx.disclosureRequest;
  assert.throws(
    () => f.runtime.grant(ctx.token, pending.records),
    /EXACT_EXTERNAL/,
  );
  f.runtime.grant(ctx.token, pending.records, pending.requestId);
  await f.runtime.callTool(ctx, "external_tool", args);
  await assert.rejects(
    f.runtime.callTool(ctx, "external_tool", {
      ...args,
      arguments: { ...args.arguments, q: "different" },
    }),
    /EXTERNAL_CALL_BLOCKED/,
  );
  ctx.privateRead.add("new-source");
  await assert.rejects(
    f.runtime.callTool(ctx, "external_tool", args),
    /EXTERNAL_CALL_BLOCKED/,
  );
  assert.equal(f.calls.length, 1);
});

test("credentials in URLs or nested MCP arguments are rejected even when a human requested them", async (t) => {
  const f = setup(t),
    ctx = context(f.runtime);
  for (const url of [
    "https://example.com/?access_token=synthetic",
    "https://user:pass@example.com/",
    "https://example.com/?q=sk-abcdefghijklmnopqrstuvw",
  ]) {
    const event = await incoming(f, ctx, url);
    await assert.rejects(
      f.runtime.callTool(ctx, "web_fetch", { url, requestEventId: event.id }),
      /SENSITIVE|CREDENTIALS|DENIED/,
    );
  }
  const event = await incoming(
    f,
    ctx,
    '/mcp fixture read {"nested":{"password":"synthetic"}}',
  );
  await assert.rejects(
    f.runtime.callTool(ctx, "external_tool", {
      serverId: "fixture",
      tool: "read",
      arguments: { nested: { password: "synthetic" } },
      requestEventId: event.id,
    }),
    /SENSITIVE/,
  );
  assert.equal(f.calls.length, 0);
});

test("fixed platform feed remains available; explicit search only passes its own exact query", async (t) => {
  const f = setup(t),
    ctx = context(f.runtime);
  ctx.privateRead.add("recalled-private");
  await f.runtime.callTool(ctx, "app_browse", {
    platform: "zhihu",
    entry: "recommend",
  });
  await assert.rejects(
    f.runtime.callTool(ctx, "app_search", {
      platform: "zhihu",
      query: "private phrase",
    }),
    /EXTERNAL_CALL_BLOCKED/,
  );
  const event = await incoming(f, ctx, "/search zhihu public topic");
  await f.runtime.callTool(ctx, "app_search", {
    platform: "zhihu",
    query: "public topic",
    requestEventId: event.id,
  });
  await assert.rejects(
    f.runtime.callTool(ctx, "app_search", {
      platform: "zhihu",
      query: "public topic private addition",
      requestEventId: event.id,
    }),
    /EXTERNAL_CALL_BLOCKED/,
  );
  assert.equal(f.calls.length, 2);
});

test("hours off, overnight, timezone, explicit all-hours policy and current user requests", async (t) => {
  const f = setup(t),
    ctx = context(f.runtime),
    a = f.runtime.agent(ctx.agentId);
  f.runtime.clock = () => new Date("2026-10-26T15:00:00Z"); // 23:00 Shanghai
  a.apps.hours = {
    enabled: true,
    scope: "autonomous",
    start: "09:00",
    end: "22:00",
    timezone: "Asia/Shanghai",
  };
  await assert.rejects(
    f.runtime.callTool(ctx, "app_browse", {
      platform: "zhihu",
      entry: "recommend",
    }),
    /OUTSIDE_HOURS/,
  );
  const event = await incoming(f, ctx, "/browse zhihu recommend");
  await f.runtime.callTool(ctx, "app_browse", {
    platform: "zhihu",
    entry: "recommend",
    requestEventId: event.id,
  });
  a.apps.hours.scope = "all";
  await assert.rejects(
    f.runtime.callTool(ctx, "app_browse", {
      platform: "zhihu",
      entry: "recommend",
      requestEventId: event.id,
    }),
    /OUTSIDE_HOURS/,
  );
  a.apps.hours.enabled = false;
  await f.runtime.callTool(ctx, "app_browse", {
    platform: "zhihu",
    entry: "recommend",
  });
  a.apps.maxReadsPerTurn = 2;
  await assert.rejects(
    f.runtime.callTool(ctx, "app_browse", {
      platform: "zhihu",
      entry: "recommend",
    }),
    /READ_BUDGET/,
  );
  const p = appsPolicySchema.parse({
    hours: { start: "22:00", end: "07:00", timezone: "Asia/Shanghai" },
  });
  assert(inAppHours(p, new Date("2026-10-26T15:00:00Z")));
  assert(!inAppHours(p, new Date("2026-10-26T04:00:00Z")));
});

test("web redirect authorization runs before the next network hop; approved URL never overrides SSRF", async (t) => {
  let requests = 0;
  t.mock.method(http, "request", (options, callback) => {
    requests++;
    assert.equal(options.hostname, "93.184.216.34");
    const req = new EventEmitter();
    req.end = () => {
      const res = new EventEmitter();
      res.statusCode = 302;
      res.headers = {
        location: "http://93.184.216.34/?access_token=synthetic",
      };
      res.destroy = () => {};
      callback(res);
    };
    req.destroy = () => {};
    return req;
  });
  const f = setup(t),
    ctx = context(f.runtime);
  ctx.privateRead.add("private-source");
  f.runtime.agent(ctx.agentId).network.publicUrls = ["http://93.184.216.34/"];
  await assert.rejects(
    safeFetch("http://93.184.216.34/", 100, {
      authorize: (url) =>
        f.runtime.authorizeExternal(ctx, { tool: "web_fetch", args: { url } }),
    }),
    /CREDENTIALS/,
  );
  assert.equal(requests, 1);
  for (const url of [
    "http://127.0.0.1/",
    "http://[::1]/",
    "http://169.254.169.254/",
    "http://localhost/",
  ])
    await assert.rejects(validateFetchUrl(url));
  assert(isPrivateIp("::ffff:127.0.0.1"));
  assert(isPrivateIp("10.1.2.3"));
  assert.equal(requests, 1);
});

test("legacy same-private handoff and resumed backend context conservatively recover source protection", async (t) => {
  const f = setup(t),
    m = f.store.bind("agent-0"),
    conversation = "private:30000";
  const source = m.append({
    conversation,
    kind: "message.received",
    body: "synthetic-private-handoff",
    dedupe: "legacy-handoff",
  });
  m.setState(conversation, {
    readThroughSeq: source.seq,
    continuity: { anchors: [source.id], recent: [source.id] },
  });
  const ctx = context(f.runtime, "agent-0", conversation);
  const prepared = f.runtime.contexts.prepare(ctx, {}, [], []);
  assert(JSON.stringify(prepared).includes("synthetic-private-handoff"));
  assert(ctx.privateRead.has(source.id));
  assert(ctx.privateRead.has("context:" + conversation));
  assert.throws(
    () =>
      f.runtime.authorizeExternal(ctx, {
        tool: "external_tool",
        args: {
          serverId: "fixture",
          tool: "search",
          arguments: { q: "synthetic-private-handoff" },
        },
      }),
    /EXTERNAL_CALL_BLOCKED/,
  );
  const resumed = context(f.runtime, "agent-0", conversation);
  assert(resumed.privateRead.has(source.id));
});

test("external approval UI retains complete source set even after a QQ-only grant", async (t) => {
  const f = setup(t),
    ctx = context(f.runtime);
  ctx.privateRead.add("operations:fixture");
  ctx.grants.add("operations:fixture");
  const request = {
    tool: "web_fetch",
    args: { url: "https://example.com/public" },
  };
  assert.throws(
    () => f.runtime.authorizeExternal(ctx, request),
    /EXTERNAL_CALL_BLOCKED/,
  );
  const pending = f.runtime.status().disclosureRequests[0];
  assert.deepEqual(pending.records, ["operations:fixture"]);
  f.runtime.grant(ctx.token, pending.records, pending.requestId);
  assert.equal(
    f.runtime.authorizeExternal(ctx, request).basis,
    "exact-request-grant",
  );
});

test("MCP URL delegation is rejected rather than trusting a discarded DNS preflight", async (t) => {
  const f = setup(t),
    ctx = context(f.runtime);
  for (const url of [
    "https://example.com/public",
    "http://127.0.0.1/",
    "file:///fixture/private",
    "http:127.0.0.1",
    "HTTP:169.254.169.254/latest/meta-data",
    "//127.0.0.1/",
  ]) {
    const args = { serverId: "fixture", tool: "read", arguments: { url } };
    const event = await incoming(
      f,
      ctx,
      `/mcp fixture read ${JSON.stringify(args.arguments)}`,
    );
    await assert.rejects(
      f.runtime.callTool(ctx, "external_tool", {
        ...args,
        requestEventId: event.id,
      }),
      /EXTERNAL_URL_REQUIRES_WEB_FETCH/,
    );
  }
  assert.equal(f.calls.length, 0);
});

test("current natural platform test requests bypass autonomous hours without granting different actions", async (t) => {
  const f = setup(t),
    ctx = context(f.runtime),
    a = f.runtime.agent(ctx.agentId);
  a.apps.hours = {
    enabled: true,
    scope: "autonomous",
    start: "09:00",
    end: "22:00",
    timezone: "Asia/Shanghai",
  };
  f.runtime.clock = () => new Date("2026-10-26T15:00:00Z");
  const event = await incoming(f, ctx, "帮我测试知乎能不能浏览");
  await f.runtime.callTool(ctx, "app_browse", {
    platform: "zhihu",
    entry: "recommend",
    requestEventId: event.id,
  });
  await assert.rejects(
    f.runtime.callTool(ctx, "app_browse", {
      platform: "heybox",
      entry: "recommend",
      requestEventId: event.id,
    }),
    /OUTSIDE_HOURS/,
  );
  const search = await incoming(f, ctx, "请在知乎搜索「公共话题」");
  await f.runtime.callTool(ctx, "app_search", {
    platform: "zhihu",
    query: "公共话题",
    requestEventId: search.id,
  });
});

test("audio MCP request gets one precise approval after media source is included", async (t) => {
  const f = setup(t),
    ctx = context(f.runtime);
  f.runtime.voices = new VoiceStore(path.join(f.root, "voices"));
  const audio = await f.runtime.voices.put(
    ctx.agentId,
    wav(),
    f.runtime.agent(ctx.agentId).voice,
    { conversation: "private:30000" },
  );
  const args = {
    serverId: "fixture",
    tool: "transcribe",
    arguments: { language: "zh" },
    audioInput: {
      audioId: audio.id,
      dataArgument: "audio",
      mimeArgument: "mime",
    },
  };
  await assert.rejects(
    f.runtime.callTool(ctx, "external_tool", args),
    /EXTERNAL_CALL_BLOCKED/,
  );
  const pending = f.runtime.status().disclosureRequests[0];
  assert(pending.records.includes("audio:" + audio.id));
  f.runtime.grant(ctx.token, pending.records, pending.requestId);
  await f.runtime.callTool(ctx, "external_tool", args);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].args.audio, wav().toString("base64"));
  assert.equal(ctx.grants.size, 0);
  await assert.rejects(
    f.runtime.callTool(ctx, "external_tool", { ...args, tool: "publish" }),
    /EXTERNAL_CALL_BLOCKED/,
  );
});

test("new human input during an in-flight send refills once, queued sends still share the durable bound", async (t) => {
  const f = setup(t),
    ctx = context(f.runtime),
    transport = f.runtime.transports.get("qq-0");
  f.runtime.agent(ctx.agentId).maxConsecutiveSends = 1;
  let finish;
  transport.send = () =>
    new Promise((resolve) => {
      finish = () => resolve({ messageId: "fixture-delivery" });
    });
  const first = send(f, ctx, "inflight");
  await incoming(f, ctx);
  const second = send(f, ctx, "queued");
  finish();
  await first;
  await new Promise((resolve) => setImmediate(resolve));
  finish();
  await second;
  await assert.rejects(send(f, ctx, "third"), /REPLY_BURST_LIMIT/);
  assert.equal(
    f.store.bind(ctx.agentId).state(ctx.conversation).replyBatchSends,
    1,
  );
});

test("mixed public/private DNS answers fail before transport and URLs remain pinned at fetch", async (t) => {
  t.mock.method(dns.promises, "lookup", async () => [
    { address: "93.184.216.34", family: 4 },
    { address: "10.0.0.2", family: 4 },
  ]);
  // Fresh module captures the synthetic resolver, without ever resolving an actual host.
  const isolated = await import(
    "../vendor/social-reader/safe-fetch.js?synthetic-dns-policy"
  );
  await assert.rejects(
    isolated.validateFetchUrl("https://fixture.invalid/"),
    /内网/,
  );
});

test("backend run closures share the durable policy through both prompt protocols", async (t) => {
  for (const type of ["codex", "dsh"]) {
    const f = setup(t, type);
    let runs = 0,
      sends = 0;
    f.runtime.backends.set("agent-0", {
      run: async ({ callTool, prompt }) => {
        runs++;
        assert.equal(prompt.includes("context="), type === "dsh");
        const ctx = [...f.runtime.running.values()][0];
        for (let n = 0; n < 10; n++) {
          const row = await incoming(
            f,
            ctx,
            "backend question " + n,
            {},
            false,
          );
          await callTool("conversation_read", { afterSeq: row.seq - 1 });
          await callTool("qq_send", {
            requestId: type + ":" + n,
            text: "backend answer",
          });
          sends++;
        }
      },
    });
    await f.runtime.wake("agent-0", "group:20000");
    assert.equal(f.runtime.faults.get("agent-0"), undefined);
    assert.equal(runs, 1);
    assert.equal(sends, 10);
  }
});

test("authorized public redirects retain provenance but every hop still rejects credentials and private targets", async (t) => {
  const f = setup(t),
    ctx = context(f.runtime);
  delete f.runtime.fetchPublicPage;
  f.runtime.agent(ctx.agentId).network.publicUrls = ["http://93.184.216.34/"];
  ctx.privateRead.add("private-source");
  let target = "http://93.184.216.35/public",
    requests = 0;
  t.mock.method(http, "request", (options, callback) => {
    requests++;
    const req = new EventEmitter();
    req.destroy = () => {};
    req.end = () => {
      const res = new EventEmitter();
      res.destroy = () => {};
      res.complete = true;
      res.statusCode = options.hostname === "93.184.216.34" ? 302 : 200;
      res.headers = { location: target };
      callback(res);
      if (res.statusCode === 200) {
        res.emit("data", Buffer.from("public page"));
        res.emit("end");
      }
    };
    return req;
  });
  await f.runtime.callTool(ctx, "web_fetch", { url: "http://93.184.216.34/" });
  assert.equal(requests, 2);
  target = "http://127.0.0.1/";
  await assert.rejects(
    f.runtime.callTool(ctx, "web_fetch", { url: "http://93.184.216.34/" }),
    /内网/,
  );
  assert.equal(requests, 3);
  target = "http://93.184.216.35/?access_token=synthetic";
  await assert.rejects(
    f.runtime.callTool(ctx, "web_fetch", { url: "http://93.184.216.34/" }),
    /CREDENTIALS/,
  );
  assert.equal(requests, 4);
});

test("scheduled turn switches to human reply budget after a verified new input", async (t) => {
  const f = setup(t),
    ctx = context(f.runtime);
  ctx.scheduleRunId = "synthetic-reserved-run";
  const mem = f.store.bind(ctx.agentId);
  mem.setState(ctx.conversation, {
    scheduleReplyCounts: { [ctx.scheduleRunId]: 8 },
  });
  await assert.rejects(send(f, ctx, "spent-schedule"), /REPLY_BURST_LIMIT/);
  for (let n = 0; n < 10; n++) {
    await incoming(f, ctx);
    await send(f, ctx, "human-after-schedule-" + n);
  }
  assert.equal(ctx.scheduleRunId, null);
  assert.equal(
    mem.state(ctx.conversation).scheduleReplyCounts["synthetic-reserved-run"],
    8,
  );
});
