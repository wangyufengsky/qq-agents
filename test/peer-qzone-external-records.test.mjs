import test from "node:test";
import assert from "node:assert/strict";
import { config, fixture, context, disclosureApproval } from "./helpers.mjs";
import { AppBrowsing } from "../src/apps/service.mjs";

const secret = "PEER_EXTERNAL_ECHO_TEXT";
const own = "private:30000";
function setup(t) {
  const cfg = config(1),
    a = cfg.agents[0];
  a.tools.push(
    "web_fetch",
    "github_search",
    "app_record",
    "app_browse",
    "app_history",
  );
  a.network.autonomous = true;
  a.github.enabled = true;
  a.github.tokenEnv = "QQ_GITHUB_PEER_ECHO_TEST_TOKEN";
  a.apps.enabled = true;
  a.apps.platforms = ["heybox"];
  a.apps.hours.enabled = false;
  const f = fixture(t, { cfg });
  return {
    ...f,
    m: f.store.bind("agent-0"),
    ctx: context(f.runtime, "agent-0", own),
  };
}
async function approved(f, name, args) {
  f.ctx.privateRead.add("peer-qzone:30000");
  await assert.rejects(
    f.runtime.callTool(f.ctx, name, args),
    /EXTERNAL_CALL_BLOCKED/,
  );
  f.runtime.grant(disclosureApproval(f.ctx));
  return f.runtime.callTool(f.ctx, name, args);
}
async function protectedRecord(f, id) {
  const row = f.m.db.prepare("SELECT payload FROM events WHERE id=?").get(id);
  assert.deepEqual(JSON.parse(row.payload).protectedPeerQzoneTargets, [
    "30000",
  ]);
  const group = context(f.runtime);
  await assert.rejects(
    f.runtime.callTool(group, "memory_read", { id }),
    /RECALL_SOURCE_NOT_ALLOWED/,
  );
  const search = await f.runtime.callTool(group, "memory_search", {
    query: secret,
  });
  assert.doesNotMatch(JSON.stringify(search), new RegExp(secret));
  return JSON.parse(row.payload);
}

test("a precisely approved web response that echoes a private query stays owner-only in memory", async (t) => {
  const f = setup(t);
  f.runtime.fetchPublicPage = async (url) => ({
    url,
    title: secret,
    text: secret,
  });
  const result = await approved(f, "web_fetch", {
    url: "https://example.invalid/?q=" + secret,
  });
  await protectedRecord(f, result.sourceRecordId);
});

test("a precisely approved public GitHub search response inherits the query's peer provenance", async (t) => {
  const f = setup(t);
  const previous = process.env.QQ_GITHUB_PEER_ECHO_TEST_TOKEN;
  process.env.QQ_GITHUB_PEER_ECHO_TEST_TOKEN = "fixture-read-token";
  t.after(() => {
    if (previous === undefined)
      delete process.env.QQ_GITHUB_PEER_ECHO_TEST_TOKEN;
    else process.env.QQ_GITHUB_PEER_ECHO_TEST_TOKEN = previous;
  });
  f.runtime.githubFetch = async (url) => {
    if (new URL(url).pathname === "/repos/public/demo")
      return new Response(
        JSON.stringify({ full_name: "public/demo", private: false }),
      );
    return new Response(
      JSON.stringify({
        incomplete_results: false,
        items: [
          { full_name: "public/demo", private: false, description: secret },
        ],
      }),
    );
  };
  const result = await approved(f, "github_search", { query: secret });
  assert.equal(result.items[0].description, secret);
  const payload = await protectedRecord(f, result.sourceRecordId);
  assert.deepEqual(payload.protectedRepositories || [], []);
});

test("dynamic App records retain context provenance through local reads and history", async (t) => {
  const f = setup(t),
    service = new AppBrowsing(f.runtime);
  f.runtime.apps = service;
  f.ctx.privateRead.add("peer-qzone:30000");
  const result = service.record(f.ctx, {
    platform: "heybox",
    origin: "app-browser",
    ok: true,
    title: secret,
    text: secret,
    url: "https://www.xiaoheihe.cn/app/bbs/link/123456",
  });
  await protectedRecord(f, result.recordId);
  const ownResult = await f.runtime.callTool(f.ctx, "app_record", {
    recordId: result.recordId,
  });
  assert.equal(ownResult.title, secret);
  const group = context(f.runtime);
  await assert.rejects(
    f.runtime.callTool(group, "app_record", { recordId: result.recordId }),
    /RECALL_SOURCE_NOT_ALLOWED/,
  );
  await assert.rejects(
    f.runtime.callTool(group, "app_history", {}),
    /RECALL_SOURCE_NOT_ALLOWED/,
  );
});

test("server-validated fixed App feeds remain independent public records after private recall", async (t) => {
  const f = setup(t);
  f.runtime.apps = new AppBrowsing(f.runtime, {
    adapter: {
      capabilities: () => [],
      perform: async () => ({
        items: [
          {
            url: "https://www.xiaoheihe.cn/app/bbs/link/123456",
            title: "independent public feed",
            text: "public body",
          },
        ],
        next: null,
        coverage: "article",
      }),
    },
  });
  f.ctx.privateRead.add("peer-qzone:30000");
  const page = await f.runtime.callTool(f.ctx, "app_browse", {
    platform: "heybox",
    entry: "recommend",
    limit: 1,
  });
  const id = page.items[0].recordId;
  const payload = JSON.parse(
    f.m.db.prepare("SELECT payload FROM events WHERE id=?").get(id).payload,
  );
  assert.equal(payload.protectedPeerQzoneTargets, undefined);
  const result = await f.runtime.callTool(context(f.runtime), "app_record", {
    recordId: id,
  });
  assert.equal(result.title, "independent public feed");
});
