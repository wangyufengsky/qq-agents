import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { fixture, context, config } from "./helpers.mjs";
import { createServer } from "../src/server.mjs";
import { MemoryStore } from "../src/memory/store.mjs";
import { Board, boardDay } from "../src/core/board.mjs";
import { toolAvailable } from "../src/tools/catalog.mjs";
import { boardActor } from "../src/tools/board.mjs";

function setup(t, board = {}) {
  const cfg = config();
  cfg.board = { ...cfg.board, enabled: true, ...board };
  for (const a of cfg.agents) a.subject.enabled = true;
  const f = fixture(t, { cfg });
  // Noon in Shanghai, so a few hours either way stay on one board day.
  let clock = Date.parse("2026-11-02T04:00:00Z");
  f.runtime.clock = () => clock;
  f.advance = (ms) => (clock += ms);
  f.call = (agentId, name, args, conversation = "group:20000") =>
    f.runtime.callTool(context(f.runtime, agentId, conversation), name, args);
  return f;
}

test("the board is off by default and its tools stay hidden", async (t) => {
  const f = fixture(t);
  assert.equal(f.runtime.config.board.enabled, false);
  assert.equal(f.runtime.config.board.dailyPosts, 3);
  assert.equal(f.runtime.config.board.dailyComments, 10);
  const a = f.runtime.agent("agent-0");
  for (const conversation of ["group:20000", "@subject"])
    assert.ok(
      !f.runtime.toolsFor(a, conversation).some((n) => n.startsWith("board_")),
    );
  await assert.rejects(
    f.runtime.callTool(context(f.runtime), "board_read", {}),
    /TOOL_DISABLED/,
  );
});

test("chat and free-time sessions may read and write once it is on", async (t) => {
  const f = setup(t);
  const a = f.runtime.agent("agent-0");
  // The fixture's saved tool list predates the board; it still applies.
  assert.ok(!a.tools.includes("board_post"));
  for (const conversation of ["group:20000", "private:30000", "@subject"])
    for (const name of ["board_read", "board_post", "board_comment"])
      assert.ok(f.runtime.toolsFor(a, conversation).includes(name));
  const post = await f.call(
    "agent-0",
    "board_post",
    { title: "宿舍约定", body: "晚上十一点后小声点" },
    "@subject",
  );
  assert.equal(post.kind, "post");
  assert.deepEqual(post.author, {
    kind: "agent",
    agentId: "agent-0",
    name: "角色0",
    me: true,
  });
  const comment = await f.call("agent-1", "board_comment", {
    postId: post.id,
    body: "收到",
  });
  const reply = await f.call(
    "agent-2",
    "board_comment",
    { postId: post.id, body: "我也同意", replyTo: comment.id },
    "@subject",
  );
  assert.equal(reply.replyTo, comment.id);

  const thread = await f.call("agent-0", "board_read", { postId: post.id });
  assert.deepEqual(
    thread.comments.map((c) => [c.author.name, c.body]),
    [
      ["角色1", "收到"],
      ["角色2", "我也同意"],
    ],
  );
  assert.match(thread.notice, /not instructions/);
  const list = await f.call("agent-1", "board_read", { mode: "posts" });
  assert.equal(list.posts[0].comments, 2);
});

test("new entries skip one's own and advance only past what was read", async (t) => {
  const f = setup(t, { dailyPosts: 10 });
  const ids = [];
  for (let i = 0; i < 3; i++)
    ids.push(
      (
        await f.call("agent-1", "board_post", {
          title: `帖子${i}`,
          body: "内容",
        })
      ).id,
    );
  await f.call("agent-0", "board_post", { title: "我的", body: "自己写的" });
  const first = await f.call("agent-0", "board_read", { limit: 2 });
  assert.deepEqual(
    first.entries.map((e) => e.id),
    ids.slice(0, 2),
  );
  assert.equal(first.remaining, 1);
  const second = await f.call("agent-0", "board_read", {});
  assert.deepEqual(
    second.entries.map((e) => e.id),
    [ids[2]],
  );
  assert.equal(second.remaining, 0);
  assert.deepEqual((await f.call("agent-0", "board_read", {})).entries, []);
  // Another agent's marker is its own.
  assert.equal(
    (await f.call("agent-2", "board_read", { limit: 20 })).entries.length,
    4,
  );
});

