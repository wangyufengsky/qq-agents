import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { desktopToken } from "../src/home/desktop-auth.mjs";
import { createServer } from "../src/server.mjs";
import { config, fixture } from "./helpers.mjs";

test("a successful idle diary tool call publishes its title only to the matching desktop visit", async (t) => {
  const cfg = config(2);
  cfg.desktopHome.enabled = true;
  cfg.desktopHome.activityRoles = cfg.agents.map(({ id }) => id);
  cfg.agents[0].subject.enabled = true;
  const diary = { title: "一页空闲日记", body: "只在获准打开后看到的内容" };
  let saved;
  const { runtime, store } = fixture(t, {
    cfg,
    run: async (params) => {
      if (params.conversation === "@subject") {
        saved = await params.callTool("diary_write", diary);
      }
    },
  });
  store
    .bind("agent-0")
    .diaryWrite({ title: "此前的空闲日记", body: "留在记忆里" }, "ai-diary", {
      conversation: "@subject",
    });
  const host = runtime.desktopVisits;
  const client = randomUUID();
  host.command({ client, action: "sync", data: true });
  const [actor, other] = host.live.room.roles;
  for (const role of [actor, other]) {
    host.live.room.members[role.id] = "invited";
    host.live.admit(role);
  }
  const identity = (agentId) =>
    host.clientSnapshot().room.roles.find(({ id }) => id === agentId);
  assert.equal(identity(actor.id).statusCard, undefined);

  await runtime.wake(actor.id, "@subject");
  assert.ok(saved?.id);
  const current = identity(actor.id);
  const { statusCard } = current;
  assert.equal(statusCard?.title, diary.title);
  assert.equal(statusCard?.kind, "diary");
  assert.notEqual(statusCard.ref, saved.id);
  assert.equal(identity(other.id).statusCard, undefined);
  assert.ok(!JSON.stringify(host.clientSnapshot()).includes(diary.body));

  const token = randomUUID();
  const server = createServer({ runtime, token, allowLive: true });
  const port = await server.listen();
  t.after(() => server.close());
  const url = `http://127.0.0.1:${port}/api/desktop-home/status-card`;
  const request = {
    client,
    roomEpoch: host.live.room.epoch,
    agentId: actor.id,
    visitId: current.bodyVisitId,
    ref: statusCard.ref,
  };
  const open = (payload, credential = desktopToken(token)) =>
    fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-desktop-home-token": credential,
      },
      body: JSON.stringify(payload),
    });
  const denied = await open(request, token);
  assert.equal(denied.status, 401);
  const wrongRole = await open({
    ...request,
    agentId: other.id,
    visitId: identity(other.id).bodyVisitId,
  });
  assert.ok(!wrongRole.ok);
  const opened = await open(request);
  assert.equal(opened.status, 200);
  assert.deepEqual(await opened.json(), {
    status: "ok",
    kind: "diary",
    title: diary.title,
    text: diary.body,
  });

  store.transaction(() => {
    store.db.prepare("DELETE FROM diary_revisions WHERE id=?").run(saved.id);
    store.db
      .prepare("DELETE FROM diaries WHERE agent_id=? AND id=?")
      .run(actor.id, saved.id);
  });
  const deleted = await open(request);
  assert.ok(!deleted.ok);
  assert.equal(identity(actor.id).statusCard, undefined);
});
