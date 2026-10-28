import test from "node:test";
import assert from "node:assert/strict";
import { config, fixture, context } from "./helpers.mjs";

function setup(t, options = {}) {
  const cfg = config(1);
  const a = cfg.agents[0];
  a.ownerIds = ["30000"];
  a.network.autonomous = true;
  a.subject.enabled = true;
  a.operations.enabled = true;
  a.github.enabled = true;
  a.github.privateRepositories = ["fixture/private"];
  a.tools.push("memory_related", "external_tool");
  cfg.backends[0].toolServers = [
    {
      id: "search",
      transport: "http",
      url: "https://example.com/mcp",
      allowedTools: ["search"],
    },
  ];
  const f = fixture(t, { cfg, ...options });
  const m = f.store.bind("agent-0");
  const secret = m.diaryWrite(
    { title: "weekend", body: "PROTECTED_WORK_SECRET" },
    "ai-diary",
    {},
    true,
    [],
  );
  const ordinary = m.diaryWrite({ title: "weekend", body: "went for a walk" });
  return { ...f, m, secret, ordinary };
}

test("owner chat recalls ordinary diaries, searches and replies without importing protected work", async (t) => {
  const f = setup(t);
  const ctx = context(f.runtime, "agent-0", "private:30000");
  const recall = await f.runtime.callTool(ctx, "memory_search", {
    query: "weekend",
  });
  assert.doesNotMatch(JSON.stringify(recall), /PROTECTED_WORK_SECRET/);
  assert(recall.diaries.some((row) => row.id === f.ordinary.id));
  for (const name of ["memory_read", "memory_related"])
    await assert.rejects(
      f.runtime.callTool(ctx, name, { id: f.secret.id }),
      /RECALL_SOURCE_NOT_ALLOWED/,
    );
  let searched = false;
  f.runtime.backends.set("agent-0", {
    external: {
      call: async () => {
        searched = true;
        return { items: ["public result"] };
      },
    },
    close: async () => {},
  });
  await f.runtime.callTool(ctx, "external_tool", {
    serverId: "search",
    tool: "search",
    arguments: { query: "weekend games" },
  });
  assert(searched);
  const sent = await f.runtime.callTool(ctx, "qq_send", {
    requestId: "daily-reply",
    text: "hello",
  });
  assert.equal(sent.status, "sent");
});

test("isolated work reads protected material while concurrent owner chat searches and sends", async (t) => {
  let unblock, entered;
  const started = new Promise((resolve) => {
    entered = resolve;
  });
  const hold = new Promise((resolve) => {
    unblock = resolve;
  });
  const f = setup(t, {
    run: async (p) => {
      assert.equal(p.protectedWork, true);
      assert.equal(p.session, null);
      assert(
        !p.tools.some((tool) => /^(qq_|external_|self_|app_)/.test(tool.name)),
      );
      const read = await p.callTool("memory_read", { id: f.secret.id });
      assert.match(JSON.stringify(read), /PROTECTED_WORK_SECRET/);
      for (const name of [
        "qq_send",
        "web_fetch",
        "external_tool",
        "self_propose",
        "intent_create",
      ])
        await assert.rejects(p.callTool(name, {}), /TOOL_DISABLED/);
      p.saveSession({
        backend: "codex",
        id: "work-model-session",
        signature: "work",
      });
      entered();
      await hold;
      await p.callTool("protected_work_submit", {
        text: "Reviewed summary only",
      });
    },
  });
  const task = f.runtime.protectedWork.create({
    agentId: "agent-0",
    instruction: "Review protected material",
    operations: true,
  });
  const scope = "@work:" + task.id;
  await f.runtime.protectedWork.act({
    agentId: "agent-0",
    taskId: task.id,
    action: "run",
  });
  await started;
  const daily = context(f.runtime, "agent-0", "private:30000");
  const search = await f.runtime.callTool(daily, "memory_search", {});
  assert.doesNotMatch(
    JSON.stringify(search),
    /PROTECTED_WORK_SECRET|Review protected material/,
  );
  assert.doesNotThrow(() =>
    f.runtime.authorizeExternal(daily, {
      tool: "web_fetch",
      args: { url: "https://example.com/" },
    }),
  );
  assert.equal(
    (await f.runtime.send(daily, { requestId: "during-work", text: "hello" }))
      .status,
    "sent",
  );
  const running = f.runtime.running.get("agent-0|" + scope);
  unblock();
  await running.done;
  assert.equal(f.runtime.protectedWork.task("agent-0", scope).status, "review");
  assert.equal(f.m.state(scope).session, null);
  assert.equal(f.m.state("private:30000").session, undefined);
  assert(!f.runtime.faults.has("agent-0"));
});

