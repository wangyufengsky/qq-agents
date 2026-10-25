import test from "node:test";
import assert from "node:assert/strict";
import { parseCards } from "../src/apps/cards.mjs";
import { contentIdentity, resolveAppUrl } from "../src/apps/urls.mjs";
import { appsPolicySchema, inAppHours } from "../src/apps/policy.mjs";
const card = (data) => [{ type: "json", data: { data: JSON.stringify(data) } }];
test("QQ news, miniapp and XML cards preserve summary without claiming body was read", () => {
  const news = parseCards(
    card({
      app: "com.tencent.structmsg",
      meta: {
        news: {
          title: "测试文章",
          desc: "摘要",
          jumpUrl: "https://www.zhihu.com/question/123/answer/456",
          preview: "https://pic1.zhimg.com/sample.jpg",
        },
      },
    }),
  )[0];
  assert.equal(news.platform, "zhihu");
  assert.equal(news.readingScope, "card-summary");
  assert.equal(news.availability, "card-summary-only");
  const mini = parseCards(
    card({
      app: "com.tencent.miniapp_01",
      meta: {
        detail_1: {
          appid: "fixture",
          title: "小程序",
          desc: "只在 App 内",
          pagepath: "pages/index",
        },
      },
    }),
  )[0];
  assert.equal(mini.availability, "app-only");
  assert.equal(mini.url, null);
  const xml = parseCards([
    {
      type: "xml",
      data: {
        data: '<msg url="https://www.bilibili.com/video/BV1234567890"><item><title><![CDATA[示例 & 标题]]></title><summary>仅视频简介</summary><picture cover="https://i0.hdslb.com/fixture.jpg" /></item></msg>',
      },
    },
  ])[0];
  assert.equal(xml.platform, "bilibili");
  assert.equal(xml.title, "示例 & 标题");
  assert.equal(xml.summary, "仅视频简介");
});
test("malformed, deep, oversized and entity XML cards fail closed", () => {
  for (const data of [
    "<msg><title>bad</msg>",
    '<!DOCTYPE msg [<!ENTITY x SYSTEM "file:///etc/passwd">]><msg>&x;</msg>',
    "<x>".repeat(14) + "</x>".repeat(14),
    "x".repeat(65537),
  ])
    assert.equal(
      parseCards([{ type: "xml", data: { data } }])[0].availability,
      "invalid-card",
    );
  let v = {};
  for (let i = 0; i < 14; i++) v = { nested: v };
  assert.equal(parseCards(card(v))[0].error, "CARD_STRUCTURE_LIMIT");
  const bad = parseCards([{ type: "json", data: { data: "{bad" } }])[0];
  assert.equal(bad.availability, "invalid-card");
});
test("credential URLs are never returned and content identity ignores tracking only", () => {
  const c = parseCards(
    card({
      url: "https://www.zhihu.com/question/123?access_token=secret",
      title: "bad",
    }),
  )[0];
  assert.equal(c.url, null);
  assert.equal(
    contentIdentity(
      "https://www.bilibili.com/video/BV1234567890?spm_id_from=abc",
    ).key,
    "bilibili:BV1234567890",
  );
  assert.equal(
    contentIdentity(
      "https://www.xiaohongshu.com/explore/1234567890abcdef12345678?xsec_token=content-proof&tracking=x",
    ).url,
    "https://www.xiaohongshu.com/explore/1234567890abcdef12345678?xsec_token=content-proof",
  );
  assert.throws(() =>
    contentIdentity("https://www.bilibili.com.evil.example/video/BV1234567890"),
  );
});
test("short links validate DNS on each hop and refuse private or credential redirects", async () => {
  const hops = [],
    validate = async (raw) => {
      hops.push(raw);
      if (raw.includes("127.0.0.1")) throw Error("private");
      return { url: new URL(raw), addresses: ["93.184.216.34"] };
    };
  const result = await resolveAppUrl("https://b23.tv/fixture", {
    validate,
    request: async (u) =>
      u.hostname === "b23.tv"
        ? { redirect: "https://www.bilibili.com/video/BV1234567890" }
        : { status: 200 },
  });
  assert.equal(result.id, "BV1234567890");
  assert.equal(hops.length, 2);
  for (const redirect of [
    "http://127.0.0.1/secret",
    "https://www.zhihu.com/question/123?cookie=secret",
    "https://example.com/post",
  ])
    await assert.rejects(
      resolveAppUrl("https://b23.tv/fixture", {
        validate,
        request: async () => ({ redirect }),
      }),
    );
  await assert.rejects(
    resolveAppUrl("https://b23.tv/fixture", {
      validate,
      request: async () => ({ redirect: "https://b23.tv/fixture" }),
    }),
    /LOOP/,
  );
  await assert.rejects(
    resolveAppUrl("https://www.zhihu.com/question/123", {
      validate: async () => {
        throw Error("mixed DNS private");
      },
      request: () => {
        throw Error("must not request");
      },
    }),
    /DENIED/,
  );
});
test("config windows support daytime overnight and all-day", () => {
  const p = appsPolicySchema.parse({
    hours: { start: "22:00", end: "06:00", timezone: "UTC" },
  });
  assert(inAppHours(p, new Date("2026-01-01T23:00:00Z")));
  assert(!inAppHours(p, new Date("2026-01-01T12:00:00Z")));
  p.hours.end = "22:00";
  assert(inAppHours(p, new Date("2026-01-01T12:00:00Z")));
});
test("plain platform and short links remain owned card-summary references", () => {
  const rows = parseCards([
    {
      type: "text",
      data: {
        text: "看看 https://b23.tv/abc。还有 https://example.org/not-platform",
      },
    },
  ]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].url, "https://b23.tv/abc");
  assert.equal(rows[0].readingScope, "card-summary");
});
