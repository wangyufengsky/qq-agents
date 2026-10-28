import test from "node:test";
import assert from "node:assert/strict";
import { config, fixture, context } from "./helpers.mjs";
import { AppBrowsing } from "../src/apps/service.mjs";
import { safeToolFailure } from "../src/tools/errors.mjs";
import { APP_LEDGER } from "../src/apps/policy.mjs";

const scope = "@subject";
const marker = "github-private:fixture/private";
const browse = { platform: "heybox", entry: "recommend" };
const search = {
  serverId: "exa",
  tool: "web_search_exa",
  arguments: { query: "public games" },
};
function setup(t, run, mode = "fresh") {
  const cfg = config(1),
    a = cfg.agents[0];
  a.subject.enabled = true;
  a.subject.sessionMode = mode;
  a.subject.externalReads = [{ serverId: search.serverId, tool: search.tool }];
  const names = [
    "app_capabilities",
    "app_browse",
    "external_tools",
    "external_tool",
  ];
  a.tools.push(...names);
  a.subject.readTools = names;
  a.network.autonomous = true;
  a.apps.enabled = true;
  a.apps.platforms = ["heybox"];
  a.apps.hours.enabled = false;
  cfg.backends[0].toolServers = [
    {
      id: "exa",
      transport: "http",
      url: "https://mcp.exa.ai/mcp",
      allowedTools: [search.tool],
    },
  ];
  const f = fixture(t, { cfg, run });
  const calls = [];
  f.runtime.apps = new AppBrowsing(f.runtime, {
    adapter: {
      capabilities: () => [
        { platform: "heybox", probe: { read: { ok: true } } },
      ],
      perform: async (job) => {
        calls.push(job);
        return { items: [], coverage: "listing" };
      },
    },
  });
  f.runtime.backends.set("agent-0", {
    run,
    cancel: async () => {},
    close: async () => {},
    external: {
      list: async () => ({
        servers: [{ id: "exa", tools: [{ name: search.tool }] }],
      }),
      call: async (...args) => {
        calls.push(args);
        return { content: [{ type: "text", text: "public result" }] };
      },
    },
  });
  return { ...f, m: f.store.bind("agent-0"), calls };
}

test("fresh subject starts without old protected handoff and can browse without losing stored records or budgets", async (t) => {
  let received;
  const f = setup(t, async (p) => {
    received = p;
    await p.callTool("app_browse", browse);
    await p.callTool("external_tool", search);
  });
  const old = context(f.runtime, "agent-0", scope);
  old.privateRead.add(marker);
  old.persistTaint();
  const log = f.m.append({
    dedupe: "protected-log",
    conversation: scope,
    kind: "subject.log",
    body: "PRIVATE_LOG",
    payload: {
      summary: "PRIVATE_LOG",
      did: "read",
      protectedRepositories: ["fixture/private"],
    },
  });
  const diary = f.m.diaryWrite(
    { title: "PRIVATE_TITLE", body: "PRIVATE_BODY" },
    "ai-diary",
    {},
    false,
    ["fixture/private"],
  );
  f.m.identity.saveNote(
    { body: "PRIVATE_NOTE", evidence: [log.id], uncertainty: "unverified" },
    scope,
    f.runtime.now(),
  );
  f.m.identity.put("intentions", {
    id: "private-intent",
    target: "group:20000",
    status: "completed",
    topic: "PRIVATE_INTENT",
    evidence: [],
    history: [{ status: "completed", reason: "PRIVATE_CONTACT" }],
    protectedRepositories: ["fixture/private"],
  });
  const checks = [Date.now() - 1000];
  f.m.setState(scope, {
    ...f.m.state(scope),
    session: { id: "old-subject", backend: "fixture" },
    checks,
    contacts: checks,
    activityCursor: 12,
    continuity: { anchors: [log.id], recent: [] },
  });
  await f.runtime.wake("agent-0", scope);
  assert.equal(f.calls.length, 2);
  assert.equal(received.session ?? null, null);
  assert.doesNotMatch(
    received.prompt,
    /PRIVATE_(LOG|TITLE|BODY|NOTE|INTENT|CONTACT)/,
  );
  assert.deepEqual(f.m.state(scope).checks, checks);
  assert.deepEqual(f.m.state(scope).contacts, checks);
  assert.equal(f.m.state(scope).activityCursor, 12);
  assert(f.m.readRecord({ id: diary.id }).protectedRepositories.length);
  assert(
    f.m.identity
      .list("session_history")
      .some((h) => h.session?.id === "old-subject"),
  );
  assert(
    f.m.identity
      .list("session_history")
      .some((h) => h.disclosureTaint?.includes(marker)),
  );
  const beforeLateWrite = f.m.state(scope).disclosureTaint;
  old.persistTaint();
  assert.deepEqual(f.m.state(scope).disclosureTaint, beforeLateWrite);
  assert(!f.m.state(scope).disclosureTaint.includes(marker));
});

