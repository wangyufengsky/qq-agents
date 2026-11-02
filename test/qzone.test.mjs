import test from "node:test";
import assert from "node:assert/strict";
import { config, fixture, context } from "./helpers.mjs";
import { validateConfig } from "../src/core/config.mjs";
import { OneBot, qzoneToken } from "../src/transport/onebot.mjs";

const OWNER = "private:30000";

function setup(t, actions = { qzone: true }) {
  const cfg = config(2);
  cfg.agents[0].ownerIds = ["30000"];
  cfg.agents[0].allow.users.push("30001");
  cfg.agents[0].behavior.actions = actions;
  cfg.agents[0].tools.push("qzone_read", "qzone_post");
  const f = fixture(t, { cfg: validateConfig(cfg) });
  const calls = [];
  const transport = f.runtime.transports.get("qq-0");
  transport.qzoneRecent = async ({ limit }) => {
    if (transport.failure) throw transport.failure;
    return [{ id: "t1", text: "旧说说", limit }];
  };
  transport.qzonePost = async (post) => {
    calls.push(post);
    if (transport.failure) throw transport.failure;
    return { confirmed: true };
  };
  return {
    ...f,
    calls,
    transport,
    ctx: context(f.runtime, "agent-0", OWNER),
    mem: f.store.bind("agent-0"),
  };
}
const post = (f, args, ctx = f.ctx) =>
  f.runtime.callTool(ctx, "qzone_post", args);

test("qzone tools default off and only appear in an owner's private chat", async (t) => {
  const cfg = config(1);
  cfg.agents[0].ownerIds = ["30000"];
  cfg.agents[0].tools.push("qzone_read", "qzone_post");
  const { runtime } = fixture(t, { cfg: validateConfig(cfg) }),
    a = runtime.agent("agent-0"),
    ctx = context(runtime, "agent-0", OWNER);
  assert.equal(a.behavior.actions.qzone, false);
  assert.equal(a.behavior.actions.qzoneMaxPerDay, 2);
  assert(!runtime.toolsFor(a, OWNER).includes("qzone_post"));
  await assert.rejects(
    runtime.callTool(ctx, "qzone_post", { requestId: "off", content: "嗨" }),
    /TOOL_DISABLED/,
  );
  a.behavior.actions.qzone = true;
  assert(runtime.toolsFor(a, OWNER).includes("qzone_post"));
  assert(runtime.toolsFor(a, OWNER).includes("qzone_read"));
  for (const elsewhere of [
    "group:20000",
    "private:30001",
    "@subject",
    "@work:x",
  ])
    assert(!runtime.toolsFor(a, elsewhere).includes("qzone_post"));
});

test("non-owner chats cannot post even with a stale catalogue", async (t) => {
  const f = setup(t);
  for (const conversation of ["group:20000", "private:30001"]) {
    const ctx = context(f.runtime, "agent-0", conversation);
    await assert.rejects(
      post(f, { requestId: "x:" + conversation, content: "嗨" }, ctx),
      /TOOL_DISABLED/,
    );
  }
  assert.equal(f.calls.length, 0);
});

test("schema keeps line breaks but rejects control characters and caller identity", async (t) => {
  const f = setup(t);
  for (const args of [
    { requestId: "a", content: "   " },
    { requestId: "a", content: "a\u0007b" },
    { requestId: "a", content: "abc‮def" },
    { requestId: "a", content: "x".repeat(1001) },
    { requestId: "a", content: "嗨", agentId: "agent-1" },
  ])
    await assert.rejects(post(f, args));
  assert.equal(f.calls.length, 0);
  const ok = await post(f, { requestId: "multi", content: "第一行\n第二行" });
  assert.equal(ok.status, "sent");
  assert.deepEqual(f.calls, [{ content: "第一行\n第二行" }]);
});

