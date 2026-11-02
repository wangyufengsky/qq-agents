import test from "node:test";
import assert from "node:assert/strict";
import { OneBot } from "../src/transport/onebot.mjs";
import {
  projectGroupInfo,
  projectGroupMembers,
  GROUP_READ_MAX_MEMBERS,
} from "../src/transport/group-read.mjs";

const groupId = "20000";
const info = {
  group_id: 20000,
  group_name: "群资料",
  member_count: 3,
  max_member_count: 1000,
  memo: "PRIVATE_RAW_FIELD",
};
const row = (user_id = 30000, role = "member") => ({
  group_id: 20000,
  user_id,
  nickname: "成员",
  card: "名片",
  title: "头衔",
  role,
  phone: "PRIVATE_RAW_FIELD",
});
function setup(data, { status = 200, response, fetchImpl } = {}) {
  const calls = [];
  const bot = new OneBot(
    { accountId: "10000", httpUrl: "http://gateway.invalid" },
    {
      fetchImpl: async (url, init) => {
        calls.push({ url: String(url), init });
        if (fetchImpl) return fetchImpl(url, init);
        return new Response(
          response ?? JSON.stringify({ status: "ok", retcode: 0, data }),
          { status },
        );
      },
    },
  );
  return { bot, calls };
}
const failure = (code) => (error) => {
  assert.equal(error.message, code);
  assert.equal(error.cause, undefined);
  assert.doesNotMatch(String(error), /PRIVATE_RAW_FIELD|credential-fixture/);
  return true;
};

test("group info uses only uncached bounded group endpoint and projects supported fields", async () => {
  const f = setup(info);
  assert.deepEqual(await f.bot.groupInfo({ groupId }), {
    groupId,
    name: "群资料",
    memberCount: 3,
    maxMemberCount: 1000,
  });
  assert.equal(f.calls[0].url, "http://gateway.invalid/get_group_info");
  assert.deepEqual(JSON.parse(f.calls[0].init.body), {
    group_id: groupId,
    no_cache: true,
  });
  assert.equal(f.calls[0].init.redirect, "error");
  assert(f.calls[0].init.signal instanceof AbortSignal);
});

test("member list uses uncached bounded endpoint and returns only identity and group-visible fields", async () => {
  const f = setup([row(30000, "owner"), row(30001, "admin"), row(30002)]);
  const result = await f.bot.groupMembers({ groupId });
  assert.equal(f.calls[0].url, "http://gateway.invalid/get_group_member_list");
  assert.deepEqual(JSON.parse(f.calls[0].init.body), {
    group_id: groupId,
    no_cache: true,
  });
  assert.deepEqual(result[0], {
    groupId,
    userId: "30000",
    nickname: "成员",
    card: "名片",
    title: "头衔",
    role: "owner",
  });
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_RAW_FIELD|phone/);
});

test("group projections validate camel-case results a second time without carrying raw extras", () => {
  assert.deepEqual(
    projectGroupInfo(
      {
        groupId,
        name: "name",
        memberCount: 1,
        maxMemberCount: 10,
        raw: "PRIVATE_RAW_FIELD",
      },
      groupId,
    ),
    { groupId, name: "name", memberCount: 1, maxMemberCount: 10 },
  );
  assert.deepEqual(
    projectGroupMembers(
      [
        {
          groupId,
          userId: "30000",
          nickname: "n",
          role: "admin",
          raw: "PRIVATE_RAW_FIELD",
        },
      ],
      groupId,
    ),
    [
      {
        groupId,
        userId: "30000",
        nickname: "n",
        card: null,
        title: null,
        role: "admin",
      },
    ],
  );
});

test("unknown or missing roles remain unknown instead of granting member identity", async () => {
  const f = setup([
    row(30000, "unknown"),
    row(30001, null),
    { group_id: 20000, user_id: 30002 },
  ]);
  assert.deepEqual(
    (await f.bot.groupMembers({ groupId })).map((m) => m.role),
    [null, null, null],
  );
});

test("missing counts and names remain explicitly unknown", async () => {
  assert.deepEqual(
    await setup({ group_id: 20000 }).bot.groupInfo({ groupId }),
    { groupId, name: null, memberCount: null, maxMemberCount: null },
  );
  assert.deepEqual(await setup([]).bot.groupMembers({ groupId }), []);
});

test("invalid or mismatched group identity fails closed before returning data", async () => {
  for (const group_id of [
    null,
    undefined,
    "20001",
    "020000",
    "0",
    "-1",
    20000.5,
    Number.MAX_SAFE_INTEGER + 1,
  ])
    await assert.rejects(
      setup({ ...info, group_id }).bot.groupInfo({ groupId }),
      failure("GROUP_READ_IDENTITY_MISMATCH"),
    );
  await assert.rejects(
    setup([{ ...row(), group_id: "20001" }]).bot.groupMembers({ groupId }),
    failure("GROUP_READ_IDENTITY_MISMATCH"),
  );
});