test("explicit protected subject recall permits fixed feeds but blocks queries; the next fresh turn has its own sources", async (t) => {
  let turn = 0,
    diary;
  const f = setup(t, async (p) => {
    turn++;
    if (turn === 1) {
      await assert.rejects(
        p.callTool("memory_read", { id: diary.id }),
        /RECALL_SOURCE_NOT_ALLOWED/,
      );
      await p.callTool("app_browse", browse);
      await p.callTool("external_tool", search);
      await p.callTool("subject_log", {
        did: "read",
        summary: "ORDINARY_NEW_LOG",
      });
    } else {
      assert.doesNotMatch(p.prompt, /PRIVATE_NEW_LOG/);
      await p.callTool("app_browse", browse);
    }
    p.saveSession({ id: "subject-" + turn, backend: "fixture" });
  });
  diary = f.m.diaryWrite(
    { title: "protected", body: "PRIVATE_BODY" },
    "ai-diary",
    {},
    false,
    ["fixture/private"],
  );
  await f.runtime.wake("agent-0", scope);
  assert(!f.m.state(scope).disclosureTaint.includes(marker));
  await f.runtime.wake("agent-0", scope);
  assert.equal(f.calls.length, 3);
  assert(!f.m.state(scope).disclosureTaint.includes(marker));
});

test("continuous subject sessions retain protection", async (t) => {
  const f = setup(
    t,
    async (p) => {
      await p.callTool("app_browse", browse);
      await p.callTool("external_tool", search);
    },
    "continuous",
  );
  f.m.setState(scope, { disclosureTaint: [marker] });
  await f.runtime.wake("agent-0", scope);
  assert.equal(f.calls.length, 2);
  assert(!f.m.state(scope).disclosureTaint.includes(marker));
});

test("external tool argument errors are validated before the subject read allowlist", async (t) => {
  const f = setup(t, async () => {}),
    ctx = context(f.runtime, "agent-0", scope);
  await assert.rejects(
    f.runtime.callTool(ctx, "external_tool", {
      name: search.tool,
      arguments: search.arguments,
    }),
    (e) => {
      const error = safeToolFailure(e);
      assert.equal(error.code, "INVALID_TOOL_ARGUMENTS");
      assert(error.issues.some((x) => x.field === "serverId"));
      assert(error.issues.some((x) => x.field === "tool"));
      return true;
    },
  );
  await assert.rejects(
    f.runtime.callTool(ctx, "external_tool", { ...search, tool: "write" }),
    /SUBJECT_EXTERNAL_TOOL_NOT_READ_ALLOWED/,
  );
  await f.runtime.callTool(ctx, "external_tool", search);
  assert.equal(f.calls.length, 1);
});

test("capabilities distinguish successful platform probes from a restricted current context", async (t) => {
  const f = setup(t, async () => {}),
    ctx = context(f.runtime, "agent-0", scope);
  ctx.privateRead.add(marker);
  const result = await f.runtime.callTool(ctx, "app_capabilities", {});
  assert.equal(result.platforms[0].probe.read.ok, true);
  assert.equal(result.contextGate.allowed, false);
  assert.equal(result.contextGate.code, "APP_RESTRICTED_CONTEXT");
  assert.equal(result.fixedPublicReads.allowed, true);
  assert.equal(f.calls.length, 0);
});

for (const session of [null, { id: "prior-subject", backend: "fixture" }]) {
  test(`failed fresh-context archival preserves protection (${session ? "session" : "no session"})`, async (t) => {
    let runs = 0;
    const f = setup(t, async () => {
      runs++;
    });
    f.m.setState(scope, { session, disclosureTaint: [marker], checks: [123] });
    f.m.db.exec(
      "CREATE TRIGGER fail_subject_archive BEFORE INSERT ON session_history WHEN json_extract(new.value,'$.reason') IN ('subject-fresh-context','protected-work-isolation') BEGIN SELECT RAISE(ABORT,'archive unavailable'); END;",
    );
    await assert.rejects(
      f.runtime.wake("agent-0", scope),
      /archive unavailable/,
    );
    assert.equal(runs, 0);
    assert.equal(f.calls.length, 0);
    assert.deepEqual(f.m.state(scope).disclosureTaint, [marker]);
    assert.deepEqual(f.m.state(scope).checks, [123]);
  });
}

test("fresh contexts preserve daily platform budgets and context capability checks spend nothing", async (t) => {
  const f = setup(t, async (p) => {
    await p.callTool("app_capabilities", {});
    await assert.rejects(p.callTool("app_browse", browse), /APP_READ_BUDGET/);
  });
  const calls = Array(f.runtime.agent("agent-0").apps.maxReadsPerDay).fill(
    Date.now(),
  );
  f.m.setState(APP_LEDGER, { calls });
  f.m.setState(scope, { disclosureTaint: [marker] });
  await f.runtime.wake("agent-0", scope);
  assert.equal(f.calls.length, 0);
  assert.deepEqual(f.m.state(APP_LEDGER).calls, calls);
  assert.equal(f.runtime.faults.size, 0);
});

test("subject external catalog supplies the exact configured selector shape", async (t) => {
  const f = setup(t, async () => {}),
    ctx = context(f.runtime, "agent-0", scope);
  const list = await f.runtime.callTool(ctx, "external_tools", {});
  assert.deepEqual(list.subjectReadAllowlist, [
    { serverId: "exa", tool: search.tool },
  ]);
  assert.deepEqual(Object.keys(list.callFormat.arguments), [
    "serverId",
    "tool",
    "arguments",
  ]);
  assert.equal(f.calls.length, 0);
});
