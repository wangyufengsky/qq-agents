import test from "node:test";
import assert from "node:assert/strict";
import { sign } from "../vendor/heybox/signature.mjs";
import { heyboxRead } from "../src/apps/heybox.mjs";
import { AppAdapter } from "../src/apps/adapter.mjs";
test("Heybox signature matches upstream web-client compatibility vectors", () => {
  assert.equal(
    sign(
      "/bbs/app/api/general/search/v1",
      1700000000,
      "0123456789ABCDEF0123456789ABCDEF",
    ),
    "RM29210",
  );
  assert.equal(
    sign(
      "bbs/app/api/general/search/v1/",
      1784911948,
      "ABCDEF0123456789ABCDEF0123456789",
    ),
    "AMQ2C30",
  );
});
test("Heybox never returns cookie fields and image-only posts stay metadata", async () => {
  const page = {
    getCookies: async () => [
      { name: "user_pkey", value: "fixture-secret", domain: ".xiaoheihe.cn" },
      { name: "pkey", value: "other-platform", domain: ".example.org" },
      { name: "unrelated", value: "ignored" },
    ],
  };
  let called;
  const value = await heyboxRead(
    page,
    { operation: "read", url: "https://www.xiaoheihe.cn/app/bbs/link/123" },
    {
      request: async (path, params, cookie) => {
        called = { path, params, cookie };
        return {
          link: {
            linkid: 123,
            title: "图片帖子",
            text: '[{"type":"img","url":"https://example.org/a.png"}]',
            user_pkey: "fixture-secret",
          },
        };
      },
    },
  );
  assert.equal(called.cookie, "user_pkey=fixture-secret");
  assert(!JSON.stringify(value).includes("fixture-secret"));
  assert.equal(value.coverage, "post-metadata");
});
test("capability probes distinguish failed reads and unverified credentials", async () => {
  const adapter = new AppAdapter({
    run: async (job) => {
      if (job.operation === "status")
        return { loggedIn: null, status: "credential-present-unverified" };
      throw Error("APP_LOGIN_REQUIRED");
    },
    lockOptions: { lockPath: "/tmp/qq-app-probe-unit.lock", cooldownMs: 0 },
  });
  await adapter.perform({ platform: "heybox", operation: "status" });
  assert.equal(
    adapter.capabilities().find((x) => x.platform === "heybox").lastProbe
      .loggedIn,
    null,
  );
  await assert.rejects(
    adapter.perform({ platform: "heybox", operation: "read" }),
    /LOGIN_REQUIRED/,
  );
  assert.equal(
    adapter.capabilities().find((x) => x.platform === "heybox").lastProbe
      .status,
    "APP_LOGIN_REQUIRED",
  );
});
test("Zhihu API article and answer URLs become valid browser content references", async () => {
  const { zhihuSearchRows } = await import("../src/apps/normalize.mjs");
  const rows = zhihuSearchRows({
    data: [
      {
        object: {
          type: "article",
          id: "123",
          url: "https://api.zhihu.com/articles/123",
          title: "文章",
        },
      },
      {
        object: {
          type: "answer",
          id: "456",
          url: "https://www.zhihu.com/api/v4/answers/456",
          question: { id: "789", title: "问答" },
        },
      },
      { object: { type: "ad", id: "100", url: "https://example.org" } },
    ],
  });
  assert.deepEqual(
    rows.map((x) => x.url),
    [
      "https://zhuanlan.zhihu.com/p/123",
      "https://www.zhihu.com/question/789/answer/456",
    ],
  );
});

