import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { config, fixture, context, FakeTransport } from "./helpers.mjs";

const group = "group:20000",
  infoTool = "qq_group_info_read",
  membersTool = "qq_group_members_read";
const member = (userId, role = "member", extra = {}) => ({
  groupId: "20000",
  userId,
  nickname: "name-" + userId,
  card: "card-" + userId,
  title: "",
  role,
  ...extra,
});
function setup(t) {
  const cfg = config(1),
    a = cfg.agents[0];
  a.behavior.actions.groupRead = true;
  a.ownerIds = ["39999"];
  a.tools.push(infoTool, membersTool);
  const f = fixture(t, { cfg }),
    transport = f.runtime.transports.get("qq-0"),
    calls = [];
  let roster = [
    member("30000", "owner"),
    member("30001", "admin"),
    member("30002"),
  ];
  transport.groupInfo = async (args) => {
    calls.push({ kind: "info", args });
    return {
      groupId: "20000",
      name: "fixture group",
      memberCount: 3,
      maxMemberCount: 200,
      raw: "GROUP_RAW_SECRET",
      phone: "GROUP_PHONE_SECRET",
    };
  };
  transport.groupMembers = async (args) => {
    calls.push({ kind: "members", args });
    return roster.map((row) => ({
      ...row,
      email: "GROUP_EMAIL_SECRET",
      raw: "GROUP_RAW_SECRET",
    }));
  };
  return {
    ...f,
    transport,
    calls,
    ctx: context(f.runtime),
    m: f.store.bind("agent-0"),
    setRoster: (rows) => {
      roster = rows;
    },
  };
}
const read = (f, name, args = {}, ctx = f.ctx) =>
  f.runtime.callTool(ctx, name, args);

test("group readers are independently default off and only available in the current group", async (t) => {
  const cfg = config(1);
  cfg.agents[0].tools.push(infoTool, membersTool);
  const f = fixture(t, { cfg }),
    a = f.runtime.agent("agent-0");
  assert.equal(a.behavior.actions.groupRead, false);
  for (const name of [infoTool, membersTool]) {
    assert(!f.runtime.toolsFor(a, group).includes(name));
    await assert.rejects(
      f.runtime.callTool(context(f.runtime), name, {}),
      /TOOL_DISABLED/,
    );
  }
  a.behavior.actions.groupRead = true;
  for (const name of [infoTool, membersTool]) {
    assert(f.runtime.toolsFor(a, group).includes(name));
    for (const scope of ["private:30000", "@subject", "@work:fixture"])
      assert(!f.runtime.toolsFor(a, scope).includes(name));
    await assert.rejects(
      f.runtime.callTool(
        context(f.runtime, "agent-0", "private:30000"),
        name,
        {},
      ),
      /TOOL_DISABLED/,
    );
  }
});

test("group summary projects fields without archiving a roster, changing authority or granting a reply", async (t) => {
  const f = setup(t),
    before = structuredClone(f.m.state(group)),
    a = f.runtime.agent("agent-0"),
    owners = [...a.ownerIds],
    allow = structuredClone(a.allow);
  const result = await read(f, infoTool);
  assert.equal(result.groupId, "20000");
  assert.equal(result.name, "fixture group");
  assert.equal(result.owner.userId, "30000");
  assert.equal(result.administratorCount, 1);
  assert.equal(result.summaryComplete, true);
  assert.equal(result.memberCountMatchesList, true);
  assert(Number.isFinite(Date.parse(result.source.queriedAt)));
  assert.doesNotMatch(JSON.stringify(result), /GROUP_(RAW|PHONE|EMAIL)_SECRET/);
  assert.deepEqual(a.ownerIds, owners);
  assert.deepEqual(a.allow, allow);
  assert.equal(f.m.db.prepare("SELECT COUNT(*) AS n FROM events").get().n, 0);
  assert.equal(f.ctx.sendCount, 0);
  assert.equal(f.m.state(group).readThroughSeq, before.readThroughSeq);
  assert.equal(f.transport.sent.length, 0);
  assert.deepEqual(
    f.calls.map((x) => x.kind),
    ["info", "members"],
  );
  assert(
    f.calls.every(
      (x) =>
        x.args.groupId === "20000" && x.args.signal === f.ctx.controller.signal,
    ),
  );
});

