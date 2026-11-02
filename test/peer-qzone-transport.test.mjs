import test from "node:test";
import assert from "node:assert/strict";
import { OneBot } from "../src/transport/onebot.mjs";

const cookie = "uin=o0010000; p_uin=o0010000; p_skey=fixture-cookie-secret";
const post = {
  tid: "fixture-post",
  uin: "30000",
  content: "来源文本",
  created_time: 1700000000,
  cmtnum: 2,
  pic: [{ url: "https://example.invalid/private-image" }],
  commentlist: [{ content: "不返回评论" }],
};
function setup({
  cookies = cookie,
  body = { code: 0, uin: "30000", msglist: [post] },
  status = 200,
  web,
  cookieResponse,
} = {}) {
  const requests = [];
  const bot = new OneBot(
    { accountId: "10000", httpUrl: "http://gateway.invalid" },
    {
      fetchImpl: async (url, init) => {
        requests.push({ url: String(url), init });
        if (String(url).startsWith("http://gateway.invalid/")) {
          if (cookieResponse) return cookieResponse(url, init);
          return new Response(
            JSON.stringify({ status: "ok", retcode: 0, data: { cookies } }),
          );
        }
        if (web) return web(url, init);
        return new Response(
          typeof body === "string" ? body : JSON.stringify(body),
          { status },
        );
      },
    },
  );
  return {
    bot,
    requests,
    read: (args = {}) =>
      bot.peerQzoneRecent({ userId: "30000", limit: 5, ...args }),
  };
}
const safeReason = (reason) => (error) => {
  assert.equal(error.message, "ONEBOT_REJECTED");
  assert.equal(error.reason, reason);
  assert.equal(error.cause, undefined);
  assert(!JSON.stringify(error).includes("fixture-cookie-secret"));
  assert(!JSON.stringify(error).includes("g_tk"));
  return true;
};

test("peer Qzone reads only fixed target endpoint with private comments disabled and bounded fields", async () => {
  const f = setup();
  assert.deepEqual(await f.read(), [
    {
      id: "fixture-post",
      text: "来源文本",
      createdAt: "2023-11-14T22:13:20.000Z",
      comments: 2,
      images: 1,
    },
  ]);
  assert.equal(f.requests.length, 2);
  const request = f.requests[1],
    url = new URL(request.url);
  assert.equal(url.origin, "https://user.qzone.qq.com");
  assert.equal(
    url.pathname,
    "/proxy/domain/taotao.qq.com/cgi-bin/emotion_cgi_msglist_v6",
  );
  assert.equal(url.searchParams.get("uin"), "30000");
  assert.equal(url.searchParams.get("replynum"), "0");
  assert.equal(url.searchParams.get("need_private_comment"), "0");
  assert.equal(url.searchParams.get("num"), "5");
  assert.equal(request.init.redirect, "error");
  assert.equal(request.init.headers.referer, "https://user.qzone.qq.com/30000");
});

test("explicit empty successful list differs from absent or malformed list", async () => {
  assert.deepEqual(await setup({ body: { code: 0, msglist: [] } }).read(), []);
  for (const body of [
    { code: 0 },
    { code: 0, msglist: null },
    { code: 0, msglist: {} },
    { code: 0, msglist: "[]" },
  ])
    await assert.rejects(
      setup({ body }).read(),
      safeReason("QZONE_RESPONSE_UNREADABLE"),
    );
});

test("strict cookie account requires an identity and refuses conflicts before web request", async () => {
  for (const [cookies, reason] of [
    ["p_skey=fixture-cookie-secret", "QZONE_LOGIN_REQUIRED"],
    ["uin=o0010000", "QZONE_LOGIN_REQUIRED"],
    ["uin=o0010001; p_skey=fixture-cookie-secret", "QQ_ACCOUNT_MISMATCH"],
    [
      "uin=o0010000; p_uin=o0010001; p_skey=fixture-cookie-secret",
      "QQ_ACCOUNT_MISMATCH",
    ],
    [
      "uin=o0010000; uin=o0010001; p_skey=fixture-cookie-secret",
      "QQ_ACCOUNT_MISMATCH",
    ],
  ]) {
    const f = setup({ cookies });
    await assert.rejects(f.read(), safeReason(reason));
    assert.equal(f.requests.length, 1);
  }
});