test("invalid and duplicate member identities fail closed", async () => {
  for (const user_id of [
    null,
    undefined,
    "030000",
    "0",
    -1,
    0.5,
    Number.MAX_SAFE_INTEGER + 1,
  ])
    await assert.rejects(
      setup([{ ...row(), user_id }]).bot.groupMembers({ groupId }),
      failure("GROUP_READ_IDENTITY_MISMATCH"),
    );
  await assert.rejects(
    setup([row(30000), row("30000")]).bot.groupMembers({ groupId }),
    failure("GROUP_READ_IDENTITY_MISMATCH"),
  );
});

test("multiple owners or malformed rows cannot mint a group summary", async () => {
  await assert.rejects(
    setup([row(30000, "owner"), row(30001, "owner")]).bot.groupMembers({
      groupId,
    }),
    failure("GROUP_READ_RESPONSE_INVALID"),
  );
  for (const data of [
    null,
    {},
    [null],
    [[]],
    ["member"],
    [{ ...row(), role: {} }],
    [{ ...row(), nickname: 123 }],
  ])
    await assert.rejects(
      setup(data).bot.groupMembers({ groupId }),
      failure("GROUP_READ_RESPONSE_INVALID"),
    );
});

test("invalid or contradictory counts fail closed while strings are bounded", async () => {
  for (const value of [-1, 0.5, "3", 1000001])
    await assert.rejects(
      setup({ ...info, member_count: value }).bot.groupInfo({ groupId }),
      failure("GROUP_READ_RESPONSE_INVALID"),
    );
  await assert.rejects(
    setup({ ...info, max_member_count: 1 }).bot.groupInfo({ groupId }),
    failure("GROUP_READ_RESPONSE_INVALID"),
  );
  assert.throws(
    () => projectGroupInfo({ groupId, memberCount: Infinity }, groupId),
    /GROUP_READ_RESPONSE_INVALID/,
  );
  const result = await setup({
    ...info,
    group_name: "n".repeat(500),
  }).bot.groupInfo({ groupId });
  assert.equal(result.name.length, 200);
});

test("member and packet limits reject rather than truncate an allegedly complete snapshot", async () => {
  await assert.rejects(
    setup(
      Array.from({ length: GROUP_READ_MAX_MEMBERS + 1 }, (_, i) =>
        row(30000 + i),
      ),
    ).bot.groupMembers({ groupId }),
    failure("GROUP_READ_LIMIT_EXCEEDED"),
  );
  await assert.rejects(
    setup({ ...info, padding: "x".repeat(4 * 1024 * 1024) }).bot.groupInfo({
      groupId,
    }),
    failure("GROUP_READ_LIMIT_EXCEEDED"),
  );
});

test("unsupported endpoints retain stable capability failure without provider details", async () => {
  for (const method of ["groupInfo", "groupMembers"]) {
    await assert.rejects(
      setup(null, { status: 404 }).bot[method]({ groupId }),
      failure("GROUP_READ_UNSUPPORTED"),
    );
    await assert.rejects(
      setup(null, {
        response: JSON.stringify({
          status: "failed",
          retcode: 1404,
          message: "unsupported credential-fixture",
        }),
      }).bot[method]({ groupId }),
      failure("GROUP_READ_UNSUPPORTED"),
    );
  }
});

test("gateway and unreadable transport failures expose no raw cause or provider text", async () => {
  for (const options of [
    { status: 500 },
    { response: "credential-fixture invalid JSON" },
    {
      fetchImpl: async () => {
        throw Error("credential-fixture network failure");
      },
    },
  ])
    await assert.rejects(
      setup(null, options).bot.groupInfo({ groupId }),
      failure("GROUP_READ_FAILED"),
    );
});

test("cancel before dispatch and after response cannot return data", async () => {
  const controller = new AbortController();
  controller.abort();
  const f = setup(info);
  await assert.rejects(
    f.bot.groupInfo({ groupId, signal: controller.signal }),
    failure("ABORTED"),
  );
  assert.equal(f.calls.length, 0);
  const later = new AbortController();
  const changed = setup(null, {
    fetchImpl: async () => {
      later.abort();
      return new Response(
        JSON.stringify({ status: "ok", retcode: 0, data: [row()] }),
      );
    },
  });
  await assert.rejects(
    changed.bot.groupMembers({ groupId, signal: later.signal }),
    failure("ABORTED"),
  );
});
