import assert from "node:assert/strict";
import test from "node:test";
import { LiveRoom } from "../desktop/home/live-room.mjs";
import { createRoom, roles } from "../desktop/home/room.mjs";

const [, dragon, cat] = roles;

function harness() {
  const room = createRoom();
  const jobs = [];
  const retired = [];
  const live = new LiveRoom(
    room,
    {
      roles: ["dragon", "cat"],
      run(request, signal, canStart) {
        return new Promise((resolve, reject) =>
          jobs.push({ request, signal, canStart, resolve, reject }),
        );
      },
      retire(actor, session) {
        retired.push({ actor, session });
      },
      async close() {},
    },
    () => {},
  );
  const settle = async (job, answer) => {
    job.resolve(answer);
    await new Promise(setImmediate);
  };
  async function arrive(role) {
    void live.invite(role);
    await settle(jobs.at(-1), { action: "accept" });
  }
  return { room, live, jobs, retired, settle, arrive };
}

test("desktop roles decide invitations and share six charged runs, including silence", async () => {
  const { room, live, jobs, settle, arrive } = harness();
  void live.invite(dragon);
  assert.equal(jobs[0].request.kind, "invitation");
  assert.equal(room.budget, 6);
  await settle(jobs[0], { action: "decline" });
  assert.equal(room.members.dragon, "home");
  await arrive(dragon);
  await arrive(cat);

  live.send("@猫 开始");
  assert.equal(jobs.at(-1).request.actor, "cat");
  for (let index = 0; index < 6; index++) {
    assert.equal(room.budget, 5 - index);
    await settle(
      jobs.at(-1),
      index === 5
        ? { action: "silent" }
        : { action: "say", text: `回复 ${index}` },
    );
  }
  assert.equal(jobs.filter(({ request }) => request.kind === "chat").length, 6);
  assert.equal(room.budget, 0);
  assert.equal(room.waiting.length, 0);

  live.tick(room.nextRefill - 1);
  assert.equal(room.budget, 0);
  live.tick(room.nextRefill);
  assert.equal(room.budget, 6);
  assert.equal(jobs.length, 9);
  live.interval(0);
  assert.equal(room.nextRefill, null);
  live.send("管理员发言");
  assert.equal(room.budget, 5);
});

test("new arrival does not rotate other sessions or receive earlier messages", async () => {
  const { room, live, jobs, retired, settle, arrive } = harness();
  await arrive(dragon);
  const invitation = jobs.at(-1).request;
  live.send("猫进门前的消息");
  const old = jobs.at(-1);
  assert.equal(old.request.session, invitation.session);
  await arrive(cat);
  assert.equal(old.signal.aborted, false);
  assert.deepEqual(retired, []);
  await settle(old, { action: "say", text: "猫进门后的新回复" });
  assert(room.messages.some(({ text }) => text === "猫进门后的新回复"));
  const arrivalChat = jobs.at(-1);
  assert.equal(arrivalChat.request.actor, "cat");
  assert.deepEqual(arrivalChat.request.messages, [
    { speaker: "龙", text: "猫进门后的新回复" },
  ]);
  await settle(arrivalChat, { action: "silent" });

  live.send("新受众的第一句");
  const next = jobs.at(-1);
  assert.equal(next.request.session, old.request.session);
  assert.deepEqual(next.request.messages, [
    { speaker: "龙", text: "猫进门后的新回复" },
    { speaker: "管理员", text: "新受众的第一句" },
  ]);
  await settle(next, { action: "say", text: "新回复" });
  const peer = jobs.at(-1);
  assert(peer.request.messages.some(({ text }) => text === "新回复"));
  assert(!peer.request.messages.some(({ text }) => text === "猫进门前的消息"));
});

test("leaving fences an in-flight reply and rejoining skips missed chat in the same session", async () => {
  const { room, live, jobs, settle, arrive } = harness();
  await arrive(dragon);
  await arrive(cat);
  live.send("@龙 你先说");
  const leaving = jobs.at(-1);
  live.leave(dragon);
  assert.equal(leaving.signal.aborted, false);
  assert.equal(leaving.canStart(), false);
  await settle(leaving, { action: "say", text: "迟到" });
  assert(!room.messages.some(({ text }) => text === "迟到"));
  assert.equal(jobs.at(-1).request.actor, "cat");
  await settle(jobs.at(-1), { action: "silent" });

  live.send("回家之后只有猫能听见");
  assert.equal(jobs.at(-1).request.actor, "cat");
  await settle(jobs.at(-1), { action: "silent" });
  await arrive(dragon);
  live.send("@龙 又见面了");
  const returning = jobs.at(-1);
  assert.equal(returning.request.session, leaving.request.session);
  assert(
    !returning.request.messages.some(({ text }) =>
      text.includes("只有猫能听见"),
    ),
  );
  await settle(returning, { action: "leave" });
  assert.equal(room.members.dragon, "home");
  assert(room.messages.some(({ text }) => text === "龙自己回家了。"));
});

