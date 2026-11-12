import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  DESKTOP_ADMINISTRATOR,
  DesktopArchive,
} from "../src/home/desktop-archive.mjs";
import { MemoryStore } from "../src/memory/store.mjs";
import { restoreExport } from "../src/memory/migrate.mjs";
import { elsewhereForTurn } from "../src/core/elsewhere.mjs";
import {
  config,
  context,
  deliverFixtureToolOutput,
  fixture,
  temp,
} from "./helpers.mjs";

const now = Date.parse("2026-11-01T12:00:00Z");
const identities = {
  [DESKTOP_ADMINISTRATOR]: "30000",
  "agent-0": "10000",
  "agent-1": "10001",
};

function publish(archive, data = {}) {
  return archive.publish({
    actor: "admin",
    speakerType: data.actor ? "agent" : "administrator",
    speaker: "管理员",
    text: "桌面消息",
    now,
    present: ["agent-0"],
    identities,
    targets: [],
    ...data,
  });
}

test("the timeline survives reopening; per-role projection and read receipts preserve the actual audience", (t) => {
  const dir = temp(t);
  const file = path.join(dir, "room.sqlite");
  let store = new MemoryStore(file);
  const archive = new DesktopArchive(store);
  const attachments = [
    { id: "example", name: "example.txt", mimeType: "text/plain", size: 3 },
  ];
  const first = publish(archive, { attachments });
  const second = publish(archive, {
    actor: "agent-0",
    speaker: "访客",
    present: ["agent-0", "agent-1"],
  });
  const opening = archive.opening("agent-0", 0);
  assert.deepEqual(
    opening.map(({ direction }) => direction),
    ["in", "out"],
  );
  assert.deepEqual(opening[0].attachments, attachments);
  assert.deepEqual(
    archive.opening("agent-1", 0).map(({ messageId }) => messageId),
    [second.messageId],
  );
  assert.equal(
    archive.history({ beforeSeq: second.seq }).at(-1).messageId,
    first.messageId,
  );
  assert.deepEqual(archive.opening("agent-0", 0), opening);
  archive.commitOpening("agent-0", [opening[1]]);
  assert.deepEqual(archive.opening("agent-0", 0), [opening[0]]);
  const memory = store.bind("agent-0");
  assert.equal(memory.delivery(`desktop:${second.messageId}`).status, "sent");
  memory.setState("@desktop", { elsewhereWordsThroughSeq: opening[1].seq });
  const exported = memory.export();
  assert.equal(Object.hasOwn(exported.tables, "desktop_messages"), false);
  store.close();

  store = new MemoryStore(file);
  t.after(() => store.close());
  assert.deepEqual(
    new DesktopArchive(store).history().map(({ messageId }) => messageId),
    [first.messageId, second.messageId],
  );
  const restored = new MemoryStore(path.join(dir, "restored.sqlite"));
  t.after(() => restored.close());
  restored.bind("agent-1").append({
    dedupe: "existing",
    conversation: "group:20000",
    kind: "message.received",
  });
  const agent = restored.bind("agent-0");
  restoreExport(agent, exported);
  assert.equal(new DesktopArchive(restored).history().length, 0);
  const sent = agent.readRecord({ id: opening[1].id });
  assert.equal(agent.state("@desktop").elsewhereWordsThroughSeq, sent.seq);
  assert.equal(
    restored.db
      .prepare(
        "SELECT summary_only FROM message_progress WHERE agent_id=? AND conversation=? AND seq=?",
      )
      .get("agent-0", "@desktop", sent.seq)?.summary_only,
    0,
  );
  assert.equal(agent.delivery(`desktop:${second.messageId}`).status, "sent");
});

test("desktop elsewhere uses explicit people, actual input receipts, confirmed own words and normal source protection", (t) => {
  const { runtime, store } = fixture(t);
  const archive = new DesktopArchive(store);
  const memory = store.bind("agent-0");
  runtime.agent("agent-0").behavior.elsewhere.enabled = true;
  const incoming = publish(archive, { targets: ["agent-0"] });
  const unmapped = publish(archive, {
    identities: { ...identities, [DESKTOP_ADMINISTRATOR]: undefined },
    targets: ["agent-0"],
    now: now + 1,
  });
  const own = publish(archive, {
    actor: "agent-0",
    text: "已确认的桌面发言",
    now: now + 2,
  });
  const query = (conversation) =>
    elsewhereForTurn(
      runtime,
      { agentId: "agent-0", conversation, privateRead: new Set() },
      [],
      {
        fresh: true,
        accountId: "10000",
        personIds: ["30000"],
        now: now + 3,
      },
    );
  assert.equal(query("group:20000").items.length, 0);
  archive.commitOpening(
    "agent-0",
    archive
      .opening("agent-0", 0)
      .filter(({ roomSeq }) => roomSeq <= unmapped.seq),
  );
  assert.equal(query("group:20000").items[0].messages, 1);
  assert.equal(query("group:20000").words.items[0].excerpt, "已确认的桌面发言");
  assert.equal(query("@subject").words.items[0].where, "@desktop");
  assert.equal(
    query("group:20000").words.items[0].continuation.id,
    archive
      .opening("agent-0", incoming.seq)
      .find(({ roomSeq }) => roomSeq === own.seq).id,
  );
  for (const [messageId, status, protectedOperations] of [
    ["90000", "sent", false],
    ["90001", "sent", true],
    ["90002", "unknown", false],
  ]) {
    memory.reserveDelivery(messageId, "group:20000", { messageId });
    memory.completeDelivery(messageId, status, messageId);
    memory.append({
      conversation: "group:20000",
      dedupe: `test:${messageId}`,
      kind: "message.sent",
      direction: "out",
      status: "confirmed",
      messageId,
      body: messageId,
      payload: { requestId: messageId, protectedOperations },
      occurredAt: new Date(now + 3).toISOString(),
    });
  }
  assert.deepEqual(
    query("@desktop").words.items.map(({ excerpt }) => excerpt),
    ["90000"],
  );
});