test("posts once per requestId through the action ledger", async (t) => {
  const f = setup(t);
  const first = await post(f, { requestId: "p1", content: "今天天气不错" });
  assert.equal(first.status, "sent");
  assert.equal(first.actionConfirmed, true);
  const again = await post(f, { requestId: "p1", content: "今天天气不错" });
  assert.equal(again.duplicate, true);
  assert.equal(f.calls.length, 1);
  const confirmed = f.mem.db
    .prepare(
      "SELECT body, payload FROM events WHERE kind='action.confirmed' AND agent_id='agent-0'",
    )
    .all();
  assert.equal(confirmed.length, 1);
  assert.equal(confirmed[0].body, "[发说说] 今天天气不错");
  assert.equal(JSON.parse(confirmed[0].payload).actionKind, "qzone");
  // A post is an action: it neither uses nor restores the text reply budget.
  assert.equal(f.ctx.sendCount, 0);
});

test("reads recent posts and maps failures to safe codes", async (t) => {
  const f = setup(t);
  const read = await f.runtime.callTool(f.ctx, "qzone_read", { limit: 3 });
  assert.equal(read.accountId, "10000");
  assert.deepEqual(read.posts, [{ id: "t1", text: "旧说说", limit: 3 }]);
  f.transport.failure = Object.assign(Error("ONEBOT_REJECTED"), {
    reason: "QZONE_LOGIN_REQUIRED",
  });
  await assert.rejects(
    f.runtime.callTool(f.ctx, "qzone_read", {}),
    /QZONE_LOGIN_REQUIRED/,
  );
  f.transport.failure = Error("raw p_skey=secret page");
  await assert.rejects(f.runtime.callTool(f.ctx, "qzone_read", {}), (e) => {
    assert.equal(e.message, "QZONE_READ_FAILED");
    assert(!String(e.cause ?? "").includes("secret"));
    return true;
  });
});

test("credentials, proactive intents, scheduled runs and protected work cannot post", async (t) => {
  const f = setup(t);
  await assert.rejects(
    post(f, { requestId: "secret", content: "sk-" + "a".repeat(40) }),
    /SENSITIVE_OUTPUT_BLOCKED/,
  );
  for (const extra of [
    { activeIntentId: "intent-1" },
    { intentOnly: true },
    { scheduleRunId: "run-1" },
  ]) {
    const ctx = Object.assign(context(f.runtime, "agent-0", OWNER), extra);
    await assert.rejects(
      post(
        f,
        { requestId: "ctx:" + Object.keys(extra)[0], content: "甲" },
        ctx,
      ),
      /QZONE_ORDINARY_TURN_REQUIRED/,
    );
  }
  f.runtime.protectedWork = { context: () => ({ id: "w" }) };
  await assert.rejects(
    post(f, { requestId: "protected", content: "甲" }),
    /PROTECTED_WORK_OUTBOUND_DENIED/,
  );
  assert.equal(f.calls.length, 0);
});

test("recollections from other chats need a disclosure grant before posting", async (t) => {
  const f = setup(t);
  let options;
  f.runtime.assertDisclosure = (_ctx, o) => {
    options = o;
    throw Error("PRIVATE_RECOLLECTION_EXTERNAL_CALL_BLOCKED");
  };
  await assert.rejects(
    post(f, { requestId: "leak", content: "别人的事" }),
    /PRIVATE_RECOLLECTION_EXTERNAL_CALL_BLOCKED/,
  );
  assert.deepEqual(options, { external: true });
  assert.equal(f.calls.length, 0);
});

test("daily budget counts failed attempts and login problems keep their code", async (t) => {
  const f = setup(t, { qzone: true, qzoneMaxPerDay: 2 });
  await post(f, { requestId: "d1", content: "一" });
  f.transport.failure = Object.assign(Error("ONEBOT_REJECTED"), {
    reason: "QZONE_LOGIN_REQUIRED",
  });
  await assert.rejects(
    post(f, { requestId: "d2", content: "二" }),
    /QZONE_LOGIN_REQUIRED/,
  );
  f.transport.failure = null;
  await assert.rejects(
    post(f, { requestId: "d3", content: "三" }),
    /QZONE_RATE_LIMITED/,
  );
  assert.equal(f.calls.length, 2);
});

