import test from "node:test";
import assert from "node:assert/strict";
import { fixture, context, config } from "./helpers.mjs";
import { HomeIntents } from "../src/home/intents.mjs";
function setup(t, options = {}) {
  const cfg = config();
  cfg.agents[0].subject.enabled = true;
  cfg.agents[0].home = {
    enabled: true,
    publishing: true,
    intents: { enabled: true, ...options },
  };
  const f = fixture(t, { cfg }),
    subject = context(f.runtime, "agent-0", "@subject"),
    chat = context(f.runtime, "agent-0", "group:20000");
  return {
    ...f,
    subject,
    chat,
    call: (name, args = {}, ctx = subject) =>
      f.runtime.executeTool(ctx, name, args),
  };
}
async function submit(
  f,
  ctx = f.chat,
  requestId = "intent-proposal-1",
  proposal = {
    kind: "room_scene_patch",
    operations: [{ action: "palette", palette: "rose" }],
  },
) {
  const view = await f.call("room_read", {}, ctx);
  return {
    ...(await f.call(
      "room_intent_submit",
      { identityGeneration: view.identityGeneration, requestId, proposal },
      ctx,
    )),
    identityGeneration: view.identityGeneration,
  };
}
function resolve(f, intent, action, extra = {}) {
  return f.call("room_intent_resolve", {
    identityGeneration: intent.identityGeneration,
    intentId: intent.intentId,
    action,
    ...extra,
  });
}
test("intent opt-in, real viewing, source ownership and atomic execute replay survive reconstruction", async (t) => {
  const f = setup(t),
    intent = await submit(f);
  assert.equal(intent.lastViewedAt, null);
  assert.equal(f.runtime.jobs.size, 0);
  assert.equal(
    (await f.call("room_intent_list", {}, f.chat)).items[0].lastViewedAt,
    null,
  );
  const stranger = context(f.runtime, "agent-0", "private:30000");
  assert.equal(
    (await f.call("room_intent_list", {}, stranger)).items.length,
    0,
  );
  await assert.rejects(
    f.call(
      "room_intent_cancel",
      {
        identityGeneration: intent.identityGeneration,
        intentId: intent.intentId,
      },
      stranger,
    ),
    /HOME_INTENT_NOT_FOUND/,
  );
  const listed = await f.call("room_intent_list");
  assert.ok(listed.items[0].lastViewedAt);
  assert.equal((await submit(f)).replayed, true);
  await resolve(f, intent, "accept");
  assert.equal(
    f.runtime.home.rooms.store.layout(intent.identityGeneration).layoutRevision,
    0,
  );
  const scene = await f.call("room_scene_read");
  const results = await Promise.all([
    resolve(f, intent, "execute", {
      expectedLayoutRevision: scene.layoutRevision,
    }),
    resolve(f, intent, "execute", {
      expectedLayoutRevision: scene.layoutRevision,
    }),
  ]);
  assert.ok(results[0].committed);
  assert.equal(
    f.runtime.home.rooms.store.layout(intent.identityGeneration).layoutRevision,
    1,
  );
  f.runtime.home.rooms.intents = new HomeIntents(f.runtime.home.rooms);
  assert.equal(
    (await resolve(f, intent, "execute", { expectedLayoutRevision: 0 })).status,
    "executed",
  );
  assert.equal(
    f.store.db
      .prepare("SELECT proposal FROM home_intents WHERE id=?")
      .get(intent.intentId).proposal,
    null,
  );
  assert.equal(
    (
      await f.call(
        "room_intent_cancel",
        {
          identityGeneration: intent.identityGeneration,
          intentId: intent.intentId,
        },
        f.chat,
      )
    ).status,
    "executed",
  );
  assert.equal(
    f.store.db.prepare("SELECT COUNT(*) n FROM home_operations").get().n,
    1,
  );
});
test("cancel, expiry, revocation and transaction failure cannot leave room side effects", async (t) => {
  const f = setup(t),
    cancelled = await submit(f);
  await resolve(f, cancelled, "accept");
  await f.call(
    "room_intent_cancel",
    {
      identityGeneration: cancelled.identityGeneration,
      intentId: cancelled.intentId,
    },
    f.chat,
  );
  await assert.rejects(
    resolve(f, cancelled, "execute", { expectedLayoutRevision: 0 }),
    /HOME_INTENT_STATE/,
  );
  const expired = await submit(f, f.chat, "intent-proposal-2");
  await resolve(f, expired, "accept");
  f.store.db
    .prepare("UPDATE home_intents SET expires_at=0 WHERE id=?")
    .run(expired.intentId);
  await assert.rejects(
    resolve(f, expired, "execute", { expectedLayoutRevision: 0 }),
    /HOME_INTENT_STATE/,
  );
  assert.equal(
    f.store.db
      .prepare("SELECT proposal FROM home_intents WHERE id=?")
      .get(expired.intentId).proposal,
    null,
  );
  const broken = await submit(f, f.chat, "intent-proposal-3");
  await resolve(f, broken, "accept");
  await f.call("room_scene_read");
  f.store.db.exec(
    "CREATE TRIGGER reject_intent_commit BEFORE UPDATE OF receipt ON home_intents WHEN NEW.receipt IS NOT NULL BEGIN SELECT RAISE(ABORT,'test_failure'); END",
  );
  await assert.rejects(
    resolve(f, broken, "execute", { expectedLayoutRevision: 0 }),
  );
  assert.equal(
    f.runtime.home.rooms.store.layout(broken.identityGeneration).layoutRevision,
    0,
  );
  assert.equal(
    f.store.db.prepare("SELECT COUNT(*) n FROM home_operations").get().n,
    0,
  );
  assert.equal(
    f.store.db
      .prepare("SELECT state FROM home_intents WHERE id=?")
      .get(broken.intentId).state,
    "accepted",
  );
  const failed = (
    await f.call("room_intent_list", { intentId: broken.intentId })
  ).items[0];
  assert.equal(failed.status, "accepted");
  assert.equal(failed.lastAttemptError, "HOME_INTENT_EXECUTION_FAILED");
  assert.ok(failed.lastAttemptAt);
  assert.equal(failed.executedAt, null);
  f.runtime.agent("agent-0").home.intents.enabled = false;
  await assert.rejects(
    resolve(f, broken, "execute", { expectedLayoutRevision: 0 }),
    /TOOL_DISABLED/,
  );
});
test("safe furniture proposals allow chat provenance while text and protected provenance fail closed", async (t) => {
  const f = setup(t),
    mem = f.store.bind("agent-0");
  const event = mem.append({
    dedupe: "intent-chat-source",
    conversation: "group:20000",
    kind: "message.received",
    direction: "in",
    status: "observed",
    body: "Synthetic source",
    payload: {},
  });
  f.chat.privateRead.add(event.id);
  await submit(f);
  await assert.rejects(
    submit(f, f.chat, "intent-text-denied", {
      kind: "room_publish",
      slot: "intro",
      title: "合成",
      body: "合成正文",
      source: "original-text",
    }),
    /HOME_SOURCE_DENIED/,
  );
  f.chat.privateRead.add("operations:test");
  // Protected context is checked before any proposal reaches storage.
  f.chat.protectedOperations = true;
  await assert.rejects(
    submit(f, f.chat, "intent-protected"),
    /HOME_SOURCE_DENIED/,
  );
});
test("pending and daily limits, defaults and hints remain independent of activity", async (t) => {
  const f = setup(t, { maxPending: 1, maxSubmissionsPerDay: 2 });
  const first = await submit(f);
  assert.equal(f.runtime.home.rooms.intents.hint("agent-0").pending, 1);
  await assert.rejects(
    submit(f, f.chat, "intent-limit-two"),
    /HOME_INTENT_LIMIT/,
  );
  await resolve(f, first, "reject");
  const second = await submit(f, f.chat, "intent-limit-two");
  await resolve(f, second, "reject");
  await assert.rejects(
    submit(f, f.chat, "intent-limit-three"),
    /HOME_INTENT_LIMIT/,
  );
  f.runtime.agent("agent-0").home.intents.hints = false;
  assert.equal(f.runtime.home.rooms.intents.hint("agent-0"), null);
  assert.equal(f.runtime.jobs.size, 0);
});

