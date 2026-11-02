import test from "node:test";
import assert from "node:assert/strict";
import { config, fixture, context } from "./helpers.mjs";
import { validateConfig } from "../src/core/config.mjs";
import { OneBot } from "../src/transport/onebot.mjs";

function setup(t, enabled = true) {
  const cfg = config(1);
  cfg.agents[0].tools.push("qq_peer_profile_read");
  cfg.agents[0].behavior.actions.peerProfile = enabled;
  const f = fixture(t, { cfg: validateConfig(cfg) });
  const transport = f.runtime.transports.get("qq-0");
  const calls = [];
  transport.peerProfile = async (args) => {
    calls.push(args);
    return {
      ...args,
      nickname: "昵称",
      signature: "签名",
      card: "名片",
      role: "member",
      title: "头衔",
      phone: "private",
      email: "private",
      raw: { secret: true },
    };
  };
  return {
    ...f,
    transport,
    calls,
    ctx: context(f.runtime, "agent-0", "private:30000"),
  };
}
const read = (f, args = {}, ctx = f.ctx) =>
  f.runtime.callTool(ctx, "qq_peer_profile_read", args);

test("peer profile is independently disabled by default and unavailable outside chat", async (t) => {
  const f = setup(t, false),
    a = f.runtime.agent("agent-0");
  assert.equal(
    validateConfig(config(1)).agents[0].behavior.actions.peerProfile,
    false,
  );
  await assert.rejects(read(f), /TOOL_DISABLED/);
  a.behavior.actions.peerProfile = true;
  assert.equal(a.behavior.actions.profile, false);
  assert.equal(a.behavior.actions.qzone, false);
  for (const scope of ["@subject", "@work:x"])
    assert(!f.runtime.toolsFor(a, scope).includes("qq_peer_profile_read"));
});

test("private peer read defaults to current user and rejects arbitrary targets and identity arguments", async (t) => {
  const f = setup(t);
  assert.deepEqual(await read(f), {
    userId: "30000",
    nickname: "昵称",
    signature: "签名",
  });
  for (const args of [
    { userId: "30001" },
    { groupId: "20000" },
    { agentId: "agent-1" },
    { connectionId: "qq-1" },
    { userId: "../x" },
  ])
    await assert.rejects(read(f, args));
  assert.equal(f.calls.length, 1);
  assert.equal(f.transport.sent.length, 0);
});

test("group read requires an explicit member and projects group-visible fields", async (t) => {
  const f = setup(t),
    ctx = context(f.runtime, "agent-0", "group:20000");
  await assert.rejects(read(f, {}, ctx), /PEER_PROFILE_TARGET_DENIED/);
  assert.deepEqual(await read(f, { userId: "30000" }, ctx), {
    userId: "30000",
    nickname: "昵称",
    signature: null,
    groupId: "20000",
    card: "名片",
    role: "member",
    title: "头衔",
  });
  assert.deepEqual(f.calls, [{ userId: "30000", groupId: "20000" }]);
  f.transport.peerProfile = async () => ({ userId: "30001", groupId: "20000" });
  await assert.rejects(
    read(f, { userId: "30000" }, ctx),
    /PEER_PROFILE_IDENTITY_MISMATCH/,
  );
});

test("read refuses paused isolated unallowed disconnected and revoked contexts", async (t) => {
  const f = setup(t);
  f.transport.connected = false;
  await assert.rejects(read(f), /QQ_NOT_CONNECTED/);
  f.transport.connected = true;
  await assert.rejects(
    read(f, {}, context(f.runtime, "agent-0", "private:30001")),
    /AGENT_PAUSED_OR_EXPIRED/,
  );
  for (const mutate of [
    () => {
      f.runtime.config.globalPaused = true;
    },
    () => {
      f.runtime.config.mode = "isolated";
    },
    () => {
      f.runtime.agent("agent-0").behavior.actions.peerProfile = false;
    },
  ]) {
    f.transport.peerProfile = async (args) => {
      mutate();
      return args;
    };
    await assert.rejects(read(f));
    f.runtime.config.globalPaused = false;
    f.runtime.config.mode = "live";
    f.runtime.agent("agent-0").behavior.actions.peerProfile = true;
  }
});

test("gateway uses uncached live member lookup, verifies identities and strips private fields", async () => {
  const bot = new OneBot({ accountId: "10000" });
  const calls = [];
  let info = {
    user_id: 30000,
    group_id: 20000,
    nickname: "昵称",
    card: "名片",
    role: "member",
    sign: "私有签名",
    phone: "private",
  };
  bot.call = async (...args) => {
    calls.push(args);
    return info;
  };
  const result = await bot.peerProfile({ userId: "30000", groupId: "20000" });
  assert.deepEqual(calls[0].slice(0, 2), [
    "get_group_member_info",
    { user_id: "30000", group_id: "20000", no_cache: true },
  ]);
  assert.equal(result.signature, null);
  assert(!Object.hasOwn(result, "phone"));
  info = { user_id: 30000, group_id: 20001 };
  await assert.rejects(
    bot.peerProfile({ userId: "30000", groupId: "20000" }),
    /PEER_PROFILE_IDENTITY_MISMATCH/,
  );
  info = { user_id: 30001 };
  await assert.rejects(
    bot.peerProfile({ userId: "30000" }),
    /PEER_PROFILE_IDENTITY_MISMATCH/,
  );
  info = {
    user_id: 30000,
    nickname: "字".repeat(300),
    sign: "签名",
    phone: "private",
  };
  assert.deepEqual(await bot.peerProfile({ userId: "30000" }), {
    userId: "30000",
    nickname: "字".repeat(200),
    signature: "签名",
  });
});

test("connection changes during an awaited read cannot return the old account result", async (t) => {
  const f = setup(t);
  f.transport.peerProfile = async (args) => {
    f.runtime.connection("qq-0").accountId = "10001";
    return args;
  };
  await assert.rejects(read(f), /PEER_PROFILE_IDENTITY_MISMATCH/);
});

test("replaced transport and aborted context withhold a completed result", async (t) => {
  for (const mode of ["replace", "abort", "connection"]) {
    const f = setup(t);
    f.transport.peerProfile = async (args) => {
      if (mode === "replace")
        f.runtime.transports.set("qq-0", { connected: true });
      if (mode === "abort") f.ctx.controller.abort();
      if (mode === "connection")
        f.runtime.agent("agent-0").connectionId = "qq-1";
      return args;
    };
    await assert.rejects(
      read(f),
      /PEER_PROFILE_IDENTITY_MISMATCH|AGENT_PAUSED_OR_EXPIRED/,
    );
    f.runtime.transports.set("qq-0", f.transport);
    f.runtime.agent("agent-0").connectionId = "qq-0";
  }
});
