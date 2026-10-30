import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fixture, context, temp, config } from "./helpers.mjs";
import {
  FrameworkKnowledge,
  frameworkSnapshot,
} from "../src/core/framework-knowledge.mjs";
import {
  frameworkDefinitions,
  frameworkTool,
} from "../src/tools/framework.mjs";
import { Diagnostics } from "../src/core/diagnostics.mjs";
const commit = "a".repeat(40);
const parse = (args) => frameworkDefinitions.framework_read[1].parse(args);
function source(t) {
  const root = temp(t);
  fs.mkdirSync(path.join(root, "docs"));
  fs.mkdirSync(path.join(root, "src"));
  fs.writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({ version: "1.2.3" }),
  );
  fs.writeFileSync(
    path.join(root, "docs/AGENT-FRAMEWORK.md"),
    "原始说明".repeat(1000),
  );
  fs.writeFileSync(
    path.join(root, "src/main.mjs"),
    "// public framework code\n",
  );
  const manifest = () =>
    fs.writeFileSync(
      path.join(root, "framework-build.json"),
      JSON.stringify({
        commit,
        contentDigest: frameworkSnapshot(root).contentDigest,
      }),
    );
  manifest();
  return { root, manifest };
}

test("framework tools are built in for all three backends, including idle time but not protected work", async (t) => {
  for (const type of ["codex", "dsh", "openai"]) {
    const cfg = config(1);
    cfg.backends[0].type = type;
    if (type === "openai")
      cfg.backends[0].baseUrl = "https://api.example.invalid/v1";
    const f = fixture(t, { cfg }),
      ctx = context(f.runtime);
    for (const conversation of [ctx.conversation, "@subject"])
      for (const name of Object.keys(frameworkDefinitions))
        assert.ok(
          f.runtime
            .toolsFor(f.runtime.agent(ctx.agentId), conversation)
            .includes(name),
        );
    f.runtime.framework = new FrameworkKnowledge({
      ...source(t),
      fetchImpl: () => {
        throw Error("offline");
      },
    });
    const info = await f.runtime.callTool(ctx, "deployment_info", {});
    assert.equal(info.backend.type, type);
    assert.equal(info.version.commit, commit);
    assert.ok(info.tools.includes("framework_read"));
    assert.equal(info.version.provenance, "verified-build-manifest");
    assert.ok(
      (
        await f.runtime.callTool(ctx, "framework_read", {
          path: "docs/AGENT-FRAMEWORK.md",
        })
      ).text.startsWith("原始说明"),
    );
    assert.ok(
      !f.runtime.protectedWork
        .tools(f.runtime.agent(ctx.agentId), "@work:missing")
        .includes("framework_read"),
    );
  }
});

test("offline local documents are paginated snapshots and mismatched build metadata becomes unknown", async (t) => {
  const s = source(t),
    knowledge = new FrameworkKnowledge(s),
    ctx = { agentId: "one" };
  const first = await knowledge.read(
    ctx,
    parse({ path: "docs/AGENT-FRAMEWORK.md", maxChars: 512 }),
  );
  fs.writeFileSync(
    path.join(s.root, "docs/AGENT-FRAMEWORK.md"),
    "changed after startup",
  );
  const next = await knowledge.read(
    ctx,
    parse({ path: first.path, offset: first.nextOffset }),
  );
  assert.equal(first.text + next.text, "原始说明".repeat(1000));
  assert.equal(first.contentHash, next.contentHash);
  const changed = new FrameworkKnowledge(s);
  assert.equal(changed.version.commit, null);
  assert.equal(changed.version.provenance, "unknown");
  assert.equal((await changed.read(ctx, parse({}))).recommended, first.path);
  await assert.rejects(
    changed.read(ctx, parse({ path: first.path, source: "official" })),
    /FRAMEWORK_VERSION_UNKNOWN/,
  );
});

test("catalog denies runtime files, traversal, URLs and symlink escapes before network access", async (t) => {
  const s = source(t);
  fs.mkdirSync(path.join(s.root, ".runtime"));
  fs.writeFileSync(
    path.join(s.root, ".runtime/secrets.json"),
    "private-sentinel",
  );
  if (process.platform !== "win32")
    fs.symlinkSync(
      path.join(s.root, ".runtime"),
      path.join(s.root, "docs/escape"),
    );
  let calls = 0;
  const knowledge = new FrameworkKnowledge({
    ...s,
    fetchImpl: () => {
      calls++;
    },
  });
  for (const bad of [
    "../package.json",
    ".runtime/secrets.json",
    "docs/escape/secrets.json",
    "https://example.com/private",
    "docs/../package.json",
    "docs/secret-query.md",
  ])
    await assert.rejects(
      knowledge.read(
        { agentId: "one" },
        parse({ path: bad, source: "official", ref: "main" }),
      ),
      /FRAMEWORK_PATH_DENIED/,
    );
  assert.equal(calls, 0);
  assert.ok(
    !JSON.stringify(await knowledge.read({}, parse({}))).includes(
      "private-sentinel",
    ),
  );
});

test("nested release directories do not inherit a parent repository commit", (t) => {
  const parent = temp(t);
  execFileSync("git", ["init", parent], { stdio: "ignore" });
  execFileSync(
    "git",
    [
      "-C",
      parent,
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.invalid",
      "commit",
      "--allow-empty",
      "-m",
      "fixture",
    ],
    { stdio: "ignore" },
  );
  const root = path.join(parent, "release");
  fs.mkdirSync(root);
  fs.writeFileSync(path.join(root, "package.json"), '{"version":"1.0.0"}');
  assert.equal(new FrameworkKnowledge({ root }).version.commit, null);
});