test("HTTP authentication denial and throttling retain separate sanitized reasons", async () => {
  for (const [status, reason] of [
    [401, "QZONE_LOGIN_REQUIRED"],
    [403, "QZONE_ACCESS_DENIED"],
    [429, "QZONE_RATE_LIMITED"],
    [500, "QZONE_READ_FAILED"],
  ])
    await assert.rejects(
      setup({ status, body: "fixture-cookie-secret" }).read(),
      safeReason(reason),
    );
});

test("explicit body failures and subcode failures cannot become empty success", async () => {
  for (const [body, reason] of [
    [
      { code: 1, message: "请先登录 fixture-cookie-secret" },
      "QZONE_LOGIN_REQUIRED",
    ],
    [
      { code: 1, message: "没有访问权限 fixture-cookie-secret" },
      "QZONE_ACCESS_DENIED",
    ],
    [
      { code: 1, message: "操作过于频繁 fixture-cookie-secret" },
      "QZONE_RATE_LIMITED",
    ],
    [{ code: 1, message: "unknown fixture-cookie-secret" }, "QZONE_REJECTED"],
    [{ code: 0, subcode: 1, msglist: [] }, "QZONE_REJECTED"],
  ])
    await assert.rejects(setup({ body }).read(), safeReason(reason));
});

test("malformed JSON HTML and unstated statuses stay unreadable", async () => {
  for (const body of [
    "<html>fixture-cookie-secret</html>",
    "{",
    [],
    {},
    { code: null, msglist: [] },
    { code: "", msglist: [] },
    { code: 0, subcode: "?", msglist: [] },
  ])
    await assert.rejects(
      setup({ body }).read(),
      safeReason("QZONE_RESPONSE_UNREADABLE"),
    );
  await assert.rejects(
    setup({ web: async () => new Response(null, { status: 204 }) }).read(),
    safeReason("QZONE_RESPONSE_UNREADABLE"),
  );
  assert.deepEqual(
    await setup({ body: '_Callback({"code":0,"msglist":[]});' }).read(),
    [],
  );
});

test("all response authors including out-of-slice rows must match target", async () => {
  for (const body of [
    { code: 0, uin: "30001", msglist: [post] },
    { code: 0, uin: null, msglist: [] },
    { code: 0, msglist: [{ ...post, uin: "30001" }] },
    { code: 0, msglist: [post, { ...post, uin: "30001" }] },
  ])
    await assert.rejects(
      setup({ body }).read({ limit: 1 }),
      safeReason("QZONE_TARGET_MISMATCH"),
    );
});

test("malformed post identity and text fields cannot mint source records", async () => {
  for (const entry of [
    null,
    [],
    "text",
    {},
    { ...post, tid: null },
    { ...post, tid: "" },
    { ...post, content: null },
    { ...post, content: { text: "nested" } },
  ])
    await assert.rejects(
      setup({ body: { code: 0, msglist: [entry] } }).read(),
      safeReason("QZONE_RESPONSE_UNREADABLE"),
    );
});