test("only exact reviewed bytes enter their approved conversation; raw records remain protected", async (t) => {
  const f = setup(t);
  const task = f.runtime.protectedWork.create({
    agentId: "agent-0",
    instruction: "SECRET TASK",
  });
  const work = context(f.runtime, "agent-0", "@work:" + task.id);
  await f.runtime.callTool(work, "protected_work_submit", {
    text: "Summary revision one",
  });
  const old = f.runtime.protectedWork.task("agent-0", work.conversation);
  await f.runtime.callTool(work, "protected_work_submit", {
    text: "Approved summary two",
  });
  const latest = f.runtime.protectedWork.task("agent-0", work.conversation);
  const release = {
    agentId: "agent-0",
    taskId: task.id,
    action: "release",
    revision: latest.revision,
    digest: latest.result.digest,
    target: "private:30000",
  };
  await assert.rejects(
    f.runtime.protectedWork.act({
      ...release,
      revision: old.revision,
      digest: old.result.digest,
    }),
    /REVIEW_STALE/,
  );
  await assert.rejects(
    f.runtime.protectedWork.act({ ...release, target: "private:99999" }),
    /INVALID_CONVERSATION/,
  );
  const before = await f.runtime.callTool(
    context(f.runtime, "agent-0", release.target),
    "memory_search",
    { query: "summary" },
  );
  assert.equal(before.items.length, 0);
  const result = await f.runtime.protectedWork.act(release);
  assert.equal(result.sent, false);
  assert(work.controller.signal.aborted);
  assert(!f.runtime.capabilities.has(work.token));
  const owner = context(f.runtime, "agent-0", release.target);
  const read = await f.runtime.callTool(owner, "memory_read", {
    id: result.recordId,
  });
  assert.match(JSON.stringify(read), /Approved summary two/);
  assert.doesNotMatch(
    JSON.stringify(read),
    /SECRET TASK|Summary revision one|PROTECTED_WORK_SECRET/,
  );
  assert.match(
    JSON.stringify(
      await f.runtime.callTool(context(f.runtime), "memory_read", {
        id: result.recordId,
      }),
    ),
    /Approved summary two/,
  );
  await assert.rejects(f.runtime.protectedWork.act(release), /NOT_ACTIVE/);
  await assert.rejects(
    f.runtime.callTool(work, "protected_work_submit", { text: "late result" }),
    /PAUSED_OR_EXPIRED/,
  );
  assert.equal(f.runtime.transports.get("qq-0").sent.length, 0);
});

