import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fixture, config, context, raw } from "./helpers.mjs";
import { TOOL_NAMES } from "../src/tools/index.mjs";
import { totp } from "../vendor/legacy/totp.js";
import { Operations } from "../src/core/operations.mjs";

function setup(t) {
  const c = config(1);
  c.agents[0].tools = TOOL_NAMES;
  c.agents[0].ownerIds = ["30000"];
  c.agents[0].operations.enabled = true;
  const f = fixture(t, { cfg: c });
  f.runtime.agent("agent-0").operations.workspace = path.join(
    f.root,
    "workspace",
  );
  fs.mkdirSync(path.join(f.root, "workspace"));
  const task = f.runtime.protectedWork.create({
    agentId: "agent-0",
    instruction: "fixture work",
    operations: true,
  });
  return {
    ...f,
    ctx: context(f.runtime, "agent-0", "@work:" + task.id),
    ops: f.runtime.operations,
  };
}
async function level(f, level = "L2", otp) {
  const r = f.ops.request(f.ctx, { level }),
    p = f.ops.pending.get(r.requestId);
  await f.ops.confirm("agent-0", f.ctx.conversation, p.id, p.code, otp);
}
test("an approved write that outlives its task reports success but keeps no result", async (t) => {
  const f = setup(t);
  await level(f);
  const r = f.ops.propose(f.ctx, {
      type: "write",
      file: "late.txt",
      text: "written",
    }),
    p = f.ops.pending.get(r.requestId);
  const confirmed = f.ops.confirm("agent-0", f.ctx.conversation, p.id, p.code);
  f.runtime.protectedWork.update("agent-0", f.ctx.conversation, {
    status: "cancelled",
  });
  const result = await confirmed;
  assert.equal(result.written, "late.txt");
  assert.equal(result.taskInactive, true);
  assert.equal(
    fs.readFileSync(path.join(f.root, "workspace", "late.txt"), "utf8"),
    "written",
  );
  assert(![...f.ops.results.values()].some((row) => row.result.written));
});
test("operations escalation is isolated-work-only and tool returns no approval challenge", async (t) => {
  const f = setup(t);
  await assert.rejects(
    f.runtime.callTool(context(f.runtime), "ops_request_level", {
      level: "L1",
    }),
    /TOOL_DISABLED/,
  );
  const r = await f.runtime.callTool(f.ctx, "ops_request_level", {
    level: "L1",
  });
  assert.equal(r.status, "awaiting-owner-confirmation");
  assert.equal(r.code, undefined);
  assert.throws(() => f.ops.read(f.ctx, { file: "x.txt" }), /LEVEL_REQUIRED/);
});
test("L2 write executes only after independent confirmation and detects concurrent edits", async (t) => {
  const f = setup(t);
  await level(f);
  const r = f.ops.propose(f.ctx, {
    type: "write",
    file: "notes.txt",
    text: "已确认内容",
  });
  assert.ok(!fs.existsSync(path.join(f.root, "workspace", "notes.txt")));
  const p = f.ops.pending.get(r.requestId);
  await f.ops.confirm("agent-0", f.ctx.conversation, p.id, p.code);
  assert.equal(
    fs.readFileSync(path.join(f.root, "workspace", "notes.txt"), "utf8"),
    "已确认内容",
  );
  const r2 = f.ops.propose(f.ctx, {
      type: "write",
      file: "notes.txt",
      text: "覆盖",
    }),
    p2 = f.ops.pending.get(r2.requestId);
  fs.writeFileSync(path.join(f.root, "workspace", "notes.txt"), "用户改动");
  await assert.rejects(
    f.ops.confirm("agent-0", f.ctx.conversation, p2.id, p2.code),
    /FILE_CHANGED/,
  );
  assert.equal(
    fs.readFileSync(path.join(f.root, "workspace", "notes.txt"), "utf8"),
    "用户改动",
  );
});
test("workspace traversal, hidden credentials and symlink escapes are refused", async (t) => {
  const f = setup(t);
  await level(f);
  fs.symlinkSync(f.root, path.join(f.root, "workspace", "escape"));
  for (const file of ["../x", ".env", "config.json", "escape/config.json"])
    assert.throws(
      () => f.ops.propose(f.ctx, { type: "write", file, text: "x" }),
      /PATH_DENIED|SYMLINK_DENIED/,
    );
});
test("approval has attempt limit, expiry and pause immediately revokes elevated access", async (t) => {
  const f = setup(t),
    r = f.ops.request(f.ctx, { level: "L1" }),
    p = f.ops.pending.get(r.requestId);
  for (let i = 0; i < 3; i++)
    await assert.rejects(
      f.ops.confirm("agent-0", f.ctx.conversation, p.id, "bad"),
      /CONFIRMATION/,
    );
  assert.equal(f.ops.pending.size, 0);
  await level(f, "L1");
  await f.runtime.pause("agent-0", true);
  assert.equal(f.ops.levels.size, 0);
});
test("L3 requires TOTP, replay protection survives controller reconstruction, and commands require separate approval", async (t) => {
  const f = setup(t),
    p = f.runtime.agent("agent-0").operations;
  Object.assign(p, {
    allowL3: true,
    totpEnv: "QQ_UNIFIED_TEST_TOTP",
    allowedCommands: [process.execPath],
  });
  const old = process.env.QQ_UNIFIED_TEST_TOTP;
  process.env.QQ_UNIFIED_TEST_TOTP = "JBSWY3DPEHPK3PXP";
  t.after(() =>
    old === undefined
      ? delete process.env.QQ_UNIFIED_TEST_TOTP
      : (process.env.QQ_UNIFIED_TEST_TOTP = old),
  );
  const now = Date.parse("2026-10-25T04:00:00Z");
  f.runtime.clock = () => new Date(now);
  await level(f, "L3", totp(process.env.QQ_UNIFIED_TEST_TOTP, now));
  const r = f.ops.propose(f.ctx, {
      type: "run",
      command: process.execPath,
      args: ["-e", "process.stdout.write('fixture approved')"],
    }),
    request = f.ops.pending.get(r.requestId);
  const result = await f.ops.confirm(
    "agent-0",
    f.ctx.conversation,
    request.id,
    request.code,
  );
  assert.equal(result.stdout, "fixture approved");
  const reboot = new Operations(f.runtime),
    r2 = reboot.request(f.ctx, { level: "L3" }),
    p2 = reboot.pending.get(r2.requestId);
  await assert.rejects(
    reboot.confirm(
      "agent-0",
      f.ctx.conversation,
      p2.id,
      p2.code,
      totp(process.env.QQ_UNIFIED_TEST_TOTP, now),
    ),
    /TOTP/,
  );
});
test("private file reads mark retained disclosure context and cannot be sent without a grant", async (t) => {
  const f = setup(t);
  await level(f, "L1");
  fs.writeFileSync(path.join(f.root, "workspace", "notes.txt"), "工作区内容");
  const r = f.ops.read(f.ctx, { file: "notes.txt" });
  assert.equal(r.text, "工作区内容");
  await assert.rejects(
    f.runtime.send(f.ctx, { requestId: "private-output", text: r.text }),
    /PROTECTED_WORK_OUTBOUND_DENIED/,
  );
});
test("owner confirmation secrets are removed from archived raw message payload", async (t) => {
  const f = setup(t);
  await f.runtime.pause("all", true);
  await f.runtime.ingest(
    "qq-0",
    raw(2, {
      message_type: "private",
      group_id: undefined,
      message: [{ type: "text", data: { text: "确认 123456 654321" } }],
    }),
  );
  const snapshot = JSON.stringify(f.store.bind("agent-0").export());
  assert.ok(!snapshot.includes("123456"));
  assert.ok(!snapshot.includes("654321"));
  assert.match(snapshot, /验证码不进入记忆/);
});
test("confirmation failures across requests share a five-minute lock", async (t) => {
  const f = setup(t);
  let now = Date.now();
  f.runtime.clock = () => new Date(now);
  for (let request = 0; request < 2; request++) {
    const r = f.ops.request(f.ctx, { level: "L1" }),
      p = f.ops.pending.get(r.requestId);
    for (let i = 0; i < (request === 0 ? 3 : 2); i++)
      await assert.rejects(
        f.ops.confirm("agent-0", f.ctx.conversation, p.id, "wrong"),
        /INVALID_CONFIRMATION/,
      );
  }
  const r = f.ops.request(f.ctx, { level: "L1" }),
    p = f.ops.pending.get(r.requestId);
  await assert.rejects(
    f.ops.confirm("agent-0", f.ctx.conversation, p.id, p.code),
    /CONFIRMATION_LOCKED/,
  );
  now += 300001;
  f.ops.expire();
  assert.equal(f.ops.attempts.size, 0);
  await level(f, "L1");
  assert.equal(f.ops.levels.size, 1);
});

