import test from "node:test";
import assert from "node:assert/strict";
import { config, fixture, context } from "./helpers.mjs";
import { ConfigStore } from "../src/core/config.mjs";
import { scopedCatalog } from "../src/tools/catalog.mjs";
import { privateGithubSources } from "../src/github/policy.mjs";
import { freezeEvidence } from "../src/memory/evidence.mjs";
import { FileStore } from "../src/tools/files.mjs";
import path from "node:path";

const repo = "fixture/framework",
  other = "fixture/other",
  owner = "30000";
const tools = [
  "github_capabilities",
  "github_search",
  "github_read",
  "web_fetch",
];
const json = (data, status = 200, headers) =>
  new Response(JSON.stringify(data), { status, headers });
function setup(t) {
  const cfg = config(2);
  for (const a of cfg.agents) {
    a.tools.push(...tools);
    a.ownerIds = [owner];
    a.network.autonomous = true;
    a.github = {
      enabled: true,
      tokenEnv: "QQ_GITHUB_TEST_TOKEN",
      privateRepositories: [repo],
    };
  }
  process.env.QQ_GITHUB_TEST_TOKEN = "fixture-read-token";
  t.after(() => {
    delete process.env.QQ_GITHUB_TEST_TOKEN;
  });
  const f = fixture(t, { cfg }),
    calls = [];
  f.runtime.githubFetch = async (url, init) => {
    const u = new URL(url);
    calls.push({ url: u, ...init });
    if (u.pathname === `/repos/${repo}`)
      return init.headers.Authorization
        ? json({ full_name: repo, private: true })
        : json({}, 404);
    if (u.pathname === `/repos/${other}`)
      return json({ full_name: other, private: true });
    if (u.pathname === "/repos/public/demo")
      return json({ full_name: "public/demo", private: false });
    if (u.pathname === `/repos/${repo}/contents/README.md`)
      return json({
        type: "file",
        sha: "abc",
        size: 6000,
        encoding: "base64",
        content: Buffer.from("framework-private-text ".repeat(300)).toString(
          "base64",
        ),
      });
    if (u.pathname === `/repos/${repo}/contents/`)
      return json([
        { name: "README.md", path: "README.md", type: "file", size: 6000 },
      ]);
    if (u.pathname === "/search/repositories")
      return json({
        incomplete_results: false,
        items: [
          {
            full_name: "public/demo",
            description: "public repository",
            private: false,
          },
          { full_name: other, description: "must not leak", private: true },
        ],
      });
    if (u.pathname === "/search/code")
      return json({
        incomplete_results: true,
        items: [
          { repository: { full_name: repo }, path: "README.md", sha: "abc" },
        ],
      });
    throw Error("UNEXPECTED_FIXTURE_REQUEST");
  };
  return {
    ...f,
    calls,
    ctx: context(f.runtime, "agent-0", `private:${owner}`),
  };
}
test("GitHub is opt-in, persists per agent, and exposes only read tools", async (t) => {
  assert.equal(config(1).agents[0].github.enabled, false);
  const f = setup(t);
  assert.deepEqual(
    new ConfigStore(f.configStore.file).value.agents[0].github
      .privateRepositories,
    [repo],
  );
  const catalog = scopedCatalog(f.runtime, f.ctx, { names: tools.slice(0, 3) });
  assert.deepEqual(
    catalog.tools.map((x) => x.name),
    tools.slice(0, 3),
  );
  const caps = await f.runtime.callTool(f.ctx, "github_capabilities");
  assert.equal(caps.readOnly, true);
  assert.deepEqual(caps.privateRepositories, [repo]);
  f.runtime.agent("agent-1").github.enabled = false;
  await assert.rejects(
    f.runtime.callTool(context(f.runtime, "agent-1"), "github_search", {
      query: "code",
    }),
    /TOOL_DISABLED/,
  );
  await assert.rejects(
    f.runtime.callTool(f.ctx, "github_push", {}),
    /TOOL_DISABLED/,
  );
  assert.equal(f.calls.length, 0);
});
test("public search excludes private results and never grants arbitrary endpoints", async (t) => {
  const f = setup(t);
  const r = await f.runtime.callTool(f.ctx, "github_search", {
    query: "assistant",
  });
  assert.deepEqual(
    r.items.map((x) => x.repository),
    ["public/demo"],
  );
  assert.ok(!JSON.stringify(r).includes("must not leak"));
  assert.equal(f.calls[0].url.searchParams.get("q"), "assistant is:public");
  assert.ok(
    f.calls.every(
      (x) =>
        x.method === "GET" &&
        x.redirect === "error" &&
        x.url.origin === "https://api.github.com",
    ),
  );
  assert.ok(f.calls.slice(1).every((x) => !x.headers.Authorization));
  const before = f.calls.length;
  for (const query of [
    "repo:fixture/other",
    "a OR is:private",
    "a user:fixture",
  ])
    await assert.rejects(f.runtime.callTool(f.ctx, "github_search", { query }));
  await assert.rejects(
    f.runtime.callTool(f.ctx, "github_search", {
      query: "x",
      url: "https://example.org",
    }),
  );
  assert.equal(f.calls.length, before);
});
test("private files are bounded, allowlisted, owner-scoped, and protected across continuation", async (t) => {
  const f = setup(t);
  await assert.rejects(
    f.runtime.callTool(f.ctx, "github_read", { repository: other }),
    /REPOSITORY_DENIED/,
  );
  assert.equal(f.calls.at(-1).headers.Authorization, undefined);
  await assert.rejects(
    f.runtime.callTool(context(f.runtime), "github_read", { repository: repo }),
    /ACCESS_DENIED/,
  );
  assert.equal(f.calls.at(-1).headers.Authorization, undefined);
  const r = await f.runtime.callTool(f.ctx, "github_read", {
    repository: repo,
    path: "README.md",
    maxChars: 512,
  });
  assert.equal(r.text.length, 512);
  assert.equal(r.nextOffset, 512);
  assert.equal(r.private, true);
  assert.deepEqual(privateGithubSources(f.ctx, f.runtime), [repo]);
  const resumed = context(f.runtime, "agent-0", `private:${owner}`);
  const next = await f.runtime.callTool(resumed, "github_read", {
    repository: repo,
    path: "README.md",
    offset: r.nextOffset,
    maxChars: 512,
  });
  assert.equal(next.nextOffset, 1024);
  assert.ok(!JSON.stringify(next).includes(process.env.QQ_GITHUB_TEST_TOKEN));
  assert.doesNotThrow(() => f.runtime.assertDisclosure(resumed));
  assert.throws(
    () =>
      f.runtime.authorizeExternal(
        resumed,
        { tool: "web_fetch", args: { url: "https://example.org" } },
        { fixed: true },
      ),
    /EXTERNAL_CALL_BLOCKED/,
  );
  await assert.rejects(
    f.runtime.callTool(resumed, "github_search", {
      query: "framework-private-text",
    }),
    /EXTERNAL_CALL_BLOCKED/,
  );
  await assert.rejects(
    f.runtime.callTool(resumed, "self_propose", {
      body: "private code",
      reason: "reason",
      evidence: [r.sourceRecordId],
      scope: "interest",
      expectedVersion: 1,
    }),
    /RESTRICTED_CONTEXT_MIND_WRITE_BLOCKED/,
  );
});
test("private read results, diaries, revisions and remembered owner replies retain the boundary", async (t) => {
  const f = setup(t);
  const r = await f.runtime.callTool(f.ctx, "github_read", {
    repository: repo,
    path: "README.md",
  });
  const diary = await f.runtime.callTool(f.ctx, "diary_write", {
    title: "framework",
    body: "private framework notes",
  });
  const group = context(f.runtime);
  await f.runtime.callTool(group, "memory_read", { id: diary.id });
  assert.throws(() => f.runtime.assertDisclosure(group), /DISCLOSURE_GRANT/);
  const fresh = context(f.runtime, "agent-0", "group:20001");
  await f.runtime.callTool(fresh, "memory_search", {
    query: "framework",
    maxChars: 512,
  });
  assert.throws(() => f.runtime.assertDisclosure(fresh), /DISCLOSURE_GRANT/);
  const memory = f.store.bind("agent-0");
  memory.diaryRevise({
    id: diary.id,
    expectedRevision: 1,
    title: "revised",
    body: "notes",
  });
  assert.deepEqual(memory.read({ id: diary.id }).protectedRepositories, [repo]);
  const legacy = context(f.runtime, "agent-0", "group:20001");
  legacy.privateRead = new Set([r.sourceRecordId]);
  assert.throws(() => f.runtime.assertDisclosure(legacy), /DISCLOSURE_GRANT/);
  const fakeReply = memory.append({
    dedupe: "private-reply",
    conversation: `private:${owner}`,
    kind: "message.sent",
    direction: "out",
    status: "confirmed",
    body: "framework summary",
    payload: { protectedRepositories: [repo] },
  });
  const recalled = context(f.runtime, "agent-0", "group:20001");
  await f.runtime.callTool(recalled, "memory_read", { id: fakeReply.id });
  assert.throws(
    () =>
      f.runtime.authorizeExternal(recalled, {
        tool: "web_fetch",
        args: { url: "https://example.org" },
      }),
    /EXTERNAL_CALL_BLOCKED/,
  );
  assert.throws(
    () => freezeEvidence(memory, [r.sourceRecordId]),
    /RESTRICTED_EVIDENCE/,
  );
});
test("paths, errors, response size, budgets and permission revocation fail closed", async (t) => {
  const f = setup(t);
  for (const path of ["../secret", "/etc/passwd", "a/../b", "a\\b"])
    await assert.rejects(
      f.runtime.callTool(f.ctx, "github_read", { repository: repo, path }),
      /PATH_INVALID/,
    );
  assert.equal(f.calls.length, 0);
  f.runtime.githubFetch = async () =>
    json({ message: "fixture-read-token must not appear" }, 429);
  await assert.rejects(
    f.runtime.callTool(f.ctx, "github_read", { repository: repo }),
    (e) => e.message === "GITHUB_RATE_LIMITED",
  );
  f.runtime.githubFetch = async () =>
    new Response("x".repeat(2 * 1024 * 1024 + 1));
  await assert.rejects(
    f.runtime.callTool(f.ctx, "github_read", { repository: repo }),
    /RESPONSE_TOO_LARGE/,
  );
  f.ctx.githubRequests = 15;
  await assert.rejects(
    f.runtime.callTool(f.ctx, "github_read", { repository: repo }),
    /BUDGET_EXHAUSTED/,
  );
  f.ctx.githubRequests = 0;
  f.runtime.githubFetch = async () => {
    f.runtime.agent("agent-0").github = {
      ...f.runtime.agent("agent-0").github,
      enabled: false,
    };
    return json({ full_name: repo, private: true });
  };
  await assert.rejects(
    f.runtime.callTool(f.ctx, "github_read", { repository: repo }),
    /RESPONSE_INVALID|CONFIGURATION_CHANGED/,
  );
});