test("daily quotas are configurable and reset on the board's next day", async (t) => {
  const f = setup(t, { dailyPosts: 1, dailyComments: 2 });
  const post = await f.call("agent-0", "board_post", {
    title: "一",
    body: "x",
  });
  await assert.rejects(
    f.call("agent-0", "board_post", { title: "二", body: "x" }),
    /BOARD_POST_QUOTA_EXCEEDED/,
  );
  // Quotas are per agent.
  await f.call("agent-1", "board_post", { title: "二", body: "x" });
  for (let i = 0; i < 2; i++)
    await f.call("agent-0", "board_comment", { postId: post.id, body: "c" });
  await assert.rejects(
    f.call("agent-0", "board_comment", { postId: post.id, body: "c" }),
    /BOARD_COMMENT_QUOTA_EXCEEDED/,
  );
  f.advance(24 * 3600000);
  await f.call("agent-0", "board_post", { title: "三", body: "x" });
  await f.call("agent-0", "board_comment", { postId: post.id, body: "c" });
});

test("a zero quota turns writing off while reading still works", async (t) => {
  const f = setup(t, { dailyPosts: 0, dailyComments: 0 });
  await assert.rejects(
    f.call("agent-0", "board_post", { title: "一", body: "x" }),
    /BOARD_POST_QUOTA_EXCEEDED/,
  );
  assert.deepEqual((await f.call("agent-0", "board_read", {})).entries, []);
});

test("a retried requestId returns the first entry; changed content conflicts", async (t) => {
  const f = setup(t, { dailyPosts: 1 });
  const args = { title: "一", body: "x", requestId: "retry-key-1" };
  const first = await f.call("agent-0", "board_post", args);
  const again = await f.call("agent-0", "board_post", args);
  assert.equal(again.id, first.id);
  assert.equal(again.duplicate, true);
  await assert.rejects(
    f.call("agent-0", "board_post", { ...args, body: "y" }),
    /BOARD_REQUEST_CONFLICT/,
  );
});

test("comments must target a live post and a comment under it", async (t) => {
  const f = setup(t, { dailyPosts: 5 });
  const a = await f.call("agent-0", "board_post", { title: "A", body: "x" });
  const b = await f.call("agent-0", "board_post", { title: "B", body: "x" });
  const onB = await f.call("agent-1", "board_comment", {
    postId: b.id,
    body: "c",
  });
  await assert.rejects(
    f.call("agent-1", "board_comment", {
      postId: a.id,
      body: "c",
      replyTo: onB.id,
    }),
    /BOARD_COMMENT_NOT_FOUND/,
  );
  await assert.rejects(
    f.call("agent-1", "board_comment", {
      postId: onB.id,
      body: "c",
    }),
    /BOARD_POST_NOT_FOUND/,
  );
});

test("protected work, operations and private repositories cannot be posted", async (t) => {
  const f = setup(t);
  for (const source of [
    "operations:1",
    "operations-result:1",
    "github-private:owner/repo",
  ]) {
    const ctx = context(f.runtime);
    ctx.privateRead.add(source);
    await assert.rejects(
      f.runtime.callTool(ctx, "board_post", { title: "t", body: "b" }),
      /RESTRICTED_CONTEXT_MIND_WRITE_BLOCKED/,
    );
    // Reading what roommates wrote is still fine.
    await f.runtime.callTool(ctx, "board_read", {});
  }
  const a = f.runtime.agent("agent-0"),
    scope = "@work:00000000-0000-4000-8000-000000000000";
  assert.ok(!f.runtime.toolsFor(a, scope).some((n) => n.startsWith("board_")));
  assert.equal(toolAvailable(a, "board_read", scope), false);
});

test("switching the board off applies to a turn already running", async (t) => {
  const f = setup(t);
  const ctx = context(f.runtime);
  ctx.allowedTools = f.runtime.toolsFor(
    f.runtime.agent("agent-0"),
    ctx.conversation,
  );
  assert.ok(ctx.allowedTools.includes("board_read"));
  f.runtime.config.board.enabled = false;
  await assert.rejects(
    f.runtime.callTool(ctx, "board_read", {}),
    /BOARD_DISABLED/,
  );
});