test("text intent executes once, removes its body, and terminal submission replay keeps evidence", async (t) => {
  const f = setup(t),
    intent = await submit(f, f.subject, "intent-publish-ok", {
      kind: "room_publish",
      slot: "intro",
      title: "合成原创",
      body: "合成作品",
      source: "original-text",
    });
  await resolve(f, intent, "accept");
  const current = await f.call("room_read");
  await resolve(f, intent, "execute", {
    expectedItemRevision: current.items[0].itemRevision,
  });
  const result = await submit(f, f.subject, "intent-publish-ok", {
    kind: "room_publish",
    slot: "intro",
    title: "合成原创",
    body: "合成作品",
    source: "original-text",
  });
  assert.equal(result.replayed, true);
  assert.equal(result.status, "executed");
  assert.equal(result.proposal, undefined);
  await assert.rejects(
    submit(f, f.subject, "intent-publish-ok", {
      kind: "room_publish",
      slot: "intro",
      title: "合成原创",
      body: "已变更",
      source: "original-text",
    }),
    /HOME_REQUEST_CONFLICT/,
  );
  assert.equal((await f.call("room_read")).items[0].body, "合成作品");
  await assert.rejects(
    submit(f, f.chat, "intent-invalid-name", {
      kind: "room_scene_patch",
      operations: [
        { action: "object", instanceId: "free-private-text", value: { dx: 0 } },
      ],
    }),
    /HOME_SCENE_INVALID/,
  );
});