test("member pages search and filter locally with stable numeric ID ordering and changing snapshots", async (t) => {
  const f = setup(t),
    rows = [
      member("30000", "owner"),
      member("30001", "admin"),
      ...Array.from({ length: 63 }, (_, i) => member(String(30002 + i))),
    ];
  f.setRoster([...rows].reverse());
  const first = await read(f, membersTool, { limit: 50 });
  assert.equal(first.returned, 50);
  assert.equal(first.total, 65);
  assert.equal(first.nextOffset, 50);
  assert.equal(first.items[0].userId, "30000");
  const second = await read(f, membersTool, { offset: 50, limit: 50 });
  assert.equal(second.returned, 15);
  assert.equal(second.nextOffset, null);
  assert.equal(second.snapshotId, first.snapshotId);
  const admin = await read(f, membersTool, { role: "admin" });
  assert.deepEqual(
    admin.items.map((m) => m.userId),
    ["30001"],
  );
  const searched = await read(f, membersTool, { query: "NAME-30012" });
  assert.equal(searched.matched, 1);
  assert.equal(searched.items[0].userId, "30012");
  f.setRoster([...rows, member("40000")]);
  assert.notEqual(
    (await read(f, membersTool, {})).snapshotId,
    first.snapshotId,
  );
  assert(f.calls.every((x) => x.kind === "members"));
});

test("missing owner, unknown roles and changing counts are explicit rather than invented member authority", async (t) => {
  const f = setup(t);
  f.setRoster([member("30000", "unrecognized"), member("30001", "admin")]);
  const summary = await read(f, infoTool);
  assert.equal(summary.owner, null);
  assert.equal(summary.ownerStatus, "missing");
  assert.equal(summary.summaryComplete, false);
  assert.equal(summary.unknownRoles, 1);
  assert.equal(summary.memberCountMatchesList, false);
  const all = await read(f, membersTool, {});
  assert.equal(all.items[0].role, null);
  assert.equal(all.unknownRoles, 1);
  assert.deepEqual((await read(f, membersTool, { role: "member" })).items, []);
  f.setRoster([]);
  const empty = await read(f, infoTool);
  assert.equal(empty.listedMembers, 0);
  assert.equal(empty.summaryComplete, false);
});

test("large administrator summaries disclose truncation and never claim a complete summary", async (t) => {
  const f = setup(t);
  f.transport.groupInfo = async () => ({
    groupId: "20000",
    name: "fixture group",
    memberCount: 26,
    maxMemberCount: 200,
  });
  f.setRoster([
    member("30000", "owner"),
    ...Array.from({ length: 25 }, (_, i) => member(String(30001 + i), "admin")),
  ]);
  const result = await read(f, infoTool);
  assert.equal(result.administrators.length, 20);
  assert.equal(result.administratorCount, 25);
  assert.equal(result.administratorsTruncated, true);
  assert.equal(result.memberCountMatchesList, true);
  assert.equal(result.summaryComplete, false);
});

test("strict schemas reject arbitrary identities, unsupported filters and unbounded paging", async (t) => {
  const f = setup(t);
  for (const name of [infoTool, membersTool])
    for (const args of [
      { groupId: "20001" },
      { agentId: "agent-1" },
      { connectionId: "qq-1" },
    ])
      await assert.rejects(read(f, name, args));
  for (const args of [
    { limit: 51 },
    { limit: 0 },
    { offset: -1 },
    { offset: 10001 },
    { role: "superadmin" },
    { query: "x".repeat(101) },
  ])
    await assert.rejects(read(f, membersTool, args));
  assert.equal(f.calls.length, 0);
});

test("core validates an entire alternate transport response before returning a filtered page", async (t) => {
  const f = setup(t);
  f.transport.groupInfo = async () => ({ groupId: "20001", name: "wrong" });
  await assert.rejects(read(f, infoTool), /GROUP_READ_IDENTITY_MISMATCH/);
  f.transport.groupMembers = async () => [
    member("30000", "owner"),
    member("30001", "member", { groupId: "20001" }),
  ];
  await assert.rejects(
    read(f, membersTool, { limit: 1, role: "owner" }),
    /GROUP_READ_IDENTITY_MISMATCH/,
  );
  f.transport.groupMembers = async () => [member("30000"), member("30000")];
  await assert.rejects(read(f, membersTool), /GROUP_READ_IDENTITY_MISMATCH/);
  f.transport.groupMembers = async () => ({ data: [] });
  await assert.rejects(read(f, membersTool), /GROUP_READ_RESPONSE_INVALID/);
});