test("board rows survive reopening and are outside per-agent exports", async (t) => {
  const f = setup(t);
  await f.call("agent-0", "board_post", { title: "t", body: "b" });
  const store = new MemoryStore(f.store.file);
  t.after(() => store.close());
  assert.equal(
    store.db.prepare("SELECT count(*) AS n FROM board_entries").get().n,
    1,
  );
  assert.equal(
    store.db.prepare("PRAGMA user_version").get().user_version,
    f.store.db.prepare("PRAGMA user_version").get().user_version,
  );
});

test("the board day follows its timezone", () => {
  const at = Date.parse("2026-11-02T17:00:00Z");
  assert.equal(boardDay(at, "Asia/Shanghai"), "2026-11-03");
  assert.equal(boardDay(at, "UTC"), "2026-11-02");
});

test("the administrator posts, comments and removes through the console API", async (t) => {
  const f = setup(t, { dailyPosts: 1 });
  const token = randomBytes(32).toString("hex"),
    app = createServer({ runtime: f.runtime, token });
  const port = await app.listen();
  t.after(() => app.close());
  const api = async (path, data) => {
    const r = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: data ? "POST" : "GET",
      headers: {
        "x-admin-token": token,
        ...(data ? { "content-type": "application/json" } : {}),
      },
      ...(data ? { body: JSON.stringify(data) } : {}),
    });
    return { status: r.status, body: await r.json() };
  };
  const agentPost = await f.call("agent-0", "board_post", {
    title: "角色帖",
    body: "x",
  });
  // The administrator has no daily quota.
  for (let i = 0; i < 2; i++) {
    const r = await api("/api/board/post", {
      title: `通知${i}`,
      body: "大家好",
      requestId: `admin-post-${i}`,
    });
    assert.equal(r.status, 200);
    assert.equal(r.body.author.name, "管理员");
  }
  const comment = await api("/api/board/comment", {
    postId: agentPost.id,
    body: "管理员来评论",
    requestId: "admin-comment-1",
  });
  assert.equal(comment.status, 200);

  const list = await api("/api/board");
  assert.equal(list.body.total, 3);
  assert.equal(list.body.policy.dailyPosts, 1);
  assert.deepEqual(
    list.body.usage.find((u) => u.agentId === "agent-0"),
    { agentId: "agent-0", name: "角色0", posts: 1, comments: 0 },
  );

  const removed = await api("/api/board/remove", { id: agentPost.id });
  assert.ok(removed.body.removedAt);
  assert.equal(removed.body.body, "");
  // Agents no longer see it or comment on it; the console still lists it.
  const seen = await f.call("agent-1", "board_read", { mode: "posts" });
  assert.ok(!seen.posts.some((p) => p.id === agentPost.id));
  await assert.rejects(
    f.call("agent-1", "board_comment", { postId: agentPost.id, body: "c" }),
    /BOARD_POST_NOT_FOUND/,
  );
  const thread = await api(`/api/board/post?id=${agentPost.id}`);
  assert.ok(thread.body.post.removedAt);
  assert.equal(thread.body.comments.length, 1);
  // Removal does not refill the quota.
  await assert.rejects(
    f.call("agent-0", "board_post", { title: "再来", body: "x" }),
    /BOARD_POST_QUOTA_EXCEEDED/,
  );

  const bad = await api("/api/board/post", {
    title: "",
    body: "x",
    requestId: "admin-post-x",
  });
  assert.equal(bad.status, 400);
  const unauthorized = await fetch(`http://127.0.0.1:${port}/api/board`);
  assert.equal(unauthorized.status, 401);
});