test("owner QQ commands redirect to console without opening an operations context", async (t) => {
  const f = setup(t);
  await f.runtime.ingest(
    "qq-0",
    raw(20, {
      message_type: "private",
      group_id: undefined,
      message: [{ type: "text", data: { text: "/ops L1" } }],
    }),
  );
  assert.equal(f.ops.pending.size, 0);
  const sent = f.runtime.transports.get("qq-0").sent[0];
  assert.equal(sent.conversation, "private:30000");
  assert.match(JSON.stringify(sent.segments), /受保护工作区/);
});

test("cancelling work aborts its already approved command and revokes all pending results", async (t) => {
  const f = setup(t),
    policy = f.runtime.agent("agent-0").operations;
  Object.assign(policy, { allowL3: true, allowedCommands: [process.execPath] });
  f.ops.levels.set("agent-0|" + f.ctx.conversation, {
    level: "L3",
    grantedAt: f.runtime.now(),
    activeAt: f.runtime.now(),
  });
  const proposed = f.ops.propose(f.ctx, {
    type: "run",
    command: process.execPath,
    args: [
      "-e",
      "setTimeout(() => process.stdout.write('late private result'), 20000)",
    ],
  });
  const pending = f.ops.pending.get(proposed.requestId);
  const confirmation = f.ops.confirm(
    "agent-0",
    f.ctx.conversation,
    pending.id,
    pending.code,
  );
  assert.equal(f.ops.executions.size, 1);
  f.runtime.protectedWork.submit(f.ctx, { text: "Early summary" });
  const current = f.runtime.protectedWork.task("agent-0", f.ctx.conversation);
  await assert.rejects(
    f.runtime.protectedWork.act({
      agentId: "agent-0",
      taskId: current.id,
      action: "release",
      revision: current.revision,
      digest: current.result.digest,
      target: "private:30000",
    }),
    /SESSION_BUSY/,
  );
  const taskId = f.ctx.conversation.slice(6);
  const result = await f.runtime.protectedWork.act({
    agentId: "agent-0",
    taskId,
    action: "cancel",
  });
  const aborted = await confirmation;
  assert.equal(aborted.taskInactive, true);
  assert.notEqual(aborted.exitCode, 0);
  assert.doesNotMatch(JSON.stringify(aborted), /late private result/);
  assert.equal(result.status, "cancelled");
  assert.equal(f.ops.executions.size, 0);
  assert.equal(f.ops.results.size, 0);
  assert.equal(f.ops.levels.size, 0);
  assert(f.ctx.controller.signal.aborted);
});