test("work failure, cancellation and restart stay local and never replay", async (t) => {
  const f = setup(t, {
    run: async () => {
      throw Error("private-provider-failure");
    },
  });
  const task = f.runtime.protectedWork.create({
    agentId: "agent-0",
    instruction: "private task",
  });
  const scope = "@work:" + task.id;
  await f.runtime.protectedWork.act({
    agentId: "agent-0",
    taskId: task.id,
    action: "run",
  });
  await Promise.allSettled([...f.runtime.work]);
  assert.equal(f.runtime.protectedWork.task("agent-0", scope).status, "failed");
  assert(!f.runtime.faults.has("agent-0"));
  assert.doesNotMatch(
    JSON.stringify(f.runtime.protectedWork.task("agent-0", scope)),
    /private-provider-failure/,
  );
  f.runtime.protectedWork.update("agent-0", scope, { status: "running" });
  f.runtime.protectedWork.recover();
  assert.equal(
    f.runtime.protectedWork.task("agent-0", scope).status,
    "interrupted",
  );
  assert.equal(f.runtime.running.size, 0);
  await f.runtime.protectedWork.act({
    agentId: "agent-0",
    taskId: task.id,
    action: "cancel",
  });
  await assert.rejects(
    f.runtime.protectedWork.act({
      agentId: "agent-0",
      taskId: task.id,
      action: "run",
    }),
    /NOT_ACTIVE/,
  );
  assert.throws(
    () =>
      context(
        f.runtime,
        "agent-0",
        "@work:aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
      ),
    /NOT_ACTIVE/,
  );
  assert.equal(f.runtime.transports.get("qq-0").sent.length, 0);
});

test("daily migration retires backend context and fences stale taint while retaining progress and receipts", async (t) => {
  const f = setup(t),
    scope = "private:30000";
  const old = context(f.runtime, "agent-0", scope);
  f.m.setState(scope, {
    ...f.m.state(scope),
    session: { backend: "dsh", id: "legacy-protected-session" },
    disclosureTaint: ["operations:legacy", "github-private:fixture/private"],
    readThroughSeq: 123,
    replyBatchSends: 3,
    sendTimes: [10, 20],
    continuity: { anchors: [], recent: [f.secret.id] },
  });
  f.runtime.protectedWork.prepareDaily("agent-0", scope);
  const current = f.m.state(scope);
  assert.equal(current.session, null);
  assert.deepEqual(current.disclosureTaint, []);
  assert.equal(current.readThroughSeq, 123);
  assert.equal(current.replyBatchSends, 3);
  assert.deepEqual(current.sendTimes, [10, 20]);
  old.privateRead.add("operations:late");
  old.persistTaint();
  assert.deepEqual(f.m.state(scope).disclosureTaint, []);
  assert(old.controller.signal.aborted);
  assert.doesNotMatch(
    JSON.stringify(f.runtime.contexts.handoff("agent-0", scope)),
    /PROTECTED_WORK_SECRET/,
  );
  assert(
    f.m.identity
      .list("session_history")
      .some((r) => r.session?.id === "legacy-protected-session"),
  );
  const count = f.m.identity.list("session_history").length;
  f.runtime.protectedWork.prepareDaily("agent-0", scope);
  assert.equal(f.m.identity.list("session_history").length, count);
});

test("failed isolation archive never clears existing protection", (t) => {
  const f = setup(t),
    scope = "private:30000";
  f.m.setState(scope, {
    session: { id: "old", backend: "dsh" },
    disclosureTaint: ["operations:legacy"],
  });
  f.m.db.exec(
    "CREATE TRIGGER deny_isolation BEFORE INSERT ON session_history BEGIN SELECT RAISE(ABORT,'archive unavailable'); END;",
  );
  assert.throws(
    () => f.runtime.protectedWork.prepareDaily("agent-0", scope),
    /archive unavailable/,
  );
  assert.deepEqual(f.m.state(scope).disclosureTaint, ["operations:legacy"]);
});