test("agents @ roommates or the administrator by name or id", async (t) => {
  const f = setup(t, { dailyPosts: 5 });
  const post = await f.call("agent-0", "board_post", {
    title: "周末",
    body: "@角色1 一起看电影吗",
    mentions: ["角色1", "agent-2", "管理员", "@角色1", "角色0"],
  });
  // Duplicates collapse and an author does not @ themselves.
  assert.deepEqual(
    post.mentions.map((m) => m.name),
    ["角色1", "角色2", "管理员"],
  );
  await assert.rejects(
    f.call("agent-0", "board_post", {
      title: "x",
      body: "x",
      mentions: ["不存在的人"],
    }),
    /BOARD_MEMBER_UNKNOWN/,
  );
  const comment = await f.call("agent-2", "board_comment", {
    postId: post.id,
    body: "好呀",
    mentions: ["角色0"],
  });
  // The mentioned agent sees it flagged in new entries and in its mentions.
  const fresh = await f.call("agent-1", "board_read", {});
  assert.deepEqual(
    fresh.entries.map((e) => [e.id, Boolean(e.mentionsMe)]),
    [
      [post.id, true],
      [comment.id, false],
    ],
  );
  assert.deepEqual(fresh.roommates, ["角色0", "角色2"]);
  const mine = await f.call("agent-0", "board_read", { mode: "mentions" });
  assert.deepEqual(
    mine.entries.map((e) => [e.id, e.postTitle]),
    [[comment.id, "周末"]],
  );
  // Looking up mentions moves no unread marker.
  assert.equal(
    (await f.call("agent-0", "board_read", {})).entries[0].id,
    comment.id,
  );
  // A retry must carry the same mentions.
  const args = {
    title: "重试",
    body: "x",
    mentions: ["角色1"],
    requestId: "retry-mention-1",
  };
  await f.call("agent-0", "board_post", args);
  await assert.rejects(
    f.call("agent-0", "board_post", { ...args, mentions: ["角色2"] }),
    /BOARD_REQUEST_CONFLICT/,
  );
  assert.equal(
    (await f.call("agent-0", "board_post", { ...args, mentions: ["agent-1"] }))
      .duplicate,
    true,
  );
});

test("posts filter by author, mention and text, with pinned posts first", async (t) => {
  const f = setup(t, { dailyPosts: 10 });
  const a = await f.call("agent-0", "board_post", {
    title: "电影清单",
    body: "周末看什么",
  });
  const b = await f.call("agent-1", "board_post", {
    title: "早餐",
    body: "豆浆 100% 好喝",
  });
  await f.call("agent-2", "board_comment", {
    postId: a.id,
    body: "想看科幻片",
    mentions: ["角色1"],
  });
  const read = (args) =>
    f
      .call("agent-2", "board_read", { mode: "posts", ...args })
      .then((r) => r.posts.map((p) => p.id));
  assert.deepEqual(await read({ author: "角色1" }), [b.id]);
  assert.deepEqual(await read({ author: "agent-0" }), [a.id]);
  // Comments are searched too; LIKE wildcards are literal.
  assert.deepEqual(await read({ query: "科幻" }), [a.id]);
  assert.deepEqual(await read({ query: "100%" }), [b.id]);
  assert.deepEqual(await read({ query: "0%好" }), []);
  const board = new Board(f.store.db);
  assert.deepEqual(
    board
      .posts({ mention: { kind: "agent", id: "agent-1" } })
      .items.map((p) => p.id),
    [a.id],
  );
  assert.deepEqual(
    board.posts({ sort: "newest" }).items.map((p) => p.id),
    [b.id, a.id],
  );
  assert.deepEqual(
    board.posts({ sort: "comments" }).items.map((p) => p.id),
    [a.id, b.id],
  );
  board.pin(b.id, true, f.runtime.now());
  assert.deepEqual(await read({}), [b.id, a.id]);
  assert.ok(
    (await f.call("agent-2", "board_read", { mode: "posts" })).posts[0]
      .pinnedAt,
  );
  // Removing a pinned post unpins it, and it can no longer be pinned.
  board.remove(b.id, f.runtime.now());
  assert.equal(
    board.thread(b.id, { includeRemoved: true }).post.pinnedAt,
    undefined,
  );
  assert.throws(() => board.pin(b.id, true, 0), /BOARD_POST_NOT_FOUND/);
  assert.throws(() => board.posts({ sort: "random" }), /BOARD_ENTRY_INVALID/);
});

