import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import path from "node:path";
import test from "node:test";
import { createDesktopRoomHost } from "../src/home/desktop-host.mjs";
import { DesktopRoleMailbox } from "../src/home/desktop-role-mailbox.mjs";
import { MemoryStore } from "../src/memory/store.mjs";
import { config, context, fixture, settle } from "./helpers.mjs";

const tool = "desktop_role_mail_send";
const toDesktop = { requestId: "for-desktop", text: "抽空一起看看窗外吧" };
const toSubject = { requestId: "for-subject", text: "窗边的光线很柔和" };

test("one role exchanges durable ordinary mail through both normal model inputs", async (t) => {
  const cfg = config(2);
  cfg.desktopHome.enabled = true;
  cfg.agents.forEach((agent) => (agent.subject.enabled = true));
  const subjectPrompts = [];
  const subjectReceipts = [];
  const f = fixture(t, {
    cfg,
    createDesktopHost: createDesktopRoomHost,
    run: async (p) => {
      if (p.conversation !== "@subject") return;
      if (/"desktopInvitation":\{"id":/.test(p.prompt)) {
        const id = /"desktopInvitation":\{"id":"([^"]+)"/.exec(p.prompt)[1];
        await p.callTool("desktop_invitation_decide", { id, action: "accept" });
        return;
      }
      if (p.agent.id !== "agent-0") {
        assert.doesNotMatch(p.prompt, /窗边的光线很柔和/);
        return;
      }
      subjectPrompts.push(p.prompt);
      subjectReceipts.push(await p.callTool(tool, toDesktop));
    },
  });
  const { runtime } = f;
  const host = runtime.desktopVisits;
  const mailbox = runtime.desktopRoleMailbox;
  const client = randomUUID();
  const command = (action, data) => host.command({ client, action, data });
  command("sync");

  const blockedChat = context(runtime, "agent-0", "group:20000");
  await assert.rejects(
    runtime.callTool(blockedChat, tool, toDesktop),
    /TOOL_DISABLED/,
  );
  const protectedSubject = context(runtime, "agent-0", "@subject");
  protectedSubject.privateRead.add("operations:fixture");
  await assert.rejects(
    runtime.callTool(protectedSubject, tool, toDesktop),
    /HOME_SOURCE_DENIED/,
  );
  runtime.capabilities.delete(blockedChat.token);
  runtime.capabilities.delete(protectedSubject.token);

  await runtime.wake("agent-0", "@subject");
  assert.equal(subjectReceipts[0].status, "queued");
  assert.equal(host.live.visits.has("agent-0"), false);
  assert.deepEqual(mailbox.pending("agent-1", "@desktop"), []);
  const reopened = new MemoryStore(path.join(f.root, "memory.sqlite"));
  try {
    const afterRestart = new DesktopRoleMailbox({ memory: reopened });
    assert.deepEqual(
      afterRestart.pending("agent-0", "@desktop").map(({ text }) => text),
      [toDesktop.text],
    );
  } finally {
    reopened.close();
  }

  const backend = runtime.backendConnections.adapter(runtime.agent("agent-0"));
  const desktopPrompts = [];
  const desktopReceipts = [];
  const desktopErrors = [];
  let failBeforeInput = true;
  backend.runDesktop = async (p) => {
    p.beforeInput();
    desktopPrompts.push(p.prompt);
    if (failBeforeInput) throw Error("BACKEND_UNAVAILABLE");
    p.onInputSubmitted();
    try {
      desktopReceipts.push(await p.callTool(tool, toSubject));
    } catch (error) {
      desktopErrors.push(error.message);
    }
    await p.callTool("desktop_room_decide", { action: "silent" });
  };

  command("invite", "agent-0");
  await settle(runtime);
  await new Promise(setImmediate);
  assert.equal(host.live.visits.has("agent-0"), true);

  host.refresh();
  await host.live.activities.get("agent-0")?.done;
  assert.match(
    desktopPrompts.at(-1),
    /来自你的主人格的留言.*抽空一起看看窗外吧/,
  );
  assert.equal(mailbox.pending("agent-0", "@desktop").length, 1);

  command("leave", "agent-0");
  assert.equal(host.live.visits.has("agent-0"), false);
  assert.equal(mailbox.pending("agent-0", "@desktop").length, 1);

  command("invite", "agent-0");
  await settle(runtime);
  await new Promise(setImmediate);
  assert.equal(host.live.visits.has("agent-0"), true);
  failBeforeInput = false;
  host.refresh();
  await host.live.activities.get("agent-0")?.done;
  assert.match(desktopPrompts.at(-1), /抽空一起看看窗外吧/);
  assert.deepEqual(desktopErrors, []);
  assert.equal(desktopReceipts.at(-1)?.status, "queued");
  assert.deepEqual(mailbox.pending("agent-0", "@desktop"), []);

  await runtime.wake("agent-1", "@subject");
  runtime.subject.tick();
  await settle(runtime);
  assert.match(subjectPrompts.at(-1), /来自你的桌宠的留言.*窗边的光线很柔和/);
  assert.equal(subjectReceipts.at(-1).status, "received");
  assert.deepEqual(mailbox.pending("agent-0", "@subject"), []);
  await runtime.wake("agent-0", "@subject");
  assert.doesNotMatch(subjectPrompts.at(-1), /窗边的光线很柔和/);

  const sender = context(runtime, "agent-0", "@subject");
  await assert.rejects(
    runtime.callTool(sender, tool, { ...toDesktop, text: "换了正文" }),
    /DESKTOP_ROLE_MAIL_CONFLICT/,
  );
  for (const transport of runtime.transports.values())
    assert.deepEqual(transport.sent, []);
});