test("work memory is limited to declared repositories, operations and its own task", async (t) => {
  const f = setup(t);
  const task = f.runtime.protectedWork.create({
    agentId: "agent-0",
    instruction: "repo only",
    repositories: ["fixture/private"],
  });
  const work = context(f.runtime, "agent-0", "@work:" + task.id);
  const repo = f.m.diaryWrite(
    { title: "repository", body: "allowed repository" },
    "ai-diary",
    {},
    false,
    ["fixture/private"],
  );
  const other = f.m.diaryWrite(
    { title: "repository", body: "other repository" },
    "ai-diary",
    {},
    false,
    ["fixture/other"],
  );
  const peer = f.runtime.protectedWork.create({
    agentId: "agent-0",
    instruction: "OTHER_TASK_SECRET",
  });
  const peerRow = f.m.conversation(
    { conversation: "@work:" + peer.id },
    "@work:" + peer.id,
  ).items[0];
  assert.match(
    JSON.stringify(
      await f.runtime.callTool(work, "memory_read", { id: repo.id }),
    ),
    /allowed repository/,
  );
  for (const id of [f.secret.id, other.id, peerRow.id])
    await assert.rejects(
      f.runtime.callTool(work, "memory_read", { id }),
      /RECALL_SOURCE_NOT_ALLOWED/,
    );
  const search = await f.runtime.callTool(work, "memory_search", {});
  assert.doesNotMatch(
    JSON.stringify(search),
    /PROTECTED_WORK_SECRET|OTHER_TASK_SECRET|other repository/,
  );
});

test("failed work initialization releases busy state and capability", async (t) => {
  const f = setup(t);
  const task = f.runtime.protectedWork.create({
    agentId: "agent-0",
    instruction: "initialization failure",
  });
  f.m.db.exec(
    "CREATE TRIGGER deny_model_turn BEFORE INSERT ON model_turns BEGIN SELECT RAISE(ABORT,'storage failure'); END;",
  );
  await f.runtime.protectedWork.act({
    agentId: "agent-0",
    taskId: task.id,
    action: "run",
  });
  await Promise.allSettled([...f.runtime.work]);
  assert.equal(f.runtime.running.size, 0);
  assert(
    ![...f.runtime.capabilities.values()].some(
      (c) => c.conversation === "@work:" + task.id,
    ),
  );
  assert.equal(f.runtime.transports.get("qq-0").sent.length, 0);
});

test("revoked configuration permissions cannot be restored by resuming an old work task", async (t) => {
  const f = setup(t),
    task = f.runtime.protectedWork.create({
      agentId: "agent-0",
      instruction: "repo task",
      repositories: ["fixture/private"],
    });
  f.runtime.agent("agent-0").github.privateRepositories = [];
  assert.throws(
    () => context(f.runtime, "agent-0", "@work:" + task.id),
    /NOT_ACTIVE/,
  );
  await assert.rejects(
    f.runtime.protectedWork.act({
      agentId: "agent-0",
      taskId: task.id,
      action: "run",
    }),
    /PERMISSION_DENIED/,
  );
  assert.equal(
    (
      await f.runtime.protectedWork.act({
        agentId: "agent-0",
        taskId: task.id,
        action: "cancel",
      })
    ).status,
    "cancelled",
  );
});

test("work rejects mixed sources at creation and on persisted task recovery", async (t) => {
  const f = setup(t),
    base = { agentId: "agent-0", instruction: "scope test" };
  f.runtime.agent("agent-0").github.privateRepositories.push("fixture/other");
  assert.throws(() =>
    f.runtime.protectedWork.create({
      ...base,
      repositories: ["fixture/private", "fixture/other"],
    }),
  );
  assert.throws(() =>
    f.runtime.protectedWork.create({
      ...base,
      repositories: ["fixture/private"],
      operations: true,
    }),
  );
  const task = f.runtime.protectedWork.create({ ...base, operations: true }),
    scope = "@work:" + task.id;
  await assert.rejects(
    f.runtime.callTool(context(f.runtime, "agent-0", scope), "github_read", {
      repository: "fixture/private",
    }),
    /TOOL_DISABLED/,
  );
  f.runtime.protectedWork.update("agent-0", scope, {
    repositories: ["fixture/private"],
  });
  assert.throws(() => context(f.runtime, "agent-0", scope), /NOT_ACTIVE/);
  await assert.rejects(
    f.runtime.protectedWork.act({
      agentId: "agent-0",
      taskId: task.id,
      action: "run",
    }),
    /PERMISSION_DENIED/,
  );
});