test("a fresh process restores pending metadata and executed receipts from a full SQLite backup", async (t) => {
  const f = setup(t),
    done = await submit(f);
  await resolve(f, done, "accept");
  await f.call("room_scene_read");
  await resolve(f, done, "execute", { expectedLayoutRevision: 0 });
  const pending = await submit(f, f.chat, "backup-pending-1");
  const { backupDatabase } = await import("../src/memory/backup.mjs");
  const { spawnSync } = await import("node:child_process");
  const file = f.root + "/intent-backup.sqlite";
  assert.equal((await backupDatabase(f.store.file, file)).integrity, "ok");
  const script = `
 import {MemoryStore} from ${JSON.stringify(new URL("../src/memory/store.mjs", import.meta.url).href)};
 import {HomeRooms} from ${JSON.stringify(new URL("../src/home/rooms.mjs", import.meta.url).href)};
 const memory=new MemoryStore(process.argv[1]);
 const runtime={memory,assertActive:()=>({id:'agent-0',home:{enabled:true,publishing:true,intents:{enabled:true}}}),now:Date.now,maintenance:{active:false}};
 const rooms=new HomeRooms({runtime,generation:()=>process.argv[2]});
 const ctx={agentId:'agent-0',conversation:'@subject'};
 const result=rooms.intents.tool(ctx,'room_intent_resolve',{identityGeneration:process.argv[2],intentId:process.argv[3],action:'execute',expectedLayoutRevision:0});
 const waiting=rooms.intents.tool(ctx,'room_intent_list',{intentId:process.argv[4]});
 process.stdout.write(JSON.stringify({result,waiting,writes:memory.db.prepare('SELECT COUNT(*) n FROM home_operations').get().n,revision:rooms.store.layout(process.argv[2]).layoutRevision}));
 memory.close();`;
  const child = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      script,
      file,
      done.identityGeneration,
      done.intentId,
      pending.intentId,
    ],
    { encoding: "utf8", timeout: 30000 },
  );
  assert.equal(child.status, 0, child.stderr);
  const restored = JSON.parse(child.stdout);
  assert.equal(restored.result.status, "executed");
  assert.ok(restored.result.executedAt);
  assert.equal(restored.waiting.items[0].status, "pending");
  assert.equal(restored.waiting.items[0].proposal.kind, "room_scene_patch");
  assert.equal(restored.writes, 1);
  assert.equal(restored.revision, 1);
});

test("maintenance blocks ordinary submit and cancel without granting subject write authority", async (t) => {
  const f = setup(t),
    intent = await submit(f);
  f.runtime.configChanging = true;
  await assert.rejects(
    submit(f, f.chat, "maintenance-submit"),
    /UPDATE_IN_PROGRESS/,
  );
  await assert.rejects(
    f.call(
      "room_intent_cancel",
      {
        identityGeneration: intent.identityGeneration,
        intentId: intent.intentId,
      },
      f.chat,
    ),
    /UPDATE_IN_PROGRESS/,
  );
  f.runtime.configChanging = false;
  assert.equal(
    (await f.call("room_intent_list", {}, f.chat)).items[0].status,
    "pending",
  );
});

test("every retained furniture operation rejects hidden text or invalid versions before later reset or overwrite", async (t) => {
  const f = setup(t);
  for (const [index, ending] of [
    [{ action: "reset-object", instanceId: "desk" }],
    [
      {
        action: "object",
        instanceId: "desk",
        value: { asset: "desk", assetVersion: 1 },
      },
    ],
  ].entries()) {
    for (const [field, value] of [
      ["asset", "Synthetic private chat text"],
      ["assetVersion", 999],
    ]) {
      const proposal = {
        kind: "room_scene_patch",
        operations: [
          { action: "object", instanceId: "desk", value: { [field]: value } },
          ...ending,
        ],
      };
      await assert.rejects(
        submit(f, f.chat, `retained-${index}-${field}`, proposal),
        /HOME_SCENE_INVALID/,
      );
    }
  }
  assert.equal(
    f.store.db.prepare("SELECT COUNT(*) n FROM home_intents").get().n,
    0,
  );
  assert.equal((await f.call("room_intent_list")).items.length, 0);
});