test("an unknown post blocks new requests until it is reconciled", async (t) => {
  const f = setup(t);
  f.transport.failure = Error("QZONE_HTTP_ERROR");
  await assert.rejects(
    post(f, { requestId: "u1", content: "可能已发" }),
    /DELIVERY_UNKNOWN/,
  );
  f.transport.failure = null;
  await assert.rejects(
    post(f, { requestId: "u2", content: "再发一次" }),
    /QZONE_POST_UNCONFIRMED/,
  );
  await assert.rejects(
    post(f, { requestId: "u1", content: "可能已发" }),
    /DELIVERY_ALREADY_ATTEMPTED_UNKNOWN/,
  );
  assert.equal(f.calls.length, 1);
});

test("gateway without cookie support reports QZONE_UNSUPPORTED", async (t) => {
  const f = setup(t);
  f.transport.failure = Object.assign(Error("ONEBOT_REJECTED"), {
    reason: "ACTION_UNSUPPORTED",
  });
  await assert.rejects(
    post(f, { requestId: "unsupported", content: "甲" }),
    /QZONE_UNSUPPORTED/,
  );
  delete f.transport.qzonePost;
  await assert.rejects(
    post(f, { requestId: "missing", content: "甲" }),
    /QZONE_UNSUPPORTED/,
  );
});

test("qzoneToken matches the QQ Zone page hash", () => {
  assert.equal(qzoneToken(""), 5381);
  assert.equal(qzoneToken("a"), 177670);
  assert.equal(qzoneToken("abc"), 193485963);
});

function qzoneBot(replies) {
  const requests = [];
  const bot = new OneBot(
    { accountId: "10000", httpUrl: "http://gateway" },
    {
      fetchImpl: async (url, init) => {
        const target = String(url);
        requests.push({ url: target, init });
        const reply = replies.shift();
        if (reply instanceof Error) throw reply;
        if (target.startsWith("http://gateway/"))
          return new Response(JSON.stringify(reply));
        return typeof reply === "string"
          ? new Response(reply)
          : new Response(JSON.stringify(reply.body), {
              status: reply.status ?? 200,
            });
      },
    },
  );
  return { bot, requests };
}
const cookies = (value) => ({
  status: "ok",
  retcode: 0,
  data: { cookies: value },
});

test("OneBot publishes through the QQ Zone web endpoint with gateway cookies", async () => {
  const { bot, requests } = qzoneBot([
    cookies("uin=o0010000; skey=@s; p_uin=o0010000; p_skey=abc"),
    { body: { code: 0, subcode: 0, tid: "abcd", message: "" } },
  ]);
  assert.deepEqual(await bot.qzonePost({ content: "你好\n世界" }), {
    confirmed: true,
  });
  assert.equal(requests[0].url, "http://gateway/get_cookies");
  assert.deepEqual(JSON.parse(requests[0].init.body), {
    domain: "user.qzone.qq.com",
  });
  const publish = requests[1];
  assert.match(
    publish.url,
    /^https:\/\/user\.qzone\.qq\.com\/proxy\/domain\/taotao\.qzone\.qq\.com\/cgi-bin\/emotion_cgi_publish_v6\?g_tk=193485963$/,
  );
  assert.equal(publish.init.method, "POST");
  assert.equal(publish.init.redirect, "error");
  assert.match(publish.init.headers.cookie, /p_skey=abc/);
  const form = new URLSearchParams(publish.init.body);
  assert.equal(form.get("con"), "你好\n世界");
  assert.equal(form.get("hostuin"), "10000");
  assert.equal(form.get("ugc_right"), "1");
  assert.equal(form.get("format"), "json");
});

