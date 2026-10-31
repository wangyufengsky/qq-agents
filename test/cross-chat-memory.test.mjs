import test from "node:test";
import assert from "node:assert/strict";
import { fixture, context } from "./helpers.mjs";
import { safeToolFailure } from "../src/tools/errors.mjs";

function append(mem, key, conversation, body, payload = {}) {
  return mem.append({
    dedupe: key,
    connectionId: "qq-0",
    conversation,
    kind: "message.received",
    direction: "in",
    senderId: "30000",
    body,
    payload,
  });
}

test("private recall filters own group history without changing read state or exposing protected sources", async (t) => {
  const { runtime, store } = fixture(t);
  const mem = store.bind("agent-0"),
    ctx = context(runtime, "agent-0", "private:30000");
  const group = append(mem, "group", "group:20000", "纸桥游戏 GROUP_MARKER");
  append(mem, "private", "private:30000", "纸桥游戏 PRIVATE_MARKER");
  append(mem, "protected", "group:20000", "纸桥游戏 PROTECTED_MARKER", {
    protectedOperations: true,
  });
  append(
    store.bind("agent-1"),
    "foreign",
    "group:20000",
    "纸桥游戏 OTHER_AGENT_MARKER",
  );
  const before = mem.state("group:20000");
  const result = await runtime.callTool(ctx, "memory_search", {
    query: "纸桥游戏",
    conversationType: "group",
    contextBefore: 0,
    contextAfter: 0,
  });
  assert.deepEqual(
    result.items.map((x) => x.id),
    [group.id],
  );
  assert.equal(result.withheld, 1);
  assert.doesNotMatch(
    JSON.stringify(result),
    /PRIVATE_MARKER|PROTECTED_MARKER|OTHER_AGENT_MARKER/,
  );
  assert.equal(result.items[0].disclosure, "agent-judged-recollection");
  assert.deepEqual(mem.state("group:20000"), before);
  await assert.rejects(
    runtime.callTool(ctx, "memory_read", {
      id: mem.search({
        query: "PROTECTED_MARKER",
        contextBefore: 0,
        contextAfter: 0,
      }).items[0].id,
    }),
    /RECALL_SOURCE_NOT_ALLOWED/,
  );
  const priv = await runtime.callTool(ctx, "memory_search", {
    conversationType: "private",
  });
  assert(priv.items.every((x) => x.conversation.startsWith("private:")));
});

test("ambiguous source kinds fail with actionable guidance rather than an empty page", async (t) => {
  const { runtime } = fixture(t),
    ctx = context(runtime, "agent-0", "private:30000");
  for (const conversation of ["group", "private", "group:*", "private:*"])
    for (const tool of ["memory_search", "conversation_read"])
      await assert.rejects(
        runtime.callTool(ctx, tool, { conversation }),
        /INVALID_MEMORY_SCOPE/,
      );
  await assert.rejects(
    runtime.callTool(ctx, "memory_search", {
      conversationType: "group",
      conversation: "private:30000",
    }),
    /INVALID_MEMORY_SCOPE/,
  );
  const failure = safeToolFailure(Error("INVALID_MEMORY_SCOPE"));
  assert.match(failure.hint, /conversationType=group\/private/);
  assert.match(failure.hint, /not an empty memory result/);
});

test("returned continuation retains filters and reaches old group evidence behind recent private pages", async (t) => {
  const { runtime, store } = fixture(t),
    mem = store.bind("agent-0");
  const ctx = context(runtime, "agent-0", "private:30000");
  const group = append(
    mem,
    "group",
    "group:20000",
    "纸桥游戏 OLD_GROUP_MARKER",
  );
  for (let i = 0; i < 6; i++)
    append(mem, "private" + i, "private:30000", "纸桥游戏 私聊干扰" + i);
  let page = await runtime.callTool(ctx, "memory_search", {
    query: "纸桥游戏",
    limit: 2,
    type: "event",
    contextBefore: 0,
    contextAfter: 0,
  });
  assert(page.items.every((x) => x.conversation.startsWith("private:")));
  assert.equal(page.hasMore, true);
  assert.equal(page.scope.conversationType, "all");
  const ids = page.items.map((x) => x.id);
  // A later append must not enter the stable cursor's view.
  append(mem, "new", "group:20000", "纸桥游戏 TOO_NEW");
  while (page.continueWith) {
    const { tool, arguments: args } = page.continueWith;
    assert.equal(tool, "memory_search");
    assert.equal(args.query, "纸桥游戏");
    assert.equal(args.limit, 2);
    page = await runtime.callTool(ctx, tool, args);
    ids.push(...page.items.map((x) => x.id));
  }
  assert.equal(ids.length, 7);
  assert.equal(new Set(ids).size, 7);
  assert.equal(ids.at(-1), group.id);
  assert.equal(page.hasMore, false);
  assert.equal(page.nextCursor, null);
});

test("conversation_read remains current-chat by default and exact-source reads preserve privacy boundaries", async (t) => {
  const { runtime, store } = fixture(t),
    mem = store.bind("agent-0");
  const ctx = context(runtime, "agent-0", "private:30000");
  append(mem, "group", "group:20000", "GROUP_HISTORY");
  append(mem, "private", "private:30000", "PRIVATE_HISTORY");
  const local = await runtime.callTool(ctx, "conversation_read", {});
  assert.equal(local.scope.conversation, "private:30000");
  assert.match(local.notice, /memory_search with conversationType/);
  assert(local.items.every((x) => x.conversation === "private:30000"));
  const group = await runtime.callTool(ctx, "conversation_read", {
    conversation: "group:20000",
  });
  assert.equal(group.markReadEligible, false);
  assert(group.items.every((x) => x.conversation === "group:20000"));
  // A source filter cannot accidentally include unrelated standalone diaries.
  mem.diaryWrite({ title: "日记", body: "PRIVATE_DIARY" });
  const search = await runtime.callTool(ctx, "memory_search", {
    conversationType: "group",
  });
  assert.deepEqual(search.diaries, []);
});
