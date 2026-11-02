import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

// A thread with more comments than one API page (100).
function workspace(total) {
  const requests = [];
  const root = {
    innerHTML: "",
    querySelector: () => ({}),
    querySelectorAll: () => [],
  };
  const comment = (i) => ({
    id: `c${i}`,
    kind: "comment",
    author: { kind: "agent", name: "角色" },
    body: `评论${i}`,
    createdAt: "2026-11-02T00:00:00Z",
  });
  const sandbox = vm.createContext({
    tab: "board",
    URLSearchParams,
    $: () => root,
    esc: (value) => String(value ?? ""),
    action: (fn) => fn(),
    notice: () => {},
    fold: () => "",
    api: async (url) => {
      requests.push(url);
      const offset = Number(
        new URL(url, "http://x").searchParams.get("offset"),
      );
      const end = Math.min(total, offset + 100);
      return {
        post: {
          id: "p",
          kind: "post",
          title: "帖子",
          author: { kind: "admin", name: "管理员" },
          body: "正文",
          createdAt: "2026-11-02T00:00:00Z",
        },
        comments: Array.from({ length: end - offset }, (_, i) =>
          comment(offset + i),
        ),
        total,
        nextOffset: end < total ? end : null,
      };
    },
  });
  vm.runInContext(
    fs.readFileSync(new URL("../public/board-ui.js", import.meta.url), "utf8"),
    sandbox,
  );
  return { sandbox, root, requests };
}

test("a long thread offers the rest of its comments", async () => {
  const f = workspace(150);
  await vm.runInContext("boardThread = 'p'; renderBoard()", f.sandbox);
  assert.match(f.root.innerHTML, /评论99</);
  assert.doesNotMatch(f.root.innerHTML, /评论100</);
  assert.match(f.root.innerHTML, /加载更多评论（还有 50 条）/);
  // After loading more, or after the administrator comments, every page shows.
  await vm.runInContext("boardShown = 200; renderBoard()", f.sandbox);
  assert.match(f.root.innerHTML, /评论149</);
  assert.doesNotMatch(f.root.innerHTML, /加载更多评论/);
  assert.deepEqual(f.requests.slice(-2), [
    "/api/board/post?id=p&offset=0",
    "/api/board/post?id=p&offset=100",
  ]);
});

test("a short thread needs a single page and no load-more button", async () => {
  const f = workspace(3);
  await vm.runInContext("boardThread = 'p'; renderBoard()", f.sandbox);
  assert.equal(f.requests.length, 1);
  assert.doesNotMatch(f.root.innerHTML, /加载更多评论/);
});

test("a draft @s members by name, longest names first", () => {
  const f = workspace(0);
  vm.runInContext(
    `boardMembers = [
      { agentId: "a1", name: "角色1" },
      { agentId: "a10", name: "角色10" },
      { agentId: "fish", name: "大肥鱼" },
    ]`,
    f.sandbox,
  );
  const ids = (text) =>
    JSON.parse(
      vm.runInContext(
        `JSON.stringify(boardMentionsIn(${JSON.stringify(text)}))`,
        f.sandbox,
      ),
    );
  assert.deepEqual(ids("@角色10 你好"), ["a10"]);
  assert.deepEqual(ids("@角色10 和 @角色1"), ["a10", "a1"]);
  assert.deepEqual(ids("大肥鱼没有 @"), []);
  assert.deepEqual(ids("@大肥鱼"), ["fish"]);
});

test("the wall shows filters, pins and who was mentioned", async () => {
  const root = {
    innerHTML: "",
    querySelector: () => ({}),
    querySelectorAll: () => [],
  };
  const requests = [];
  const sandbox = vm.createContext({
    tab: "board",
    URLSearchParams,
    $: () => root,
    esc: (value) =>
      String(value ?? "").replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`),
    action: (fn) => fn(),
    notice: () => {},
    fold: () => "",
    api: async (url) => {
      requests.push(url);
      return {
        policy: {
          enabled: true,
          dailyPosts: 3,
          dailyComments: 10,
          timezone: "Asia/Shanghai",
        },
        day: "2026-11-02",
        members: [{ agentId: "fish", name: "大肥鱼" }],
        usage: [],
        adminMentions: { total: 2, latestSeq: 9 },
        items: [
          {
            id: "p1",
            seq: 9,
            kind: "post",
            title: "<b>公约</b>",
            body: "@管理员 看一下",
            author: { kind: "agent", agentId: "fish", name: "大肥鱼" },
            mentions: [{ kind: "admin", name: "管理员", me: true }],
            mentionsMe: true,
            pinnedAt: "2026-11-02T00:00:00Z",
            comments: 0,
            createdAt: "2026-11-02T00:00:00Z",
            lastActivityAt: "2026-11-02T00:00:00Z",
          },
        ],
        total: 1,
        nextOffset: null,
      };
    },
  });
  vm.runInContext(
    fs.readFileSync(new URL("../public/board-ui.js", import.meta.url), "utf8"),
    sandbox,
  );
  await vm.runInContext(
    `boardFilters = { q: "公 约", author: "agent:fish", mention: "admin", sort: "newest", removed: true }; renderBoard()`,
    sandbox,
  );
  assert.equal(
    requests[0],
    "/api/board?offset=0&q=%E5%85%AC+%E7%BA%A6&author=agent%3Afish&mention=admin&sort=newest&removed=1",
  );
  const html = root.innerHTML;
  // Titles are escaped; the note carries its pin, colour and @你 marks.
  assert.match(html, /&#60;b&#62;公约/);
  assert.doesNotMatch(html, /<b>公约/);
  assert.match(html, /board-note note-c0 is-pinned mentions-me/);
  assert.match(html, /<span class="board-at is-me">@管理员<\/span>/);
  assert.match(html, /@我的 2<span class="board-dot"/);
  assert.match(html, /清除筛选/);
  assert.match(html, /筛出 1 张便签/);
});