test("OneBot classifies QQ Zone replies without keeping raw text", async () => {
  // JSONP-wrapped success without a tid cannot be confirmed.
  let { bot } = qzoneBot([
    cookies("uin=o0010000; p_skey=abc"),
    '_Callback({"code":0,"subcode":0});',
  ]);
  assert.deepEqual(await bot.qzonePost({ content: "甲" }), {
    confirmed: false,
  });
  ({ bot } = qzoneBot([
    cookies("uin=o0010000; p_skey=abc"),
    { body: { code: -3000, message: "请先登录 p_skey=abc" } },
  ]));
  await assert.rejects(bot.qzonePost({ content: "甲" }), (e) => {
    assert.equal(e.message, "ONEBOT_REJECTED");
    assert.equal(e.reason, "QZONE_LOGIN_REQUIRED");
    assert(!JSON.stringify(e).includes("abc"));
    return true;
  });
  ({ bot } = qzoneBot([
    cookies("uin=o0010000; p_skey=abc"),
    { body: { code: -10000, message: "操作过于频繁" } },
  ]));
  await assert.rejects(bot.qzonePost({ content: "甲" }), (e) => {
    assert.equal(e.reason, "QZONE_REJECTED");
    return true;
  });
  // Unreadable replies, HTTP errors and replies without a stated status stay
  // unknown: the post may be live.
  for (const reply of [
    "<html>verify</html>",
    { status: 502, body: {} },
    { body: {} },
    { body: { code: "", tid: "x" } },
    { body: { code: null, message: "x" } },
    { body: { code: 0, subcode: "?", tid: "x" } },
  ]) {
    ({ bot } = qzoneBot([cookies("uin=o0010000; p_skey=abc"), reply]));
    await assert.rejects(bot.qzonePost({ content: "甲" }), (e) => {
      assert.notEqual(e.message, "ONEBOT_REJECTED");
      return true;
    });
  }
});

test("OneBot refuses missing, foreign or unsupported QQ Zone cookies before publishing", async () => {
  let { bot, requests } = qzoneBot([cookies("uin=o0010000")]);
  await assert.rejects(bot.qzonePost({ content: "甲" }), (e) => {
    assert.equal(e.reason, "QZONE_LOGIN_REQUIRED");
    return true;
  });
  assert.equal(requests.length, 1);
  ({ bot, requests } = qzoneBot([cookies("uin=o0099999; p_skey=abc")]));
  await assert.rejects(bot.qzonePost({ content: "甲" }), (e) => {
    assert.equal(e.message, "ONEBOT_REJECTED");
    assert.equal(e.reason, "QQ_ACCOUNT_MISMATCH");
    return true;
  });
  assert.equal(requests.length, 1);
  ({ bot } = qzoneBot([
    { status: "failed", retcode: 1404, message: "不支持的 API" },
  ]));
  await assert.rejects(bot.qzonePost({ content: "甲" }), (e) => {
    assert.equal(e.message, "ONEBOT_REJECTED");
    assert.equal(e.reason, "ACTION_UNSUPPORTED");
    return true;
  });
});

test("OneBot reads recent posts into a bounded summary", async () => {
  const { bot, requests } = qzoneBot([
    cookies("uin=o0010000; p_skey=abc"),
    {
      body: {
        code: 0,
        msglist: [
          {
            tid: "t1",
            content: "早上好",
            created_time: 1700000000,
            cmtnum: 2,
            pic: [{}, {}],
            commentlist: [{ content: "别人的评论" }],
          },
        ],
      },
    },
  ]);
  assert.deepEqual(await bot.qzoneRecent({ limit: 5 }), [
    {
      id: "t1",
      text: "早上好",
      createdAt: "2023-11-14T22:13:20.000Z",
      comments: 2,
      images: 2,
    },
  ]);
  const url = new URL(requests[1].url);
  assert.equal(url.pathname.endsWith("emotion_cgi_msglist_v6"), true);
  assert.equal(url.searchParams.get("num"), "5");
  assert.equal(url.searchParams.get("g_tk"), "193485963");
});