test("revocation during info lookup prevents the second gateway action", async (t) => {
  const f = setup(t);
  f.transport.groupInfo = async () => {
    f.runtime.agent("agent-0").behavior.actions.groupRead = false;
    return {
      groupId: "20000",
      name: "fixture",
      memberCount: 0,
      maxMemberCount: 200,
    };
  };
  await assert.rejects(read(f, infoTool), /TOOL_DISABLED/);
  assert.equal(f.calls.length, 0);
});

test("late responses recheck pause, current account and transport without saving group text", async (t) => {
  for (const change of ["pause", "transport", "account"]) {
    const f = setup(t);
    f.transport.groupMembers = async () => {
      if (change === "pause") f.runtime.agent("agent-0").paused = true;
      else if (change === "transport")
        f.runtime.transports.set("qq-0", new FakeTransport());
      else f.runtime.connection("qq-0").accountId = "10001";
      return [member("30000", "owner")];
    };
    await assert.rejects(
      read(f, membersTool),
      /PAUSED|IDENTITY_MISMATCH|QQ_ACCOUNT_MISMATCH/,
    );
    assert.equal(f.m.db.prepare("SELECT COUNT(*) AS n FROM events").get().n, 0);
  }
});

test("group reads retain existing peer-space taint and cannot promote QQ roles to application permissions", async (t) => {
  const f = setup(t);
  f.ctx.privateRead.add("peer-qzone:30000");
  f.ctx.persistTaint();
  for (const name of [infoTool, membersTool]) await read(f, name);
  assert(f.ctx.privateRead.has("peer-qzone:30000"));
  assert(f.m.state(group).disclosureTaint.includes("peer-qzone:30000"));
  assert.throws(
    () => f.runtime.assertDisclosure(f.ctx),
    /REQUIRES_DISCLOSURE_GRANT/,
  );
  assert.deepEqual(f.runtime.agent("agent-0").ownerIds, ["39999"]);
  assert.equal(f.m.db.prepare("SELECT COUNT(*) AS n FROM events").get().n, 0);
});

test("gateway failures expose only stable sanitized codes", async (t) => {
  const f = setup(t);
  f.transport.groupMembers = async () => {
    throw Error("RAW_GATEWAY_SECRET");
  };
  await assert.rejects(read(f, membersTool), (error) => {
    assert.equal(error.message, "GROUP_READ_FAILED");
    assert.equal(error.cause, undefined);
    return true;
  });
});

test("group read form sentinel preserves missing fields and enables or disables independently", () => {
  const form = vm.runInNewContext(
    fs.readFileSync(
      new URL("../public/agent-form.js", import.meta.url),
      "utf8",
    ) + "\n;agentForm",
    { tools: [] },
  );
  const original = config(1).agents[0];
  original.behavior.actions.groupRead = true;
  const data = new FormData();
  assert.equal(form.parse(data, original).row.behavior.actions.groupRead, true);
  data.set("groupReadPresent", "1");
  assert.equal(
    form.parse(data, original).row.behavior.actions.groupRead,
    false,
  );
  data.set("groupReadEnabled", "on");
  assert.equal(form.parse(data, original).row.behavior.actions.groupRead, true);
});

test("real configuration removal revokes an in-flight tool capability before its late response", async (t) => {
  const f = setup(t);
  let entered;
  const started = new Promise((resolve) => {
    entered = resolve;
  });
  f.transport.groupMembers = async ({ signal }) => {
    entered();
    await new Promise((resolve) =>
      signal.addEventListener("abort", resolve, { once: true }),
    );
    return [member("30000", "owner")];
  };
  const rejected = assert.rejects(
    read(f, membersTool),
    /AGENT_PAUSED_OR_EXPIRED|TOOL_DISABLED|CONFIG_CONFLICT/,
  );
  await started;
  const next = structuredClone(f.runtime.config);
  next.agents[0].tools = next.agents[0].tools.filter(
    (name) => name !== membersTool,
  );
  await f.runtime.changeConfig(next, f.configStore.revision);
  await rejected;
  assert(f.ctx.controller.signal.aborted);
  assert(!f.runtime.agent("agent-0").tools.includes(membersTool));
  assert.equal(
    f.m.db
      .prepare("SELECT COUNT(*) AS n FROM events WHERE kind='external.read'")
      .get().n,
    0,
  );
});
