import test from "node:test";
import assert from "node:assert/strict";
import {
  config,
  fixture,
  context,
  disclosureApproval,
  FakeTransport,
} from "./helpers.mjs";
import { OneBot } from "../src/transport/onebot.mjs";

const name = "qq_peer_qzone_read";
const person = "30000";
const own = `private:${person}`;
const group = "group:20000";
function setup(t) {
  const cfg = config(1);
  cfg.agents[0].allow.users.push("30001");
  cfg.agents[0].behavior.actions.peerQzone = true;
  cfg.agents[0].tools.push(name);
  const f = fixture(t, { cfg });
  const transport = f.runtime.transports.get("qq-0"),
    calls = [];
  transport.peerProfile = async ({ userId, groupId }) => ({ userId, groupId });
  transport.peerQzoneRecent = async (args) => {
    calls.push(args);
    return [
      {
        id: "fixture-post",
        text: "空间来源陈述",
        createdAt: "2026-11-01T12:00:00.000Z",
        comments: 2,
        images: 1,
      },
    ];
  };
  return {
    ...f,
    transport,
    calls,
    m: f.store.bind("agent-0"),
    ctx: context(f.runtime, "agent-0", own),
  };
}
const read = (f, args = {}, ctx = f.ctx) => f.runtime.callTool(ctx, name, args);

test("peer space reader defaults off and has an independent current-chat gate", async (t) => {
  const cfg = config(1);
  cfg.agents[0].tools.push(name);
  const f = fixture(t, { cfg }),
    a = f.runtime.agent("agent-0");
  assert.equal(a.behavior.actions.peerQzone, false);
  assert(!f.runtime.toolsFor(a, own).includes(name));
  a.behavior.actions.qzone = true;
  assert(!f.runtime.toolsFor(a, own).includes(name));
  await assert.rejects(
    f.runtime.callTool(context(f.runtime, "agent-0", own), name, {}),
    /TOOL_DISABLED/,
  );
  a.behavior.actions.peerQzone = true;
  assert(f.runtime.toolsFor(a, own).includes(name));
  assert(f.runtime.toolsFor(a, group).includes(name));
  assert(!f.runtime.toolsFor(a, "@subject").includes(name));
  assert(!f.runtime.toolsFor(a, "@work:fixture").includes(name));
});

test("private reads bind to the current peer and record source claims without granting a reply", async (t) => {
  const f = setup(t),
    before = structuredClone(f.m.state(own));
  const result = await read(f);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].userId, person);
  assert.equal(f.calls[0].limit, 5);
  assert.equal(result.userId, person);
  assert.equal(result.source.visibility, "account-visible-not-group-public");
  assert.equal(result.source.untrusted, true);
  assert.equal(result.source.epistemic, "external-source-claim");
  assert(Number.isFinite(Date.parse(result.source.checkedAt)));
  const row = f.m.db
    .prepare("SELECT * FROM events WHERE id=?")
    .get(result.source.recordId);
  assert.equal(row.kind, "external.read");
  assert.deepEqual(JSON.parse(row.payload).protectedPeerQzoneTargets, [person]);
  assert(f.ctx.privateRead.has("peer-qzone:" + person));
  f.runtime.assertDisclosure(f.ctx);
  assert.equal(f.ctx.sendCount, 0);
  assert.equal(f.m.state(own).replyBatchSends, before.replyBatchSends);
  assert.equal(f.m.state(own).readThroughSeq, before.readThroughSeq);
  assert.equal(f.transport.sent.length, 0);
  assert.equal(
    f.m.db
      .prepare("SELECT COUNT(*) AS n FROM events WHERE kind='message.received'")
      .get().n,
    0,
  );
});

test("private and group targets cannot be arbitrary users or remembered group members", async (t) => {
  const f = setup(t);
  await assert.rejects(
    read(f, { userId: "30001" }),
    /PEER_PROFILE_TARGET_DENIED/,
  );
  const ctx = context(f.runtime, "agent-0", group);
  await assert.rejects(read(f, {}, ctx), /PEER_PROFILE_TARGET_DENIED/);
  let members = 0;
  f.transport.peerProfile = async ({ userId, groupId }) => {
    members++;
    return { userId, groupId };
  };
  await read(f, { userId: person, limit: 2 }, ctx);
  await read(f, { userId: person, limit: 2 }, ctx);
  assert.equal(members, 2);
  assert.equal(f.calls.length, 2);
  assert.equal(f.calls[0].limit, 2);
});

