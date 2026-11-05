import test from "node:test";
import assert from "node:assert/strict";
import {
  Worker,
  isMainThread,
  parentPort,
  workerData,
} from "node:worker_threads";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Runtime } from "../src/core/runtime.mjs";
import { ConfigStore } from "../src/core/config.mjs";
import { MemoryStore } from "../src/memory/store.mjs";
import { HOME_SOCIAL_DEFAULTS } from "../src/home/social-policy.mjs";
import { backupDatabase } from "../src/memory/backup.mjs";
import { config, FakeTransport } from "./helpers.mjs";

const INITIAL_TIME = 1800000000000;
function runtimeAt(root, clock) {
  const memory = new MemoryStore(path.join(root, "memory.sqlite"));
  const configStore = new ConfigStore(path.join(root, "config.json"));
  const runtime = new Runtime({
    memory,
    configStore,
    backendFactory: () => ({
      run: async () => {},
      cancel: async () => {},
      close: async () => {},
    }),
    transportFactory: () => new FakeTransport(),
  });
  for (const c of runtime.config.connections)
    runtime.transports.set(c.id, new FakeTransport());
  runtime.now = clock;
  runtime.homeSocial = runtime.home.social;
  return { runtime, memory, service: runtime.homeSocial };
}
function socialContext(runtime, service, actorId, target) {
  const identity = service.identity(actorId),
    binding = service.targetBinding(identity, target);
  service.db
    .prepare(
      "UPDATE home_social_turns SET status='finished' WHERE actor_generation=? AND status='running'",
    )
    .run(identity.generation);
  const ctx = runtime.makeContext(actorId, "@subject"),
    turnId = randomUUID();
  ctx.privateRead = new Set();
  ctx.persistTaint = () => {};
  ctx.runtimeKind = "subject-social";
  ctx.socialBinding = {
    ...binding,
    turnId,
    runId: randomUUID(),
    runMode: "async",
    windowId: null,
    epoch: 0,
    fence: 0,
  };
  service.db
    .prepare(
      "INSERT INTO home_social_turns(id,visit_id,target_kind,target_id,target_host_generation,target_guest_generation,actor_generation,mode,status,epoch,fence,policy_revision,config_revision,created_at) VALUES(?,?,?,?,?,?,?,'async','running',0,0,?,?,?)",
    )
    .run(
      turnId,
      target.kind === "visit" ? target.id : null,
      binding.target.kind,
      binding.target.id,
      binding.targetHostGeneration,
      binding.targetGuestGeneration,
      identity.generation,
      binding.policyRevision,
      binding.configRevision,
      runtime.now(),
    );
  return ctx;
}

