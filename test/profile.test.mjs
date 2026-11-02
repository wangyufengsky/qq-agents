import test from "node:test";
import assert from "node:assert/strict";
import { config, fixture, context } from "./helpers.mjs";
import { validateConfig } from "../src/core/config.mjs";
import { OneBot } from "../src/transport/onebot.mjs";
import { scopedCatalog } from "../src/tools/catalog.mjs";
import { gif } from "./gif-fixture.mjs";
import path from "node:path";
import { MediaStore } from "../src/tools/media.mjs";

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
  "base64",
);
const OWNER = "private:30000";

function setup(t, actions = { profile: true }) {
  const cfg = config(2);
  cfg.agents[0].ownerIds = ["30000"];
  cfg.agents[0].allow.users.push("30001");
  cfg.agents[0].behavior.actions = actions;
  cfg.agents[0].tools.push("qq_profile_read", "qq_profile_update");
  const f = fixture(t, { cfg: validateConfig(cfg) });
  f.runtime.media = new MediaStore(path.join(f.root, "images"));
  const calls = [];
  const transport = f.runtime.transports.get("qq-0");
  transport.profile = async () => ({ nickname: "旧昵称", signature: "旧签名" });
  transport.updateProfile = async (change) => {
    calls.push(change);
    if (transport.failure) throw transport.failure;
    return { confirmed: true };
  };
  return {
    ...f,
    calls,
    transport,
    ctx: context(f.runtime, "agent-0", OWNER),
    mem: f.store.bind("agent-0"),
  };
}
const update = (f, args, ctx = f.ctx) =>
  f.runtime.callTool(ctx, "qq_profile_update", args);

test("profile tools default off and only appear in an owner's private chat", async (t) => {
  const cfg = config(1);
  cfg.agents[0].ownerIds = ["30000"];
  cfg.agents[0].tools.push("qq_profile_read", "qq_profile_update");
  const { runtime } = fixture(t, { cfg: validateConfig(cfg) }),
    a = runtime.agent("agent-0"),
    ctx = context(runtime, "agent-0", OWNER);
  assert.equal(a.behavior.actions.profile, false);
  assert.equal(a.behavior.actions.profileMaxPerDay, 3);
  assert(!runtime.toolsFor(a, OWNER).includes("qq_profile_update"));
  ctx.allowedTools = [...runtime.toolsFor(a, OWNER), "qq_profile_update"];
  assert.throws(
    () => scopedCatalog(runtime, ctx, { names: ["qq_profile_update"] }),
    /TOOL_DISABLED/,
  );
  await assert.rejects(
    runtime.callTool(ctx, "qq_profile_update", {
      requestId: "off",
      nickname: "新名字",
    }),
    /TOOL_DISABLED/,
  );
  a.behavior.actions.profile = true;
  assert(runtime.toolsFor(a, OWNER).includes("qq_profile_update"));
  assert(runtime.toolsFor(a, OWNER).includes("qq_profile_read"));
  for (const elsewhere of [
    "group:20000",
    "private:30001",
    "@subject",
    "@work:x",
  ])
    assert(!runtime.toolsFor(a, elsewhere).includes("qq_profile_update"));
});

test("non-owner chats cannot change the profile even with a stale catalogue", async (t) => {
  const f = setup(t);
  for (const conversation of ["group:20000", "private:30001"]) {
    const ctx = context(f.runtime, "agent-0", conversation);
    ctx.allowedTools = ["qq_profile_update"];
    await assert.rejects(
      update(f, { requestId: "x:" + conversation, nickname: "坏名字" }, ctx),
      /TOOL_DISABLED/,
    );
  }
  assert.equal(f.calls.length, 0);
});

test("schema takes exactly one single-line field and no caller identity", async (t) => {
  const f = setup(t);
  for (const args of [
    { requestId: "none" },
    { requestId: "two", nickname: "甲", signature: "乙" },
    { requestId: "newline", nickname: "第一行\n第二行" },
    { requestId: "long", nickname: "长".repeat(25) },
    { requestId: "blank", signature: "   " },
    { requestId: "bad-media", mediaId: "../etc/passwd" },
    { requestId: "who", nickname: "甲", agentId: "agent-1" },
  ])
    await assert.rejects(update(f, args));
  assert.equal(f.calls.length, 0);
});

