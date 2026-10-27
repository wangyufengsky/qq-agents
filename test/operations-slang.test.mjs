import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  fixture,
  config,
  context,
  raw,
  settle,
  disclosureApproval,
} from "./helpers.mjs";
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
  return {
    ...f,
    ctx: context(f.runtime, "agent-0", "private:30000"),
    ops: f.runtime.operations,
  };
}
async function level(f, level = "L2", otp) {
  const r = f.ops.request(f.ctx, { level }),
    p = f.ops.pending.get(r.requestId);
  await f.ops.confirm("agent-0", "private:30000", p.id, p.code, otp);
}
test("operations escalation is owner-private and tool returns no approval challenge", async (t) => {
  const f = setup(t);
  await assert.rejects(
    f.runtime.callTool(context(f.runtime), "ops_request_level", {
      level: "L1",
    }),
    /OWNER_OPERATIONS_ONLY/,
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
  await f.ops.confirm("agent-0", "private:30000", p.id, p.code);
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
    f.ops.confirm("agent-0", "private:30000", p2.id, p2.code),
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
      f.ops.confirm("agent-0", "private:30000", p.id, "bad"),
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
    "private:30000",
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
      "private:30000",
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
    /DISCLOSURE/,
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
test("slang candidates require same-conversation evidence and never self-confirm", async (t) => {
  const f = setup(t),
    a = f.runtime.agent("agent-0");
  a.slang.enabled = true;
  const ctx = context(f.runtime),
    mem = f.store.bind(a.id);
  const evidence = mem.append({
    dedupe: "term",
    conversation: ctx.conversation,
    kind: "message.received",
    body: "今天又鸽了",
  });
  const e = await f.runtime.callTool(ctx, "slang_submit", {
    term: "鸽了",
    meaning: "候选释义",
    evidenceIds: [evidence.id],
  });
  assert.equal(e.status, "candidate");
  await assert.rejects(
    f.runtime.callTool(ctx, "slang_submit", {
      term: "鸽了",
      status: "confirmed",
      evidenceIds: [evidence.id],
    }),
  );
  const privateEvent = mem.append({
    dedupe: "private",
    conversation: "private:30000",
    kind: "message.received",
    body: "秘密",
  });
  await assert.rejects(
    f.runtime.callTool(ctx, "slang_submit", {
      term: "秘密",
      evidenceIds: [privateEvent.id],
    }),
    /WRONG_SCOPE/,
  );
});
test("automatic learner keeps evidence local until exact research approval", async (t) => {
  const f = setup(t),
    a = f.runtime.agent("agent-0"),
    seen = [];
  Object.assign(a.slang, {
    enabled: true,
    autoResearch: true,
    minMessages: 1,
    researchServerId: "research",
    researchTool: "search",
  });
  const mem = f.store.bind(a.id),
    ev = mem.append({
      dedupe: "learner",
      conversation: "group:20000",
      kind: "message.received",
      body: "观察证据 鸽了",
    });
  mem.setState("group:20000", { lastReceivedSeq: ev.seq });
  f.runtime.backendFactory = () => ({
    run: async (p) => {
      assert.deepEqual(
        p.tools.map((t) => t.name),
        ["slang_submit", "slang_research"],
      );
      await assert.rejects(
        p.callTool("qq_send", { requestId: "bad", text: "不应发送" }),
        /TOOL_DISABLED/,
      );
      await p.callTool("slang_submit", {
        term: "鸽了",
        meaning: "可能指失约",
        evidenceIds: [ev.id],
      });
    },
    external: {
      call: async (server, tool, args) => {
        seen.push(args);
        return { content: [{ type: "text", text: "公开词义资料" }] };
      },
    },
    close: async () => {},
  });
  f.runtime.learner.tick();
  await settle(f.runtime);
  assert.deepEqual(seen, []);
  assert.equal(
    mem.state("group:20000").slang.lastResearchError,
    "PRIVATE_RECOLLECTION_EXTERNAL_CALL_BLOCKED",
  );
  const ctx = context(f.runtime),
    entry = mem.state(ctx.conversation).slang.entries[0];
  ctx.learnerBackend = f.runtime.learner.backends.get(a.id);
  await assert.rejects(
    f.runtime.learner.research(ctx, { id: entry.id }),
    /EXTERNAL_CALL_BLOCKED/,
  );
  const pending = ctx.disclosureRequest;
  f.runtime.grant(disclosureApproval(ctx, pending));
  await f.runtime.learner.research(ctx, { id: entry.id });
  assert.deepEqual(seen, [{ query: "鸽了" }]);
  assert.equal(mem.state("group:20000").slang.entries[0].status, "candidate");
  assert.equal(f.runtime.transports.get("qq-0").sent.length, 0);
});
test("paused or isolated agents cannot run automatic learner jobs", async (t) => {
  const f = setup(t),
    a = f.runtime.agent("agent-0");
  Object.assign(a.slang, { enabled: true, minMessages: 1 });
  let calls = 0;
  f.runtime.backendFactory = () => {
    calls++;
    throw Error("must not run");
  };
  const mem = f.store.bind(a.id);
  mem.append({
    dedupe: "paused-term",
    conversation: "group:20000",
    kind: "message.received",
    body: "词语",
  });
  mem.setState("group:20000", {});
  await f.runtime.pause("all", true);
  f.runtime.learner.tick();
  await settle(f.runtime);
  assert.equal(calls, 0);
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
        f.ops.confirm("agent-0", "private:30000", p.id, "wrong"),
        /INVALID_CONFIRMATION/,
      );
  }
  const r = f.ops.request(f.ctx, { level: "L1" }),
    p = f.ops.pending.get(r.requestId);
  await assert.rejects(
    f.ops.confirm("agent-0", "private:30000", p.id, p.code),
    /CONFIRMATION_LOCKED/,
  );
  now += 300001;
  f.ops.expire();
  assert.equal(f.ops.attempts.size, 0);
  await level(f, "L1");
  assert.equal(f.ops.levels.size, 1);
});

test("owner challenge reaches its private recipient but is not exposed through model memory", async (t) => {
  const f = setup(t);
  await f.runtime.ingest(
    "qq-0",
    raw(20, {
      message_type: "private",
      group_id: undefined,
      message: [{ type: "text", data: { text: "/ops L1" } }],
    }),
  );
  const pending = [...f.ops.pending.values()][0];
  assert.ok(pending);
  const sent = f.runtime.transports.get("qq-0").sent[0];
  assert.equal(sent.conversation, "private:30000");
  assert.ok(JSON.stringify(sent.segments).includes(pending.code));
  assert.ok(
    !JSON.stringify(f.store.bind("agent-0").export()).includes(pending.code),
  );
});
