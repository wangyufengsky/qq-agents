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