test("Zhihu recommendations and search preserve URL IDs larger than safe JSON integers", async () => {
  const { zhihuSearchRows } = await import("../src/apps/normalize.mjs");
  const target = JSON.parse(
    '{"type":"answer","id":2097477416973354782,"url":"https://api.zhihu.com/answers/2097477416973354782","question":{"id":1937205528846655531,"url":"https://api.zhihu.com/questions/1937205528846655531","title":"精确来源"}}',
  );
  const expected =
    "https://www.zhihu.com/question/1937205528846655531/answer/2097477416973354782";
  for (const key of ["target", "object"])
    assert.equal(
      zhihuSearchRows({ data: [{ [key]: target }] })[0].url,
      expected,
    );
  assert.equal(
    zhihuSearchRows({
      data: [{ object: { ...target, url: expected, question: undefined } }],
    })[0].url,
    expected,
  );
  assert.equal(
    zhihuSearchRows({ data: [{ target: { ...target, url: undefined } }] })
      .length,
    0,
  );
  assert.equal(
    zhihuSearchRows({
      data: [{ target: { ...target, question: { id: target.question.id } } }],
    }).length,
    0,
  );
  assert.equal(
    zhihuSearchRows({
      // eslint-disable-next-line no-loss-of-precision -- a numeric ID beyond 2^53 must be rejected, not rounded
      data: [{ target: { type: "article", id: 2097477416973354782 } }],
    }).length,
    0,
  );
});

test("exact JSON parsing retains large source IDs and ordinary numbers", async () => {
  const { parseExactJson, zhihuSearchRows } =
    await import("../src/apps/normalize.mjs");
  const data = parseExactJson(
    '{"data":[{"target":{"type":"answer","id":2097477416973354782,"question":{"id":1937205528846655531}}}],"count":12,"score":1.5,"literal":"id:1937205528846655531"}',
  );
  assert.equal(
    zhihuSearchRows(data)[0].url,
    "https://www.zhihu.com/question/1937205528846655531/answer/2097477416973354782",
  );
  assert.equal(data.count, 12);
  assert.equal(data.score, 1.5);
  assert.equal(data.literal, "id:1937205528846655531");
});
test("Heybox web search uses browser-owned login and cursor without exporting cookies", async () => {
  const { heyboxBrowserSearch } = await import("../src/apps/heybox.mjs");
  const visited = [],
    page = {
      goto: async (u) => visited.push(u),
      evaluate: async () => ({
        items: [
          { url: "https://www.xiaoheihe.cn/app/bbs/link/123", title: "测试" },
        ],
        more: true,
      }),
      getCookies: async () => {
        throw Error("must not export cookies for browser search");
      },
    };
  const first = await heyboxRead(page, { operation: "search", query: "a&b" });
  assert.equal(first.coverage, "search-results-scroll");
  assert.equal(new URL(visited[0]).searchParams.get("q"), "a&b");
  await heyboxBrowserSearch(page, { query: "a&b", cursor: first.next });
  assert.equal(visited.length, 1);
  page.evaluate = async () => ({ error: "APP_VERIFICATION_REQUIRED" });
  await assert.rejects(
    heyboxBrowserSearch(page, { query: "a&b", cursor: first.next }),
    /VERIFICATION_REQUIRED/,
  );
});

test("Bilibili dynamic reading distinguishes actual text, forwarded excerpt and video metadata", async () => {
  const { bilibiliDynamicRow } = await import("../src/apps/normalize.mjs");
  const text = bilibiliDynamicRow([
    { field: "text", value: "实际文字" },
    { field: "url", value: "https://t.bilibili.com/123" },
  ]);
  assert.equal(text.coverage, "dynamic-text");
  assert.equal(text.items[0].description, "实际文字");
  const opus = bilibiliDynamicRow([{ field: "opus_text", value: "只有摘要" }]);
  assert.equal(opus.coverage, "dynamic-summary");
  assert.equal(opus.items[0].truncated, true);
  const forward = bilibiliDynamicRow([
    { field: "forward_text", value: "截断摘要" },
  ]);
  assert.equal(forward.coverage, "dynamic-summary");
  assert.equal(forward.items[0].truncated, true);
  const video = bilibiliDynamicRow([
    { field: "video_title", value: "视频" },
    { field: "video_desc", value: "简介" },
  ]);
  assert.equal(video.coverage, "video-metadata");
  assert.equal(video.items[0].description, "简介");
  assert.throws(
    () => bilibiliDynamicRow([{ field: "error", value: "not available" }]),
    /APP_BODY_UNAVAILABLE/,
  );
});