test("core rechecks gateway membership identity before reading any space", async (t) => {
  const f = setup(t),
    ctx = context(f.runtime, "agent-0", group);
  for (const result of [
    { userId: "30001", groupId: "20000" },
    { userId: person, groupId: "20001" },
    { userId: person },
    null,
  ]) {
    f.transport.peerProfile = async () => result;
    await assert.rejects(
      read(f, { userId: person }, ctx),
      /PEER_PROFILE_IDENTITY_MISMATCH/,
    );
  }
  assert.equal(f.calls.length, 0);
});

test("reading a group member protects this and later turns, and a new read invalidates the previous grant", async (t) => {
  const f = setup(t),
    ctx = context(f.runtime, "agent-0", group);
  const first = await read(f, { userId: person }, ctx);
  await assert.rejects(
    f.runtime.send(ctx, { requestId: "before-grant", text: "引用空间" }),
    /REQUIRES_DISCLOSURE_GRANT/,
  );
  f.runtime.grant(disclosureApproval(ctx));
  f.runtime.assertDisclosure(ctx);
  const second = await read(f, { userId: person }, ctx);
  assert.notEqual(second.source.recordId, first.source.recordId);
  assert.throws(
    () => f.runtime.assertDisclosure(ctx),
    /REQUIRES_DISCLOSURE_GRANT/,
  );
  const next = context(f.runtime, "agent-0", group);
  assert.throws(
    () => f.runtime.assertDisclosure(next),
    /REQUIRES_DISCLOSURE_GRANT/,
  );
  assert.equal(f.transport.sent.length, 0);
});

test("schema rejects caller identity, arbitrary URLs and out-of-range limits", async (t) => {
  const f = setup(t);
  for (const args of [
    { limit: 0 },
    { limit: 11 },
    { limit: 1.5 },
    { userId: "invalid" },
    { userId: "030000" },
    { url: "https://example.com" },
    { agentId: "agent-1" },
    { conversation: "private:30001" },
  ])
    await assert.rejects(read(f, args));
  assert.equal(f.calls.length, 0);
});

test("proactive, scheduled, protected, paused and offline contexts cannot read", async (t) => {
  const f = setup(t);
  for (const field of ["activeIntentId", "intentOnly", "scheduleRunId"]) {
    const ctx = context(f.runtime, "agent-0", own);
    ctx[field] = true;
    await assert.rejects(read(f, {}, ctx), /QZONE_ORDINARY_TURN_REQUIRED/);
  }
  f.runtime.agent("agent-0").paused = true;
  await assert.rejects(read(f), /PAUSED/);
  f.runtime.agent("agent-0").paused = false;
  f.transport.connected = false;
  await assert.rejects(read(f), /QQ_NOT_CONNECTED/);
  assert.equal(f.calls.length, 0);
});

test("membership and web awaits recheck role settings and never retain late results", async (t) => {
  const f = setup(t),
    ctx = context(f.runtime, "agent-0", group);
  f.transport.peerProfile = async () => {
    f.runtime.agent("agent-0").behavior.actions.peerQzone = false;
    return { userId: person, groupId: "20000" };
  };
  await assert.rejects(read(f, { userId: person }, ctx), /TOOL_DISABLED/);
  assert.equal(f.calls.length, 0);
  f.runtime.agent("agent-0").behavior.actions.peerQzone = true;
  f.transport.peerQzoneRecent = async () => {
    f.runtime.agent("agent-0").behavior.actions.peerQzone = false;
    return [];
  };
  await assert.rejects(read(f), /TOOL_DISABLED/);
  assert.equal(
    f.m.db
      .prepare("SELECT COUNT(*) AS n FROM events WHERE kind='external.read'")
      .get().n,
    0,
  );
});

