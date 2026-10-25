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