test("unsafe counts and invalid timestamps are bounded without exposing extra content", async () => {
  const f = setup({
    body: {
      code: "0",
      subcode: "0",
      msglist: [
        {
          ...post,
          tid: "x".repeat(300),
          content: "字".repeat(1200),
          cmtnum: -1,
          created_time: 1e100,
        },
        { ...post, cmtnum: 1.2, created_time: "1700000000" },
        { ...post, cmtnum: Number.MAX_SAFE_INTEGER + 1 },
      ],
    },
  });
  const result = await f.read();
  assert.equal(result[0].id.length, 200);
  assert.equal(result[0].text.length, 1000);
  assert.equal(result[0].createdAt, null);
  assert.equal(result[1].createdAt, null);
  assert(result.every((row) => row.comments === 0));
  assert(!JSON.stringify(result).includes("private-image"));
  assert(!JSON.stringify(result).includes("commentlist"));
});

test("invalid target is rejected before cookies or external reads", async () => {
  for (const userId of [
    "../30000",
    "30000&uin=30001",
    "https://example.invalid",
    "0",
  ]) {
    const f = setup();
    await assert.rejects(
      f.read({ userId }),
      safeReason("QZONE_TARGET_MISMATCH"),
    );
    assert.equal(f.requests.length, 0);
  }
});

test("cancel before call and during cookie acquisition cannot start web read", async () => {
  const controller = new AbortController();
  controller.abort();
  const first = setup();
  await assert.rejects(
    first.read({ signal: controller.signal }),
    /^Error: ABORTED$/,
  );
  assert.equal(first.requests.length, 0);
  const pending = new AbortController();
  const second = setup({
    cookieResponse: async () => {
      pending.abort();
      return new Response(
        JSON.stringify({ status: "ok", retcode: 0, data: { cookies: cookie } }),
      );
    },
  });
  await assert.rejects(
    second.read({ signal: pending.signal }),
    /^Error: ABORTED$/,
  );
  assert.equal(second.requests.length, 1);
});

test("revocation callback runs after cookies and before issuing a web request", async () => {
  const f = setup();
  let checked = false;
  await assert.rejects(
    f.read({
      validate: () => {
        checked = true;
        assert.equal(f.requests.length, 1);
        throw Error("AGENT_PAUSED_OR_EXPIRED");
      },
    }),
    safeReason("QZONE_READ_FAILED"),
  );
  assert(checked);
  assert.equal(f.requests.length, 1);
});

test("network errors and oversized or cancelled web responses keep no raw cause", async () => {
  await assert.rejects(
    setup({
      web: async () => {
        throw Error(
          "fixture-cookie-secret https://example.invalid/?g_tk=secret",
        );
      },
    }).read(),
    safeReason("QZONE_READ_FAILED"),
  );
  await assert.rejects(
    setup({ body: "x".repeat(256 * 1024 + 1) }).read(),
    safeReason("QZONE_READ_FAILED"),
  );
  const controller = new AbortController();
  const f = setup({
    web: async () => {
      controller.abort();
      return new Response(JSON.stringify({ code: 0, msglist: [] }));
    },
  });
  await assert.rejects(
    f.read({ signal: controller.signal }),
    /^Error: ABORTED$/,
  );
});

test("unsupported cookie action and unrecognized internal reasons expose only allowlisted codes", async () => {
  const unsupported = setup({
    cookieResponse: async () =>
      new Response(
        JSON.stringify({
          status: "failed",
          retcode: 1404,
          message: "unsupported fixture-cookie-secret",
        }),
      ),
  });
  await assert.rejects(unsupported.read(), safeReason("ACTION_UNSUPPORTED"));
  assert.equal(unsupported.requests.length, 1);
  const unknown = setup({
    web: async () => {
      throw Object.assign(Error("fixture-cookie-secret"), {
        reason: "fixture-cookie-secret",
      });
    },
  });
  await assert.rejects(unknown.read(), safeReason("QZONE_READ_FAILED"));
});

test("a cookie gateway outage is a read failure rather than proof of expired QQ login", async () => {
  const f = setup({
    cookieResponse: async () => {
      throw Error("fixture-cookie-secret network failure");
    },
  });
  await assert.rejects(f.read(), safeReason("QZONE_READ_FAILED"));
  assert.equal(f.requests.length, 1);
});