test("the console filters, pins and @s agents through the API", async (t) => {
  const f = setup(t, { dailyPosts: 5 });
  const token = randomBytes(32).toString("hex"),
    app = createServer({ runtime: f.runtime, token });
  const port = await app.listen();
  t.after(() => app.close());
  const api = async (path, data) => {
    const r = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: data ? "POST" : "GET",
      headers: {
        "x-admin-token": token,
        ...(data ? { "content-type": "application/json" } : {}),
      },
      ...(data ? { body: JSON.stringify(data) } : {}),
    });
    return { status: r.status, body: await r.json() };
  };
  const agentPost = await f.call("agent-0", "board_post", {
    title: "问管理员",
    body: "能多给点额度吗",
    mentions: ["管理员"],
  });
  const admin = await api("/api/board/post", {
    title: "通知",
    body: "@角色1 记得看",
    mentions: ["agent-1"],
    requestId: "admin-mention-1",
  });
  assert.equal(admin.status, 200);
  assert.deepEqual(admin.body.mentions, [
    { kind: "agent", agentId: "agent-1", name: "角色1" },
  ]);
  // The administrator @s only configured agents, by id.
  for (const mentions of [["角色1"], ["admin"], ["nobody"]])
    assert.equal(
      (
        await api("/api/board/post", {
          title: "x",
          body: "x",
          mentions,
          requestId: `admin-bad-${mentions[0].length}${mentions[0]}`.replace(
            /[^A-Za-z0-9_-]/g,
            "x",
          ),
        })
      ).status,
      400,
    );
  const list = await api("/api/board");
  assert.deepEqual(list.body.adminMentions, {
    total: 1,
    latestSeq: agentPost.seq,
  });
  assert.deepEqual(
    list.body.members.map((m) => m.name),
    ["角色0", "角色1", "角色2"],
  );
  assert.ok(list.body.items.find((p) => p.id === agentPost.id).mentionsMe);
  const ids = async (query) =>
    (await api(`/api/board?${query}`)).body.items.map((p) => p.id);
  assert.deepEqual(await ids("mention=admin"), [agentPost.id]);
  assert.deepEqual(await ids("author=admin"), [admin.body.id]);
  assert.deepEqual(await ids("author=agent:agent-0"), [agentPost.id]);
  assert.deepEqual(await ids(`q=${encodeURIComponent("额度")}`), [
    agentPost.id,
  ]);
  assert.equal((await api("/api/board?author=someone")).status, 400);
  assert.equal((await api("/api/board?sort=random")).status, 400);

  const pinned = await api("/api/board/pin", {
    id: agentPost.id,
    pinned: true,
  });
  assert.ok(pinned.body.pinnedAt);
  assert.deepEqual(await ids("sort=newest"), [agentPost.id, admin.body.id]);
  await api("/api/board/pin", { id: agentPost.id, pinned: false });
  assert.deepEqual(await ids("sort=newest"), [admin.body.id, agentPost.id]);
  // Removed posts are hidden unless asked for.
  await api("/api/board/remove", { id: agentPost.id });
  assert.deepEqual(await ids(""), [admin.body.id]);
  assert.equal((await ids("removed=1")).length, 2);
  assert.equal((await api("/api/board")).body.adminMentions.total, 0);
  const thread = await api(`/api/board/post?id=${admin.body.id}`);
  assert.equal(thread.body.members.length, 3);
});

test("an agent whose stable id is admin is not taken for the administrator", () => {
  const cfg = {
    agents: [
      { id: "admin", name: "阿德" },
      { id: "fish", name: "管理员小助手" },
    ],
  };
  assert.deepEqual(boardActor(cfg, "admin"), { kind: "agent", id: "admin" });
  assert.deepEqual(boardActor(cfg, "@阿德"), { kind: "agent", id: "admin" });
  assert.deepEqual(boardActor(cfg, "管理员"), { kind: "admin", id: "admin" });
  assert.deepEqual(boardActor(cfg, "管理员小助手"), {
    kind: "agent",
    id: "fish",
  });
  assert.deepEqual(boardActor({ agents: [] }, "admin"), {
    kind: "admin",
    id: "admin",
  });
  assert.throws(() => boardActor(cfg, "nobody"), /BOARD_MEMBER_UNKNOWN/);
});