test("reads the current profile and confirms nickname and signature changes once", async (t) => {
  const f = setup(t);
  assert.deepEqual(await f.runtime.callTool(f.ctx, "qq_profile_read", {}), {
    accountId: "10000",
    nickname: "旧昵称",
    signature: "旧签名",
  });
  const nick = await update(f, { requestId: "n1", nickname: " 新昵称 " });
  assert.equal(nick.status, "sent");
  assert.equal(nick.actionConfirmed, true);
  await update(f, { requestId: "s1", signature: "今天也很开心" });
  assert.deepEqual(f.calls, [
    { nickname: "新昵称" },
    { signature: "今天也很开心" },
  ]);
  const duplicate = await update(f, { requestId: "n1", nickname: "新昵称" });
  assert.equal(duplicate.duplicate, true);
  assert.equal(f.calls.length, 2);
  const confirmed = f.mem.db
    .prepare(
      "SELECT body,payload FROM events WHERE kind='action.confirmed' ORDER BY seq",
    )
    .all();
  assert.deepEqual(
    confirmed.map((r) => r.body),
    ["[修改昵称] 新昵称", "[修改签名] 今天也很开心"],
  );
  assert.equal(JSON.parse(confirmed[0].payload).actionKind, "profile");
});

test("avatar uses only static images from the role's own library", async (t) => {
  const f = setup(t);
  const saved = f.runtime.media.put("agent-0", png, "image/png", {
    saved: true,
    conversation: OWNER,
  });
  await assert.rejects(
    update(f, { requestId: "missing", mediaId: "a".repeat(64) }),
    /MEDIA_NOT_FOUND/,
  );
  const foreign = f.runtime.media.put(
    "agent-1",
    gif([{ color: 2 }]),
    "image/gif",
  );
  await assert.rejects(
    update(f, { requestId: "foreign", mediaId: foreign.id }),
    /MEDIA_NOT_FOUND/,
  );
  const animated = f.runtime.media.put(
    "agent-0",
    gif([{}, { color: 1 }]),
    "image/gif",
    { conversation: OWNER },
  );
  await assert.rejects(
    update(f, { requestId: "gif", mediaId: animated.id }),
    /PROFILE_AVATAR_INVALID/,
  );
  const result = await update(f, { requestId: "a1", mediaId: saved.id });
  assert.equal(result.status, "sent");
  assert.equal(f.calls.length, 1);
  assert(Buffer.isBuffer(f.calls[0].image));
  assert.deepEqual(f.calls[0].image, png);
});

test("images seen in other chats need a disclosure grant before becoming the avatar", async (t) => {
  const f = setup(t);
  const saved = f.runtime.media.put("agent-0", png, "image/png", {
    saved: true,
    conversation: "group:20000",
    sourceEventId: "evt-group",
  });
  await assert.rejects(
    update(f, { requestId: "leak", mediaId: saved.id }),
    /PRIVATE_RECOLLECTION_EXTERNAL_CALL_BLOCKED/,
  );
  assert.equal(f.calls.length, 0);
});

test("credentials, proactive intents and scheduled runs cannot change the profile", async (t) => {
  const f = setup(t);
  await assert.rejects(
    update(f, {
      requestId: "secret",
      signature: "sk-" + "a".repeat(40),
    }),
    /SENSITIVE_OUTPUT_BLOCKED/,
  );
  for (const extra of [
    { activeIntentId: "intent-1" },
    { intentOnly: true },
    { scheduleRunId: "run-1" },
  ]) {
    const ctx = Object.assign(context(f.runtime, "agent-0", OWNER), extra);
    await assert.rejects(
      update(
        f,
        { requestId: "ctx:" + Object.keys(extra)[0], nickname: "甲" },
        ctx,
      ),
      /PROFILE_ORDINARY_TURN_REQUIRED/,
    );
  }
  assert.equal(f.calls.length, 0);
});