test("bounded openings advance through only the delivered page of the current visit", (t) => {
  const { store } = fixture(t);
  const archive = new DesktopArchive(store);
  const previousVisit = publish(archive);
  const current = Array.from({ length: 30 }, () => publish(archive));
  const firstPage = archive.opening("agent-0", previousVisit.seq);
  assert.deepEqual(
    firstPage.map(({ messageId }) => messageId),
    current.slice(0, 24).map(({ messageId }) => messageId),
  );
  archive.commitOpening("agent-0", firstPage);
  assert.deepEqual(
    archive
      .opening("agent-0", firstPage.at(-1).roomSeq)
      .map(({ messageId }) => messageId),
    current.slice(24).map(({ messageId }) => messageId),
  );
  assert.equal(
    archive.opening("agent-0", 0)[0].messageId,
    previousVisit.messageId,
  );
});

test("a failed archive read does not claim the desktop client lease", (t) => {
  const cfg = config(1);
  cfg.desktopHome.enabled = true;
  const { runtime } = fixture(t, { cfg });
  const host = runtime.desktopVisits;
  const history = host.archive.history.bind(host.archive);
  host.archive.history = () => {
    throw Error("TEST_ARCHIVE_READ_FAILED");
  };
  assert.throws(
    () => host.command({ client: randomUUID(), action: "sync" }),
    /TEST_ARCHIVE_READ_FAILED/,
  );
  host.archive.history = history;
  const next = host.command({ client: randomUUID(), action: "sync" });
  assert.equal(next.room.live, true);
});

test("desktop turns acknowledge only submitted openings and public history stays outside personal experience", async (t) => {
  const cfg = config(2);
  cfg.desktopHome.enabled = true;
  for (const agent of cfg.agents) agent.subject.enabled = true;
  const { runtime, store } = fixture(t, {
    cfg,
    run: (p) =>
      p.callTool("desktop_invitation_decide", {
        id: /"desktopInvitation":\{"id":"([a-f0-9-]+)"/.exec(p.prompt)?.[1],
        action: "accept",
      }),
  });
  const host = runtime.desktopVisits;
  const client = randomUUID();
  const command = (action, data) => host.command({ client, action, data });
  const drain = async () => {
    while (runtime.work.size) {
      await Promise.allSettled([...runtime.work]);
      await new Promise(setImmediate);
    }
  };
  const seen = [];
  const personal = [];
  let rejectOpening = true;
  for (const actor of ["agent-0", "agent-1"]) {
    runtime.backendConnections.adapter(runtime.agent(actor)).runDesktop =
      async (p) => {
        p.beforeInput();
        p.assertCanStart();
        if (rejectOpening) throw Error("TEST_PREPARATION_FAILURE");
        p.onInputSubmitted();
        if (actor === "agent-1") {
          const history = await p.callTool("desktop_room_history", {});
          const mem = store.bind(actor);
          assert(
            !mem
              .state("@desktop")
              .disclosureTaint?.includes("context:@desktop"),
          );
          seen.push(await deliverFixtureToolOutput(p, history));
          assert(
            mem.state("@desktop").disclosureTaint.includes("context:@desktop"),
          );
          personal.push(
            await p.callTool("memory_search", {
              conversation: "@desktop",
            }),
          );
        }
        return p.callTool("desktop_room_decide", { action: "silent" });
      };
  }
  command("sync");
  command("invite", "agent-0");
  await drain();
  command("send", "先前只有第一位访客在场");
  await drain();
  const first = host.archive.history()[0];
  assert.equal(
    host.archive.opening("agent-0", 0)[0].messageId,
    first.messageId,
  );
  assert.equal(host.archive.opening("agent-1", 0).length, 0);
  command("invite", "agent-1");
  await drain();
  rejectOpening = false;
  command("send", "后来两位都在场");
  await drain();
  assert.equal(seen.length, 1);
  assert(seen[0].items.some(({ messageId }) => messageId === first.messageId));
  assert.equal(personal[0]?.items.length, 1);
  assert.equal(
    store.bind("agent-1").search({ conversation: "@desktop" }).items.length,
    1,
  );
  assert.equal(host.archive.opening("agent-0", 0).length, 0);
  assert.equal(host.archive.opening("agent-1", 0).length, 0);
  const qq = context(runtime, "agent-1", "group:20000");
  await assert.rejects(
    runtime.executeTool(qq, "desktop_room_history", {}),
    /TOOL_DISABLED/,
  );
});