test("revocation during cookie acquisition prevents the subsequent space request", async (t) => {
  for (const change of ["flag", "transport"]) {
    const f = setup(t);
    let calls = 0;
    const bot = new OneBot(
      { accountId: "10000", httpUrl: "http://gateway" },
      {
        fetchImpl: async () => {
          calls++;
          if (change === "flag")
            f.runtime.agent("agent-0").behavior.actions.peerQzone = false;
          else f.runtime.transports.set("qq-0", new FakeTransport());
          return new Response(
            JSON.stringify({
              status: "ok",
              retcode: 0,
              data: { cookies: "uin=o0010000; p_skey=fixture-key" },
            }),
          );
        },
      },
    );
    bot.connected = true;
    f.runtime.transports.set("qq-0", bot);
    await assert.rejects(read(f), /TOOL_DISABLED|CONFIG_CONFLICT/);
    assert.equal(calls, 1);
    assert.equal(
      f.m.db
        .prepare("SELECT COUNT(*) AS n FROM events WHERE kind='external.read'")
        .get().n,
      0,
    );
  }
});

test("failure classes stay sanitized and a successful empty result is distinct", async (t) => {
  const f = setup(t);
  for (const reason of [
    "QZONE_LOGIN_REQUIRED",
    "QZONE_ACCESS_DENIED",
    "QZONE_RATE_LIMITED",
    "QZONE_RESPONSE_UNREADABLE",
    "QZONE_TARGET_MISMATCH",
    "QQ_ACCOUNT_MISMATCH",
    "QZONE_REJECTED",
    "unexpected-cookie-fixture",
  ]) {
    f.transport.peerQzoneRecent = async () => {
      const error = Error("COOKIE_FIXTURE_SECRET");
      error.reason = reason;
      throw error;
    };
    await assert.rejects(read(f), (error) => {
      assert.equal(
        error.message,
        reason === "unexpected-cookie-fixture" ? "QZONE_READ_FAILED" : reason,
      );
      assert.equal(error.cause, undefined);
      return true;
    });
  }
  f.transport.peerQzoneRecent = async () => [];
  const result = await read(f);
  assert.deepEqual(result.posts, []);
  assert(result.source.recordId);
  assert(f.ctx.privateRead.has("peer-qzone:" + person));
});

test("the core projects transport rows before returning or archiving and rejects invalid rows without taint", async (t) => {
  const f = setup(t);
  f.transport.peerQzoneRecent = async () => [
    {
      id: "safe",
      text: "x".repeat(1200),
      createdAt: null,
      comments: 1,
      images: 0,
      cookie: "COOKIE_FIXTURE_SECRET",
      raw: "RAW_FIXTURE_SECRET",
      url: "https://example.com/signed?token=fixture",
    },
  ];
  const result = await read(f);
  assert.deepEqual(Object.keys(result.posts[0]).sort(), [
    "comments",
    "createdAt",
    "id",
    "images",
    "text",
  ]);
  assert.equal(result.posts[0].text.length, 1000);
  const row = f.m.db
    .prepare("SELECT body,payload FROM events WHERE id=?")
    .get(result.source.recordId);
  assert.doesNotMatch(
    JSON.stringify(result) + row.body + row.payload,
    /COOKIE_FIXTURE_SECRET|RAW_FIXTURE_SECRET|signed\?token/,
  );
  const invalid = setup(t);
  for (const post of [
    null,
    {},
    { id: "x", text: "x", createdAt: null, comments: -1, images: 0 },
    { id: "x", text: "x", createdAt: "bad", comments: 0, images: 0 },
    { id: "x", text: "x", createdAt: null, comments: 0, images: 1e12 },
  ]) {
    invalid.transport.peerQzoneRecent = async () => [post];
    await assert.rejects(read(invalid), /QZONE_RESPONSE_UNREADABLE/);
  }
  assert.equal(
    invalid.m.db
      .prepare("SELECT COUNT(*) AS n FROM events WHERE kind='external.read'")
      .get().n,
    0,
  );
  assert(!invalid.ctx.privateRead.has("peer-qzone:" + person));
});

test("an unsupported current-group membership lookup fails before space access", async (t) => {
  const f = setup(t),
    ctx = context(f.runtime, "agent-0", group);
  f.transport.peerProfile = async () => {
    const error = Error("ONEBOT_REJECTED");
    error.reason = "ACTION_UNSUPPORTED";
    throw error;
  };
  await assert.rejects(
    read(f, { userId: person }, ctx),
    /PEER_PROFILE_UNSUPPORTED/,
  );
  assert.equal(f.calls.length, 0);
});