test("cancelled invitations cannot join and a new admin message replaces an active batch", async () => {
  const { room, live, jobs, settle, arrive } = harness();
  void live.invite(dragon);
  const invitation = jobs[0];
  await live.invite(dragon);
  assert(invitation.signal.aborted);
  await settle(invitation, { action: "accept" });
  assert.equal(room.members.dragon, "home");

  await arrive(dragon);
  live.send("第一条");
  const previous = jobs.at(-1);
  live.send("第二条");
  assert.equal(previous.signal.aborted, false);
  assert.equal(room.budget, 6);
  await settle(previous, { action: "say", text: "迟到的第一条回复" });
  assert.equal(room.budget, 5);
  assert(!room.messages.some(({ text }) => text === "迟到的第一条回复"));
  assert.equal(jobs.at(-1).request.session, previous.request.session);
  assert(jobs.at(-1).request.messages.some(({ text }) => text === "第二条"));
});

test("opt-in knocks require permission, are rate-limited, and preserve the shared chat quota", async () => {
  const { room, live, jobs, settle } = harness();
  const now = Date.now();
  await live.offerOpportunity({ trial: true, now });
  assert.equal(jobs.length, 0);
  live.setDoorMode("welcome", now);
  await live.offerOpportunity({ now });
  assert.equal(jobs.length, 0);
  void live.offerOpportunity({ trial: true, now });
  const opportunity = jobs.at(-1);
  assert.equal(opportunity.request.kind, "opportunity");
  await settle(opportunity, { action: "knock", text: "来坐一会儿" });
  assert.equal(room.members.dragon, "home");
  assert.equal(room.budget, 6);
  await live.offerOpportunity({ trial: true, now: now + 1 });
  assert.equal(jobs.length, 1);
  live.answerKnock(true);
  assert.equal(room.members.dragon, "here");
  assert.equal(room.budget, 6);
  assert.equal(jobs.length, 1);
});

test("busy mode cancels a pending opportunity and suppresses its late knock", async () => {
  const { room, live, jobs, settle } = harness();
  live.setDoorMode("welcome");
  void live.offerOpportunity({ trial: true });
  const opportunity = jobs.at(-1);
  live.setDoorMode("busy");
  assert.equal(room.notice, "正在忙，主动来访已暂停。");
  assert.equal(opportunity.signal.aborted, true);
  await settle(opportunity, { action: "knock", text: "late" });
  assert.equal(live.knock, null);
  assert.equal(room.members.dragon, "home");
  await live.offerOpportunity({ trial: true });
  assert.equal(jobs.length, 1);
});

test("an accepted invitation is reused for the first chat with the final audience", async () => {
  const { live, jobs, retired, settle, arrive } = harness();
  await arrive(dragon);
  const invitation = jobs.at(-1).request;
  await arrive(cat);
  live.send("@龙 你先说");
  const firstChat = jobs.at(-1);
  assert.equal(firstChat.request.kind, "chat");
  assert.equal(firstChat.request.session, invitation.session);
  assert(!retired.some(({ session }) => session === invitation.session));
  await settle(firstChat, { action: "silent" });
});

test("QQ waiting before model admission does not retire the desktop session", async () => {
  const { live, jobs, room, retired, settle, arrive } = harness();
  await arrive(dragon);
  live.send("第一条");
  const first = jobs.at(-1);
  await settle(first, { action: "silent" });
  live.send("第二条");
  jobs.at(-1).reject(
    Object.assign(Error("DESKTOP_QQ_PRIORITY"), {
      desktopSessionUntouched: true,
    }),
  );
  await new Promise(setImmediate);
  assert.equal(room.members.dragon, "here");
  assert(room.messages.some(({ text }) => text.includes("先去处理 QQ")));
  assert(!retired.some(({ session }) => session === first.request.session));
  live.send("回来以后");
  assert.equal(jobs.at(-1).request.session, first.request.session);
});

test("always-welcome in the isolated room lets a resident choose silence or enter", async () => {
  const { room, live, jobs, settle } = harness();
  const now = Date.now();
  live.setDoorMode("always", now);
  void live.offerOpportunity({ trial: true, now });
  assert.equal(jobs[0].request.directVisit, true);
  await settle(jobs[0], { action: "silent" });
  assert.equal(room.members.dragon, "home");

  void live.offerOpportunity({ now: now + 30 * 60_000 });
  await settle(jobs[1], { action: "knock", text: "来坐一会儿" });
  assert.equal(room.members.cat, "here");
  assert.equal(live.knock, null);
  assert.equal(room.budget, room.maxTurns);
});