test("official reads use only fixed public URLs without credentials, distinguish main and preserve pagination", async (t) => {
  const s = source(t),
    requests = [],
    body = "upstream".repeat(200);
  const knowledge = new FrameworkKnowledge({
    ...s,
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return new Response(body);
    },
  });
  const ctx = { agentId: "one" };
  const first = await knowledge.read(
    ctx,
    parse({ path: "src/main.mjs", source: "official", maxChars: 512 }),
  );
  const next = await knowledge.read(
    ctx,
    parse({ path: first.path, source: "official", offset: first.nextOffset }),
  );
  assert.equal(first.text + next.text, body);
  assert.equal(requests.length, 1);
  assert.equal(
    requests[0].url,
    `https://raw.githubusercontent.com/wangyufengsky/qq-agents/${commit}/src/main.mjs`,
  );
  assert.equal(requests[0].options.redirect, "error");
  assert.equal(requests[0].options.credentials, "omit");
  assert.deepEqual(Object.keys(requests[0].options.headers), ["accept"]);
  const latest = await knowledge.read(
    ctx,
    parse({ path: first.path, source: "official", ref: "main" }),
  );
  assert.equal(latest.ref, "main");
  assert.match(latest.notice, /不代表本机已安装/);
  assert.equal(latest.installed.commit, commit);
});

test("official reads enforce per-turn/day budgets and response limits while keeping offline help available", async (t) => {
  const s = source(t);
  for (let i = 0; i < 61; i++)
    fs.writeFileSync(path.join(s.root, `docs/test-${i}.md`), "local");
  s.manifest();
  const knowledge = new FrameworkKnowledge({
    ...s,
    fetchImpl: async () => new Response("ok"),
  });
  const request = (i) =>
    parse({ path: `docs/test-${i}.md`, source: "official" });
  const ctx = { agentId: "one" };
  for (let i = 0; i < 4; i++) await knowledge.read(ctx, request(i));
  await assert.rejects(
    knowledge.read(ctx, request(4)),
    /FRAMEWORK_READ_BUDGET/,
  );
  for (let i = 4; i < 60; i++)
    await knowledge.read({ agentId: "one" }, request(i));
  await assert.rejects(
    knowledge.read({ agentId: "one" }, request(60)),
    /FRAMEWORK_READ_BUDGET/,
  );
  assert.equal(
    (await knowledge.read(ctx, parse({ path: "docs/test-60.md" }))).text,
    "local",
  );
  await assert.rejects(
    knowledge.read(ctx, parse({ ...request(0), offset: 10 })),
    /FRAMEWORK_READ_FROM_START/,
  );
  const huge = new FrameworkKnowledge({
    ...s,
    fetchImpl: async () => new Response("x".repeat(524289)),
  });
  await assert.rejects(
    huge.read({ agentId: "one" }, request(0)),
    /FRAMEWORK_RESPONSE_TOO_LARGE/,
  );
  const offline = new FrameworkKnowledge({
    ...s,
    fetchImpl: async () => {
      throw Error("secret upstream failure");
    },
  });
  await assert.rejects(offline.read({ agentId: "one" }, request(0)), {
    message: "FRAMEWORK_UPSTREAM_UNAVAILABLE",
  });
});

test("diagnostics reveal only own current scope, stable codes and no configuration or chat content", async (t) => {
  const f = fixture(t),
    ctx = context(f.runtime);
  f.runtime.diagnostics = new Diagnostics({ write() {} });
  f.runtime.config.backends[0].baseUrl =
    "https://secret-endpoint.example.invalid";
  f.runtime.backendConnections.state("fixture").error =
    "private exception with credential";
  f.runtime.diagnostics.report(Error("CODEX_DISCONNECTED"), {
    agentId: ctx.agentId,
    conversation: ctx.conversation,
  });
  f.runtime.diagnostics.report(Error("DATABASE_UNAVAILABLE"), {
    agentId: "agent-1",
    conversation: ctx.conversation,
  });
  f.runtime.diagnostics.report(Error("SYSTEM_IO_ERROR"), {
    agentId: ctx.agentId,
    conversation: "private:55555",
  });
  f.runtime.transports.get("qq-0").connected = false;

  const before = JSON.stringify(f.runtime.config);
  const result = await f.runtime.callTool(ctx, "diagnostics_read", {});
  assert.deepEqual(
    result.recentErrors.map((e) => e.code),
    ["CODEX_DISCONNECTED"],
  );
  assert.equal(result.backend.error, "BACKEND_PROBE_FAILED");
  assert.equal(result.connection.connected, false);
  f.runtime.config.globalPaused = true;
  assert.ok(
    frameworkTool(f.runtime, ctx, "diagnostics_read", {}).blockers.includes(
      "GLOBAL_PAUSED",
    ),
  );
  f.runtime.config.globalPaused = false;
  for (const secret of [
    "secret-endpoint",
    "private exception",
    "agent-1",
    "55555",
    "httpUrl",
    "apiKey",
    "databasePath",
  ])
    assert.ok(!JSON.stringify(result).includes(secret));
  assert.equal(JSON.stringify(f.runtime.config), before);
  assert.equal(f.runtime.transports.get("qq-0").sent.length, 0);
});