if (!isMainThread) {
  const clock = new BigInt64Array(workerData.clock),
    gate = new Int32Array(workerData.gate);
  const f = runtimeAt(workerData.root, () => Number(Atomics.load(clock, 0)));
  let ctx,
    armed = false;
  const exec = f.memory.db.exec.bind(f.memory.db);
  // This latch controls acquisition order, without replacing domain decisions or SQL writes.
  f.memory.db.exec = (sql) => {
    if (armed && sql === "BEGIN IMMEDIATE") {
      armed = false;
      parentPort.postMessage({ type: "at-lock" });
      Atomics.wait(gate, 0, 0, 60000);
      const started = performance.now();
      const result = exec(sql);
      parentPort.postMessage({
        type: "acquired",
        waitedMs: performance.now() - started,
        gateTime: f.runtime.now(),
      });
      return result;
    }
    return exec(sql);
  };
  parentPort.on("message", async (message) => {
    try {
      if (message.method === "prepare") {
        ctx = socialContext(
          f.runtime,
          f.service,
          message.actorId,
          message.target,
        );
        parentPort.postMessage({
          type: "result",
          id: message.id,
          value: { actorIdentity: ctx.socialBinding.actorIdentity },
        });
      } else if (message.method === "close") {
        await f.runtime.close();
        f.memory.close();
        parentPort.postMessage({
          type: "result",
          id: message.id,
          value: { closed: true },
        });
        parentPort.close();
      } else {
        armed = message.lock;
        const value = f.service[message.method](ctx, message.args);
        if (message.dropReply)
          parentPort.postMessage({ type: "response-lost" });
        else parentPort.postMessage({ type: "result", id: message.id, value });
      }
    } catch (error) {
      parentPort.postMessage({
        type: "result",
        id: message.id,
        error: error instanceof Error ? error.message : "UNKNOWN_TEST_FAILURE",
      });
    }
  });
  parentPort.postMessage({ type: "ready" });
} else {
  class Client {
    constructor(root, clock) {
      this.gate = new Int32Array(new SharedArrayBuffer(4));
      this.worker = new Worker(new URL(import.meta.url), {
        workerData: { root, clock, gate: this.gate.buffer },
      });
      this.pending = new Map();
      this.events = [];
      this.listeners = [];
      this.next = 0;
      this.worker.on("message", (message) => {
        if (message.type === "result") {
          this.pending.get(message.id)?.(message);
          this.pending.delete(message.id);
        } else {
          this.events.push(message);
          for (const notify of this.listeners.splice(0)) notify();
        }
      });
    }
    async event(type) {
      for (;;) {
        const index = this.events.findIndex((event) => event.type === type);
        if (index >= 0) return this.events.splice(index, 1)[0];
        await new Promise((resolve, reject) => {
          const timeout = setTimeout(
            () => reject(Error("WORKER_TEST_EVENT_TIMEOUT")),
            30000,
          );
          this.listeners.push(() => {
            clearTimeout(timeout);
            resolve();
          });
        });
      }
    }
    call(method, args, lock = false, { dropReply = false } = {}) {
      if (lock) Atomics.store(this.gate, 0, 0);
      const id = ++this.next;
      const response = new Promise((resolve) => this.pending.set(id, resolve));
      this.worker.postMessage({ id, method, args, lock, dropReply });
      return response;
    }
    async prepare(actorId, target) {
      const id = ++this.next,
        response = new Promise((resolve) => this.pending.set(id, resolve));
      this.worker.postMessage({ id, method: "prepare", actorId, target });
      const result = await response;
      assert.equal(result.error, undefined);
      return result.value;
    }
    release() {
      Atomics.store(this.gate, 0, 1);
      Atomics.notify(this.gate, 0);
    }
    async close() {
      this.release();
      const exited = once(this.worker, "exit");
      const result = await this.call("close");
      assert.equal(result.error, undefined);
      await exited;
    }
  }
  async function setup(t) {
    const root = mkdtempSync(path.join(tmpdir(), "home-social-concurrency-"));
    const cfg = config(2);
    cfg.homeSocial = { ...HOME_SOCIAL_DEFAULTS, enabled: true };
    for (const a of cfg.agents) {
      a.subject.enabled = true;
      a.home = {
        ...a.home,
        enabled: true,
        publishing: true,
        social: { enabled: true },
      };
    }
    new ConfigStore(path.join(root, "config.json"), cfg);
    const clock = new BigInt64Array(new SharedArrayBuffer(8));
    Atomics.store(clock, 0, BigInt(INITIAL_TIME));
    const f = runtimeAt(root, () => Number(Atomics.load(clock, 0))),
      clients = [];
    t.after(async () => {
      // All worker connections close before the fixture directory, including on Windows.
      if (f.memory.db.isTransaction) f.memory.db.exec("ROLLBACK");
      await Promise.all(clients.map((client) => client.close()));
      await f.runtime.close();
      f.memory.close();
      rmSync(root, { recursive: true, force: true });
    });
    async function client(actorId, target) {
      const result = new Client(root, clock.buffer);
      clients.push(result);
      await result.event("ready");
      await result.prepare(actorId, target);
      return result;
    }
    function invitation(actorId = "agent-0", recipientId = "agent-1") {
      const ctx = socialContext(f.runtime, f.service, actorId, {
        kind: "compose",
        id: recipientId,
      });
      return f.service.invite(ctx, {
        requestId: randomUUID(),
        targetAgentId: recipientId,
        roomOwnerAgentId: "agent-0",
        purpose: "Synthetic independent consent",
      }).result.invitationId;
    }
    function visit() {
      const id = invitation(),
        ctx = socialContext(f.runtime, f.service, "agent-1", {
          kind: "invitation",
          id,
        });
      return f.service.decide(ctx, {
        requestId: randomUUID(),
        invitationId: id,
        expectedInvitationRevision: 1,
        decision: "accept",
      }).result.visitId;
    }
    return { ...f, root, clock, client, invitation, visit };
  }
  async function queued(client, method, args) {
    const outcome = client.call(method, args, true);
    await client.event("at-lock");
    return { client, outcome };
  }

  test("S2-06: two already-authorized ends on independent connections converge once", async (t) => {
    const f = await setup(t),
      visitId = f.visit();
    const a = await f.client("agent-0", { kind: "visit", id: visitId });
    const b = await f.client("agent-1", { kind: "visit", id: visitId });
    const first = await queued(a, "end", {
      requestId: "concurrent-end-a",
      visitId,
      expectedVisitRevision: 1,
    });
    const second = await queued(b, "end", {
      requestId: "concurrent-end-b",
      visitId,
      expectedVisitRevision: 1,
    });
    a.release();
    const one = await first.outcome;
    b.release();
    const two = await second.outcome;
    assert.equal(one.error, undefined);
    assert.equal(two.error, undefined);
    assert.equal(one.value.result.changed, true);
    assert.equal(two.value.result.changed, false);
    assert.equal(two.value.result.alreadyClosed, true);
    assert.equal(
      f.memory.db
        .prepare("SELECT count(*) n FROM home_social_events WHERE type='ended'")
        .get().n,
      1,
    );
    assert.equal(
      f.memory.db
        .prepare(
          "SELECT count(*) n FROM home_social_operations WHERE kind='end'",
        )
        .get().n,
      2,
    );
  });

  test("S2-06: send commits before a competing stale end and is never duplicated", async (t) => {
    const f = await setup(t),
      visitId = f.visit(),
      a = await f.client("agent-0", { kind: "visit", id: visitId }),
      b = await f.client("agent-1", { kind: "visit", id: visitId });
    const args = {
      requestId: "send-wins-original",
      visitId,
      expectedVisitRevision: 1,
      body: "Synthetic committed message",
    };
    const sending = await queued(a, "send", args),
      ending = await queued(b, "end", {
        requestId: "end-stale-original",
        visitId,
        expectedVisitRevision: 1,
      });
    a.release();
    const sent = await sending.outcome;
    b.release();
    const stale = await ending.outcome;
    assert.equal(sent.error, undefined);
    assert.equal(sent.value.status, "committed");
    assert.equal(stale.error, "REVISION_CONFLICT");
    const ctx = socialContext(f.runtime, f.service, "agent-1", {
        kind: "visit",
        id: visitId,
      }),
      view = f.service.visitRead(ctx, { visitId });
    f.service.end(ctx, {
      requestId: "end-after-reread",
      visitId,
      expectedVisitRevision: view.visitRevision,
    });
    const replayCtx = socialContext(f.runtime, f.service, "agent-0", {
        kind: "visit",
        id: visitId,
      }),
      replay = f.service.send(replayCtx, args);
    assert.equal(replay.historicalReplay, true);
    assert.equal(replay.operationId, sent.value.operationId);
    assert.equal(
      f.memory.db.prepare("SELECT count(*) n FROM home_social_messages").get()
        .n,
      1,
    );
    assert.equal(
      f.memory.db
        .prepare("SELECT count(*) n FROM home_social_events WHERE type='ended'")
        .get().n,
      1,
    );
    assert.equal(
      f.memory.db.prepare("SELECT ended_by FROM home_social_visits").get()
        .ended_by,
      f.service.identity("agent-1").generation,
    );
  });

  test("S2-06: a close wins against an already-entered send without granting it the end exception", async (t) => {
    const f = await setup(t),
      visitId = f.visit(),
      a = await f.client("agent-0", { kind: "visit", id: visitId }),
      b = await f.client("agent-1", { kind: "visit", id: visitId });
    const sending = await queued(a, "send", {
        requestId: "late-send-original",
        visitId,
        expectedVisitRevision: 1,
        body: "Synthetic rejected late draft",
      }),
      ending = await queued(b, "end", {
        requestId: "close-wins-original",
        visitId,
        expectedVisitRevision: 1,
      });
    b.release();
    assert.equal((await ending.outcome).error, undefined);
    a.release();
    const late = await sending.outcome;
    assert.ok(late.error || late.value?.status === "not_sent");
    assert.notEqual(late.value?.status, "committed");
    assert.equal(
      f.memory.db.prepare("SELECT count(*) n FROM home_social_messages").get()
        .n,
      0,
    );
    assert.equal(
      f.memory.db
        .prepare(
          "SELECT count(*) n FROM home_social_events WHERE type='message_committed'",
        )
        .get().n,
      0,
    );
    assert.equal(
      f.memory.db
        .prepare(
          "SELECT coalesce(sum(used),0) n FROM home_social_usage WHERE kind='message'",
        )
        .get().n,
      0,
    );
  });

  test("S2-06: opposite invitations accepted on distinct connections create one pair visit and grant", async (t) => {
    const f = await setup(t),
      one = f.invitation(),
      two = f.invitation("agent-1", "agent-0");
    const a = await f.client("agent-1", { kind: "invitation", id: one }),
      b = await f.client("agent-0", { kind: "invitation", id: two });
    const acceptOne = await queued(a, "decide", {
      requestId: "accept-pair-one",
      invitationId: one,
      expectedInvitationRevision: 1,
      decision: "accept",
    });
    const acceptTwo = await queued(b, "decide", {
      requestId: "accept-pair-two",
      invitationId: two,
      expectedInvitationRevision: 1,
      decision: "accept",
    });
    a.release();
    assert.equal((await acceptOne.outcome).error, undefined);
    b.release();
    assert.equal((await acceptTwo.outcome).error, "REVISION_CONFLICT");
    assert.equal(
      f.memory.db.prepare("SELECT count(*) n FROM home_social_visits").get().n,
      1,
    );
    assert.equal(
      f.memory.db.prepare("SELECT count(*) n FROM home_social_grants").get().n,
      1,
    );
    assert.deepEqual(
      f.memory.db
        .prepare("SELECT status FROM home_social_invitations ORDER BY status")
        .all()
        .map((row) => row.status),
      ["accepted", "pending"],
    );
    assert.equal(
      f.memory.db
        .prepare(
          "SELECT count(*) n FROM home_social_events WHERE type='accepted'",
        )
        .get().n,
      1,
    );
  });

  test("S2-06: SQLite write-lock waiting crosses the send deadline and samples a fresh clock", async (t) => {
    const f = await setup(t),
      visitId = f.visit(),
      a = await f.client("agent-0", { kind: "visit", id: visitId }),
      expires = f.memory.db
        .prepare("SELECT expires_at FROM home_social_visits")
        .get().expires_at;
    Atomics.store(f.clock, 0, BigInt(expires - 1));
    f.memory.db.exec("BEGIN IMMEDIATE");
    const waiting = await queued(a, "send", {
      requestId: "clock-send-original",
      visitId,
      expectedVisitRevision: 1,
      body: "Synthetic deadline draft",
    });
    a.release();
    await delay(40);
    Atomics.store(f.clock, 0, BigInt(expires));
    f.memory.db.exec("COMMIT");
    const acquired = await a.event("acquired"),
      outcome = await waiting.outcome;
    assert.ok(
      acquired.waitedMs >= 10,
      "worker must really wait for another SQLite writer",
    );
    assert.equal(acquired.gateTime, expires);
    assert.equal(outcome.error, undefined);
    assert.equal(outcome.value.status, "not_sent");
    assert.equal(outcome.value.result.safeError, "VISIT_CLOSED");
    assert.equal(
      f.memory.db.prepare("SELECT count(*) n FROM home_social_messages").get()
        .n,
      0,
    );
    assert.equal(
      f.memory.db.prepare("SELECT status FROM home_social_visits").get().status,
      "active",
    );
  });

  test("S2-06: SQLite write-lock waiting crosses invitation expiry before accept", async (t) => {
    const f = await setup(t),
      invitationId = f.invitation(),
      a = await f.client("agent-1", { kind: "invitation", id: invitationId }),
      expires = f.memory.db
        .prepare("SELECT expires_at FROM home_social_invitations")
        .get().expires_at;
    Atomics.store(f.clock, 0, BigInt(expires - 1));
    f.memory.db.exec("BEGIN IMMEDIATE");
    const waiting = await queued(a, "decide", {
      requestId: "clock-accept-original",
      invitationId,
      expectedInvitationRevision: 1,
      decision: "accept",
    });
    a.release();
    await delay(40);
    Atomics.store(f.clock, 0, BigInt(expires));
    f.memory.db.exec("COMMIT");
    const acquired = await a.event("acquired"),
      outcome = await waiting.outcome;
    assert.ok(acquired.waitedMs >= 10);
    assert.equal(acquired.gateTime, expires);
    assert.equal(outcome.error, "INVITATION_EXPIRED");
    assert.equal(
      f.memory.db.prepare("SELECT count(*) n FROM home_social_visits").get().n,
      0,
    );
    assert.equal(
      f.memory.db.prepare("SELECT count(*) n FROM home_social_grants").get().n,
      0,
    );
  });

  test("S2-06: invalidation cannot borrow the normal-close end convergence exception", async (t) => {
    const f = await setup(t),
      visitId = f.visit(),
      a = await f.client("agent-1", { kind: "visit", id: visitId });
    const waiting = await queued(a, "end", {
      requestId: "invalidated-end-original",
      visitId,
      expectedVisitRevision: 1,
    });
    f.service.moderate("instance-administrator", {
      action: "terminate-visit",
      targetId: visitId,
      expectedRevision: 1,
      policyRevision: f.service.policy().revision,
      requestId: "administrator-invalidate",
    });
    a.release();
    const result = await waiting.outcome;
    assert.ok(result.error);
    assert.equal(result.value, undefined);
    assert.equal(
      f.memory.db
        .prepare(
          "SELECT count(*) n FROM home_social_operations WHERE request_id='invalidated-end-original'",
        )
        .get().n,
      0,
    );
    assert.equal(
      f.memory.db.prepare("SELECT status FROM home_social_visits").get().status,
      "invalidated",
    );
  });

  test("S2-06: policy revocation while an end waits cannot expose a no-op terminal result", async (t) => {
    const f = await setup(t),
      visitId = f.visit(),
      a = await f.client("agent-1", { kind: "visit", id: visitId });
    const waiting = await queued(a, "end", {
      requestId: "revoked-end-original",
      visitId,
      expectedVisitRevision: 1,
    });
    const cfg = structuredClone(f.runtime.config);
    cfg.agents[1].paused = true;
    await f.runtime.changeConfig(cfg, f.runtime.configStore.revision);
    a.release();
    const result = await waiting.outcome;
    assert.ok(result.error);
    assert.equal(result.value, undefined);
    assert.equal(
      f.memory.db
        .prepare(
          "SELECT count(*) n FROM home_social_operations WHERE request_id='revoked-end-original'",
        )
        .get().n,
      0,
    );
    assert.equal(
      f.memory.db
        .prepare("SELECT count(*) n FROM home_social_events WHERE type='ended'")
        .get().n,
      0,
    );
  });

  test("S2-06: a lost commit reply is reconciled by its original key after SQLite backup", async (t) => {
    const f = await setup(t),
      visitId = f.visit(),
      a = await f.client("agent-0", { kind: "visit", id: visitId });
    const args = {
      requestId: "lost-reply-original",
      visitId,
      expectedVisitRevision: 1,
      body: "Synthetic original-key recovery",
    };
    a.call("send", args, false, { dropReply: true });
    await a.event("response-lost");
    const snapshot = path.join(f.root, "checkpoint.sqlite");
    await backupDatabase(f.memory.file, snapshot);
    const restored = new MemoryStore(snapshot);
    try {
      const identity = f.service.identity("agent-0"),
        row = restored.db
          .prepare(
            "SELECT * FROM home_social_operations WHERE actor_generation=? AND request_id=?",
          )
          .get(identity.generation, args.requestId);
      const ctx = socialContext(f.runtime, f.service, "agent-0", {
          kind: "visit",
          id: visitId,
        }),
        receipt = f.service.operationRead(ctx, { requestId: args.requestId });
      assert.equal(receipt.status, "committed");
      assert.equal(receipt.operationId, row.operation_id);
      assert.equal(receipt.committedAt, new Date(row.created_at).toISOString());
      assert.equal(
        f.service.operationRead(ctx, { requestId: "unknown-original-key" })
          .status,
        "unknown",
      );
      const replay = f.service.send(ctx, args);
      assert.equal(replay.historicalReplay, true);
      assert.equal(replay.result.messageId, receipt.result.messageId);
      assert.equal(
        f.memory.db.prepare("SELECT count(*) n FROM home_social_messages").get()
          .n,
        1,
      );
      assert.equal(
        f.memory.db
          .prepare(
            "SELECT count(*) n FROM home_social_events WHERE type='message_committed'",
          )
          .get().n,
        1,
      );
      assert.equal(
        f.memory.db
          .prepare("SELECT used FROM home_social_usage WHERE kind='message'")
          .get().used,
        1,
      );
      assert.equal(
        restored.db.prepare("PRAGMA integrity_check").get().integrity_check,
        "ok",
      );
    } finally {
      restored.close();
    }
  });

  test("S2-06: invitation preparation and administrator reads do not fabricate recipient viewing", async (t) => {
    const f = await setup(t),
      id = f.invitation(),
      recipient = socialContext(f.runtime, f.service, "agent-1", {
        kind: "invitation",
        id,
      });
    const before = f.memory.db
      .prepare("SELECT count(*) n FROM home_social_events")
      .get().n;
    f.service.adminRead("instance-administrator", { kind: "invitation", id });
    f.service.inbox(recipient, {});
    assert.equal(recipient.socialPendingInvitations, undefined);
    const view = f.service.invitationRead(recipient, { invitationId: id });
    assert.equal(view.purpose, "Synthetic independent consent");
    assert.equal(
      f.memory.db
        .prepare(
          "SELECT recipient_viewed_at FROM home_social_invitations WHERE id=?",
        )
        .get(id).recipient_viewed_at,
      null,
    );
    assert.equal(
      f.memory.db.prepare("SELECT count(*) n FROM home_social_events").get().n,
      before,
    );
    const ticket = f.service.captureInputConsumption(recipient);
    assert.equal(Object.isFrozen(ticket), true);
    assert.equal(Object.isFrozen(ticket.invitations), true);
    assert.equal(Object.isFrozen(ticket.invitations[0]), true);
    const confirmed = f.service.confirmInputConsumed(recipient, ticket);
    assert.equal(confirmed.confirmed, 1);
    const row = f.memory.db
      .prepare("SELECT * FROM home_social_invitations WHERE id=?")
      .get(id);
    assert.equal(row.recipient_viewed_at, INITIAL_TIME);
    assert.equal(row.revision, 1);
    assert.equal(
      f.service.confirmInputConsumed(recipient, ticket).confirmed,
      0,
    );
    assert.equal(
      f.memory.db.prepare("SELECT count(*) n FROM home_social_events").get().n,
      before,
    );
    assert.equal(
      f.memory.db
        .prepare("SELECT count(*) n FROM home_social_read_cursors")
        .get().n,
      0,
    );
  });

  test("S2-06: only the recipient may be confirmed; stale snapshots cannot consume newer pending reads", async (t) => {
    const f = await setup(t),
      id = f.invitation(),
      host = socialContext(f.runtime, f.service, "agent-0", {
        kind: "invitation",
        id,
      });
    f.service.invitationRead(host, { invitationId: id });
    assert.equal(
      f.service.confirmInputConsumed(
        host,
        f.service.captureInputConsumption(host),
      ).confirmed,
      0,
    );
    assert.equal(
      f.memory.db
        .prepare("SELECT recipient_viewed_at FROM home_social_invitations")
        .get().recipient_viewed_at,
      null,
    );
    const recipient = socialContext(f.runtime, f.service, "agent-1", {
      kind: "invitation",
      id,
    });
    f.service.invitationRead(recipient, { invitationId: id });
    const ticket = f.service.captureInputConsumption(recipient),
      newer = { ...recipient.socialPendingInvitations.get(id), revision: 2 };
    recipient.socialPendingInvitations.set(id, newer);
    assert.equal(
      f.service.confirmInputConsumed(recipient, ticket).confirmed,
      0,
    );
    assert.equal(recipient.socialPendingInvitations.get(id), newer);
    assert.equal(
      f.memory.db
        .prepare("SELECT recipient_viewed_at FROM home_social_invitations")
        .get().recipient_viewed_at,
      null,
    );
  });

  test("S2-06: revoked versions, expired input leases and unregistered capabilities cannot confirm viewing", async (t) => {
    for (const mode of ["version", "lease", "capability"]) {
      const f = await setup(t),
        id = f.invitation(),
        recipient = socialContext(f.runtime, f.service, "agent-1", {
          kind: "invitation",
          id,
        });
      f.service.invitationRead(recipient, { invitationId: id });
      const ticket = f.service.captureInputConsumption(recipient);
      if (mode === "version")
        f.memory.db
          .prepare(
            "UPDATE home_social_invitations SET revision=revision+1 WHERE id=?",
          )
          .run(id);
      if (mode === "lease")
        Atomics.store(f.clock, 0, BigInt(INITIAL_TIME + 15000));
      if (mode === "capability") f.runtime.capabilities.delete(recipient.token);
      assert.throws(() => f.service.confirmInputConsumed(recipient, ticket));
      assert.equal(
        f.memory.db
          .prepare(
            "SELECT recipient_viewed_at FROM home_social_invitations WHERE id=?",
          )
          .get(id).recipient_viewed_at,
        null,
      );
    }
  });

  test("S2-06: a lost accept reply can be reconciled from its original invitation in a fresh context", async (t) => {
    const f = await setup(t),
      invitationId = f.invitation(),
      recipient = await f.client("agent-1", {
        kind: "invitation",
        id: invitationId,
      });
    const args = {
      requestId: "accept-lost-original",
      invitationId,
      expectedInvitationRevision: 1,
      decision: "accept",
    };
    recipient.call("decide", args, false, { dropReply: true });
    await recipient.event("response-lost");
    const visitId = f.memory.db
      .prepare("SELECT id FROM home_social_visits WHERE invitation_id=?")
      .get(invitationId).id;
    const visitCtx = socialContext(f.runtime, f.service, "agent-1", {
      kind: "visit",
      id: visitId,
    });
    assert.equal(
      f.service.operationRead(visitCtx, { requestId: args.requestId }).status,
      "committed",
    );
    const fresh = socialContext(f.runtime, f.service, "agent-1", {
        kind: "invitation",
        id: invitationId,
      }),
      safe = f.service.invitationRead(fresh, { invitationId });
    assert.equal(safe.state, "accepted");
    assert.equal("purpose" in safe, false);
    assert.equal("reason" in safe, false);
    assert.equal(fresh.socialPendingInvitations, undefined);
    const receipt = f.service.operationRead(fresh, {
      requestId: args.requestId,
    });
    assert.equal(receipt.status, "committed");
    assert.equal(receipt.result.visitId, visitId);
    assert.throws(() =>
      f.service.decide(fresh, {
        ...args,
        requestId: "accept-terminal-new",
        expectedInvitationRevision: 2,
      }),
    );
    assert.equal(
      f.memory.db.prepare("SELECT count(*) n FROM home_social_visits").get().n,
      1,
    );
  });

  test("S2-06: decline, cancel and expiry retain original-key read-only reconciliation without a visit", async (t) => {
    for (const decision of ["decline", "cancel", "expired"]) {
      const f = await setup(t),
        invitationId = f.invitation(),
        actorId = decision === "decline" ? "agent-1" : "agent-0";
      const expires = f.memory.db
        .prepare("SELECT expires_at FROM home_social_invitations WHERE id=?")
        .get(invitationId).expires_at;
      let originalKey, originalArgs;
      if (decision === "expired") {
        originalKey = f.memory.db
          .prepare(
            "SELECT request_id FROM home_social_operations WHERE kind='invite'",
          )
          .get().request_id;
        Atomics.store(f.clock, 0, BigInt(expires));
      } else {
        const pending = socialContext(f.runtime, f.service, actorId, {
          kind: "invitation",
          id: invitationId,
        });
        originalArgs = {
          requestId: `terminal-${decision}-original`,
          invitationId,
          expectedInvitationRevision: 1,
          decision,
        };
        originalKey = originalArgs.requestId;
        f.service.decide(pending, originalArgs);
      }
      const ctx = socialContext(f.runtime, f.service, actorId, {
          kind: "invitation",
          id: invitationId,
        }),
        meta = f.service.invitationRead(ctx, { invitationId });
      assert.equal(meta.readOnly, true);
      assert.equal(
        meta.state,
        decision === "decline"
          ? "declined"
          : decision === "cancel"
            ? "cancelled"
            : "expired",
      );
      assert.deepEqual(meta.permittedActions, ["operation-read"]);
      assert.equal("purpose" in meta, false);
      assert.equal("reason" in meta, false);
      assert.equal(ctx.socialPendingInvitations, undefined);
      const receipt = f.service.operationRead(ctx, { requestId: originalKey });
      assert.equal(receipt.status, "committed");
      assert.equal(receipt.current.state, meta.state);
      assert.equal(
        f.service.operationRead(ctx, { requestId: "unknown-terminal-key" })
          .status,
        "unknown",
      );
      const count = f.memory.db
        .prepare("SELECT count(*) n FROM home_social_operations")
        .get().n;
      assert.throws(() =>
        f.service.decide(ctx, {
          requestId: `terminal-${decision}-new`,
          invitationId,
          expectedInvitationRevision: meta.invitationRevision,
          decision: "accept",
        }),
      );
      assert.throws(
        () =>
          f.service.block(ctx, {
            requestId: `terminal-${decision}-block`,
            targetAgentId: actorId === "agent-0" ? "agent-1" : "agent-0",
            expectedPolicyRevision: f.service.policy().revision,
            blocked: true,
          }),
        /AUDIENCE_DENIED/,
      );
      if (originalArgs)
        assert.equal(
          f.service.decide(ctx, originalArgs).historicalReplay,
          true,
        );
      assert.equal(
        f.memory.db
          .prepare("SELECT count(*) n FROM home_social_operations")
          .get().n,
        count,
      );
      assert.equal(
        f.memory.db.prepare("SELECT count(*) n FROM home_social_visits").get()
          .n,
        0,
      );
      assert.equal(
        f.memory.db
          .prepare("SELECT expires_at FROM home_social_invitations WHERE id=?")
          .get(invitationId).expires_at,
        expires,
      );
    }
  });

  test("S2-06: revoked, blocked and replaced identities cannot reopen terminal invitation receipts", async (t) => {
    for (const mode of ["block", "invalidated", "generation"]) {
      const f = await setup(t),
        id = f.invitation(),
        recipient = socialContext(f.runtime, f.service, "agent-1", {
          kind: "invitation",
          id,
        });
      f.service.decide(recipient, {
        requestId: "decline-revoked-original",
        invitationId: id,
        expectedInvitationRevision: 1,
        decision: "decline",
      });
      if (mode === "block") {
        const actor = socialContext(f.runtime, f.service, "agent-0", {
          kind: "compose",
          id: "agent-1",
        });
        f.service.block(actor, {
          requestId: "block-terminal-pair",
          targetAgentId: "agent-1",
          expectedPolicyRevision: f.service.policy().revision,
          blocked: true,
        });
      }
      if (mode === "invalidated")
        f.memory.db
          .prepare(
            "UPDATE home_social_invitations SET status='invalidated' WHERE id=?",
          )
          .run(id);
      if (mode === "generation")
        f.memory.db
          .prepare(
            "UPDATE home_identities SET generation=? WHERE agent_id='agent-1'",
          )
          .run(randomUUID());
      assert.throws(() =>
        socialContext(f.runtime, f.service, "agent-1", {
          kind: "invitation",
          id,
        }),
      );
      assert.throws(() =>
        f.service.operationRead(recipient, {
          requestId: "decline-revoked-original",
        }),
      );
    }
  });
}