test("daily budget counts every attempt across fields", async (t) => {
  const f = setup(t, { profile: true, profileMaxPerDay: 2 });
  await update(f, { requestId: "d1", nickname: "一" });
  f.transport.failure = Object.assign(Error("ONEBOT_REJECTED"), {});
  await assert.rejects(
    update(f, { requestId: "d2", signature: "二" }),
    /DELIVERY_FAILED/,
  );
  f.transport.failure = null;
  await assert.rejects(
    update(f, { requestId: "d3", nickname: "三" }),
    /PROFILE_RATE_LIMITED/,
  );
  assert.equal(f.calls.length, 2);
});

test("an unknown change blocks another request for the same field only", async (t) => {
  const f = setup(t);
  f.transport.failure = Error("ONEBOT_HTTP_ERROR");
  await assert.rejects(
    update(f, { requestId: "u1", nickname: "可能已改" }),
    /DELIVERY_UNKNOWN/,
  );
  f.transport.failure = null;
  await assert.rejects(
    update(f, { requestId: "u2", nickname: "再改一次" }),
    /PROFILE_UPDATE_UNCONFIRMED/,
  );
  await assert.rejects(
    update(f, { requestId: "u1", nickname: "可能已改" }),
    /DELIVERY_ALREADY_ATTEMPTED_UNKNOWN/,
  );
  const ok = await update(f, { requestId: "u3", signature: "签名不受影响" });
  assert.equal(ok.status, "sent");
  assert.equal(f.calls.length, 2);
});

test("gateway without profile support reports PROFILE_UNSUPPORTED", async (t) => {
  const f = setup(t);
  f.transport.failure = Object.assign(Error("ONEBOT_REJECTED"), {
    reason: "ACTION_UNSUPPORTED",
  });
  await assert.rejects(
    update(f, { requestId: "unsupported", nickname: "甲" }),
    /PROFILE_UNSUPPORTED/,
  );
});

test("OneBot maps profile changes to NapCat actions and rejects failed results", async () => {
  const requests = [];
  let reply = { status: "ok", retcode: 0, data: null };
  const bot = new OneBot(
    { accountId: "10000", httpUrl: "http://gateway" },
    {
      fetchImpl: async (url, init) => {
        requests.push({
          action: String(url).split("/").pop(),
          body: JSON.parse(init.body),
        });
        return new Response(JSON.stringify(reply));
      },
    },
  );
  await bot.updateProfile({ nickname: "新昵称" });
  await bot.updateProfile({ signature: "新签名" });
  await bot.updateProfile({ image: Buffer.from("abc") });
  assert.deepEqual(requests, [
    { action: "set_qq_profile", body: { nickname: "新昵称" } },
    { action: "set_self_longnick", body: { longNick: "新签名" } },
    { action: "set_qq_avatar", body: { file: "base64://YWJj" } },
  ]);
  reply = { status: "ok", retcode: 0, data: { result: 1, errMsg: "x" } };
  await assert.rejects(
    bot.updateProfile({ nickname: "甲" }),
    /ONEBOT_REJECTED/,
  );
  reply = { status: "failed", retcode: 1404, message: "不支持的 API" };
  await assert.rejects(bot.updateProfile({ nickname: "甲" }), (e) => {
    assert.equal(e.reason, "ACTION_UNSUPPORTED");
    return true;
  });
  reply = {
    status: "ok",
    retcode: 0,
    data: { user_id: 10000, nickname: "我", long_nick: "签名" },
  };
  assert.deepEqual(await bot.profile(), { nickname: "我", signature: "签名" });
  reply = {
    status: "ok",
    retcode: 0,
    data: { user_id: 99999, nickname: "别人" },
  };
  await assert.rejects(bot.profile(), /QQ_ACCOUNT_MISMATCH/);
});
