import test from "node:test";
import assert from "node:assert/strict";
import { parseCards } from "../src/apps/cards.mjs";
import { contentIdentity, resolveAppUrl } from "../src/apps/urls.mjs";
import { heyboxRead } from "../src/apps/heybox.mjs";

const share = "https://api.xiaoheihe.cn/v3/bbs/app/api/web/share";
const postUrl = (id) => `https://www.xiaoheihe.cn/app/bbs/link/${id}`;

test("Heybox v3 shares normalize numeric and hex ids without tracking parameters", () => {
  for (const id of ["10001", "abcdef123456"])
    for (const field of ["link_id", "linkid"]) {
      const identity = contentIdentity(
        `${share}?h_camp=fixture&h_src=fixture&${field}=${id}&new_post_share_style_v2=1`,
        "heybox",
      );
      assert.deepEqual(identity, {
        platform: "heybox",
        id,
        key: `heybox:${id}`,
        kind: "post",
        url: postUrl(id),
      });
    }
});

test("Heybox v3 shares still reject invalid ids, unrelated paths, domains and credentials", () => {
  for (const query of [
    "",
    "?link_id=",
    "?link_id=abc",
    "?link_id=ABCDEF123456",
    "?link_id=abcdef12345z",
    "?link_id=" + "a".repeat(33),
    "?link_id=..%2F10001",
  ])
    assert.throws(
      () => contentIdentity(share + query),
      /APP_CONTENT_URL_INVALID/,
    );
  for (const url of [
    `${share}/other?link_id=10001`,
    "https://api.xiaoheihe.cn/unrelated?link_id=10001",
    "https://api.xiaoheihe.cn.evil.example/v3/bbs/app/api/web/share?link_id=10001",
  ])
    assert.throws(() => contentIdentity(url), /APP_CONTENT_URL_INVALID/);
  assert.throws(
    () => contentIdentity(`${share}?link_id=10001&access_token=fixture`),
    /APP_URL_CREDENTIALS/,
  );
});

test("text and QQ news shares resolve through authorization and DNS to Heybox body reads", async () => {
  const id = "abcdef123456";
  const url = `${share}?link_id=${id}&h_src=fixture`;
  const segments = [
    { type: "text", data: { text: url } },
    {
      type: "json",
      data: {
        data: JSON.stringify({
          app: "com.tencent.tuwen.lua",
          meta: { news: { title: "合成文章", jumpUrl: url } },
        }),
      },
    },
  ];
  for (const segment of segments) {
    const [card] = parseCards([segment]);
    assert.equal(card.key, `heybox:${id}`);
    assert.equal(card.url, url);
    assert.equal(card.readingScope, "card-summary");
    const checks = [];
    const resolved = await resolveAppUrl(card.url, {
      authorize: (value) => checks.push(["authorize", value]),
      validate: async (value) => {
        checks.push(["dns", value]);
        return { url: new URL(value), addresses: ["93.184.216.34"] };
      },
      request: () =>
        assert.fail("share pages must use the fixed platform adapter"),
    });
    assert.deepEqual(checks, [
      ["authorize", url],
      ["dns", url],
    ]);
    assert.equal(resolved.url, postUrl(id));
    const result = await heyboxRead(
      { getCookies: async () => [] },
      { operation: "read", url: resolved.url },
      {
        request: async (endpoint, params) => {
          assert.equal(endpoint, "/bbs/app/link/tree");
          assert.equal(params.link_id, id);
          assert.equal(params.is_first, "1");
          return {
            link: { linkid: "10001", title: "合成文章", text: "合成正文" },
          };
        },
      },
    );
    assert.equal(result.coverage, "post-text");
    assert.equal(result.items[0].description, "合成正文");
    assert.equal(result.items[0].url, postUrl("10001"));
  }
});