test("private GitHub records cannot escape through saved files or download URLs", async (t) => {
  const f = setup(t),
    a = f.runtime.agent("agent-0");
  a.files.enabled = a.files.create = a.files.download = a.files.send = true;
  a.tools.push("file_create", "file_download", "qq_send_file");
  f.runtime.files = new FileStore(path.join(f.root, "files"));
  const read = await f.runtime.callTool(f.ctx, "github_read", {
    repository: repo,
    path: "README.md",
  });
  const restored = context(f.runtime, "agent-0", `private:${owner}`);
  restored.privateRead = new Set([read.sourceRecordId]);
  const file = await f.runtime.callTool(restored, "file_create", {
    name: "framework.txt",
    text: "private framework notes",
  });
  assert.deepEqual(
    f.runtime.files.metadata(a.id, file.fileId).protectedRepositories,
    [repo],
  );
  await assert.rejects(
    f.runtime.callTool(restored, "file_download", {
      url: "https://example.org/private-framework-notes",
    }),
    /EXTERNAL_CALL_BLOCKED/,
  );
  await assert.rejects(
    f.runtime.callTool(context(f.runtime), "qq_send_file", {
      requestId: "blocked-file",
      fileId: file.fileId,
    }),
    /DISCLOSURE_GRANT/,
  );
  assert.equal(f.runtime.transports.get("qq-0").sent.length, 0);
});

test("a public allowlisted repository becoming private cannot leak through authenticated content reads", async (t) => {
  const f = setup(t);
  let anonymousContent = false;
  f.runtime.githubFetch = async (url, init) => {
    if (new URL(url).pathname === `/repos/${repo}`)
      return json({ full_name: repo, private: false });
    anonymousContent = !init.headers.Authorization;
    return anonymousContent
      ? json({}, 404)
      : json({
          type: "file",
          size: 12,
          encoding: "base64",
          content: Buffer.from("private-code").toString("base64"),
        });
  };
  await assert.rejects(
    f.runtime.callTool(f.ctx, "github_read", {
      repository: repo,
      path: "README.md",
    }),
    /ACCESS_DENIED/,
  );
  assert.equal(anonymousContent, true);
});
