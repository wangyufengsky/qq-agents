import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { fixture, config } from "./helpers.mjs";
import {
  HOME_SOCIAL_DEFAULTS,
  SOCIAL_ADMIN_PRINCIPAL,
} from "../src/home/social-policy.mjs";

const VISITS = 768;
const MESSAGES_PER_VISIT = 4;
const EXTRA_FIRST_VISIT_MESSAGES = 768;
const MAX_PAGE = 50;
const observations = (start) => Number((performance.now() - start).toFixed(3));
const operationPayload = (index) => ({ index });
const payloadHash = (index) =>
  createHash("sha256")
    .update(
      JSON.stringify({ kind: "load_send", payload: operationPayload(index) }),
    )
    .digest("hex");

function ledgerDigest(db, table, order) {
  const hash = createHash("sha256");
  for (const row of db
    .prepare(`SELECT * FROM ${table} ORDER BY ${order}`)
    .iterate())
    hash.update(JSON.stringify(row)).update("\n");
  return hash.digest("hex");
}

// Observe actual SQLite result batches, not only already-sliced DTOs. The
// overview must never materialize stored prose, even if mapping would hide it.
function boundedQuery(db, mode, limit, action) {
  const original = db.prepare;
  let batches = 0;
  db.prepare = function (sql) {
    const statement = original.call(this, sql);
    const relevant =
      /^(?:SELECT|WITH)\b/i.test(sql) &&
      (mode === "overview"
        ? /home_social_(?:invitations|visits|messages)\b/.test(sql)
        : /home_social_messages\b/.test(sql));
    if (!relevant) return statement;
    if (mode === "overview")
      assert.doesNotMatch(sql, /\b(?:body|purpose|reason)\b/i);
    return new Proxy(statement, {
      get(target, key) {
        const value = Reflect.get(target, key, target);
        if (key === "all")
          return (...args) => {
            const rows = value.apply(target, args);
            assert.ok(
              rows.length <= limit + 1,
              "SQLite page includes at most one look-ahead row",
            );
            batches++;
            return rows;
          };
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  };
  try {
    const result = action();
    assert.ok(batches > 0, "real paginated SQLite query was observed");
    return result;
  } finally {
    db.prepare = original;
  }
}

function seed(service, host, guest, now) {
  const db = service.db;
  const invitations = [],
    visits = [],
    messages = new Map();
  const insertInvitation = db.prepare(
    'INSERT INTO home_social_invitations(id,host_agent_id,host_generation,guest_agent_id,guest_generation,initiator_generation,recipient_generation,room_id,purpose,reason,audience,requested_scope,effective_scope,status,policy_revision,created_at,expires_at,decided_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,\'{"scope":["layout"],"selectedItems":[]}\',\'{"scope":["layout"],"selectedItems":[]}\',\'accepted\',?,?,?,?)',
  );
  const insertVisit = db.prepare(
    "INSERT INTO home_social_visits(id,invitation_id,host_agent_id,host_generation,guest_agent_id,guest_generation,room_id,pair_key,status,policy_revision,started_at,expires_at,ended_at,next_sequence) VALUES(?,?,?,?,?,?,?,?,'ended',?,?,?,?,?)",
  );
  const insertMessage = db.prepare(
    "INSERT INTO home_social_messages(id,visit_id,author_agent_id,author_generation,sequence,body,source_labels,audience,created_at,retracted_at,hidden_at) VALUES(?,?,?,?,?,?,'[]',?,?,?,?)",
  );
  const insertOperation = db.prepare(
    "INSERT INTO home_social_operations(actor_generation,actor_agent_id,request_id,kind,payload_hash,operation_id,status,result,created_at) VALUES(?,?,?,'load_send',?,?,'committed',?,?)",
  );
  const insertEvent = db.prepare(
    "INSERT INTO home_social_events(id,entity_id,actor_generation,type,created_at,metadata) VALUES(?,?,?,'message_committed',?,'{}')",
  );
  const insertUsage = db.prepare(
    "INSERT INTO home_social_usage VALUES(?,?,?,'message',?,0)",
  );
  const audience = JSON.stringify([host.generation, guest.generation]);
  const policy = service.policy().revision;
  const createdAt = now - 3 * 3600000,
    endedAt = now - 3600000;
  let index = 0,
    firstReceipt;
  // These synthetic histories intentionally bypass interaction quotas. This is
  // a bounded-query/retention sample, not a model or concurrency load claim.
  service.store.transaction(() => {
    for (let visitIndex = 0; visitIndex < VISITS; visitIndex++) {
      const invitationId = randomUUID(),
        visitId = randomUUID();
      invitations.push(invitationId);
      visits.push(visitId);
      insertInvitation.run(
        invitationId,
        host.agentId,
        host.generation,
        guest.agentId,
        guest.generation,
        host.generation,
        guest.generation,
        "room:" + host.generation,
        `LOAD_PURPOSE_${visitIndex}`,
        `LOAD_REASON_${visitIndex}`,
        audience,
        policy,
        createdAt,
        endedAt,
        createdAt,
      );
      const count =
        MESSAGES_PER_VISIT +
        (visitIndex === 0 ? EXTRA_FIRST_VISIT_MESSAGES : 0);
      insertVisit.run(
        visitId,
        invitationId,
        host.agentId,
        host.generation,
        guest.agentId,
        guest.generation,
        "room:" + host.generation,
        `${host.generation}:${guest.generation}`,
        policy,
        createdAt,
        endedAt,
        endedAt,
        count + 1,
      );
      let hostCount = 0,
        guestCount = 0;
      for (let sequence = 1; sequence <= count; sequence++, index++) {
        const author = sequence % 2 ? host : guest;
        if (author === host) hostCount++;
        else guestCount++;
        const messageId = randomUUID(),
          marker = `LOAD_MESSAGE_${index}`;
        const hidden = index % 13 === 0,
          retracted = !hidden && index % 17 === 0;
        const body =
          hidden || retracted ? "" : marker + "_" + "synthetic ".repeat(40);
        insertMessage.run(
          messageId,
          visitId,
          author.agentId,
          author.generation,
          sequence,
          body,
          audience,
          createdAt,
          retracted ? createdAt : null,
          hidden ? createdAt : null,
        );
        messages.set(messageId, {
          visitId,
          sequence,
          marker,
          body,
          state: hidden ? "hidden" : retracted ? "retracted" : "committed",
        });
        const requestId = `load-send-${index}`,
          operationId = randomUUID();
        const result = { messageId, visitId, sequence };
        insertOperation.run(
          author.generation,
          author.agentId,
          requestId,
          payloadHash(index),
          operationId,
          JSON.stringify(result),
          createdAt,
        );
        insertEvent.run(randomUUID(), visitId, author.generation, createdAt);
        firstReceipt ||= {
          identity: author,
          requestId,
          operationId,
          result,
          createdAt,
        };
      }
      const day = new Date(now).toISOString().slice(0, 10);
      insertUsage.run(host.generation, day, visitId, hostCount);
      insertUsage.run(guest.generation, day, visitId, guestCount);
    }
    db.prepare(
      "INSERT INTO home_social_usage VALUES(?,?,'load-reservation','tokens',100,50)",
    ).run(host.generation, new Date(now).toISOString().slice(0, 10));
  });
  return { invitations, visits, messages, firstReceipt };
}

test("synthetic history load keeps admin pages bounded and prose scoped while retaining tombstones and ledgers", (t) => {
  const cfg = config(2);
  cfg.homeSocial = { ...HOME_SOCIAL_DEFAULTS, enabled: true, retentionDays: 1 };
  for (const agent of cfg.agents)
    agent.home = { ...agent.home, enabled: true, social: { enabled: true } };
  const f = fixture(t, { cfg }),
    s = f.runtime.home.social,
    db = s.db;
  let now = 1800000000000;
  f.runtime.now = () => now;
  const seedStart = performance.now();
  const sample = seed(s, s.identity("agent-0"), s.identity("agent-1"), now);
  const seedMs = observations(seedStart);
  assert.equal(
    sample.messages.size,
    VISITS * MESSAGES_PER_VISIT + EXTRA_FIRST_VISIT_MESSAGES,
  );
  assert.equal(db.prepare("PRAGMA foreign_key_check").all().length, 0);
  const ledgers = () => ({
    operations: ledgerDigest(
      db,
      "home_social_operations",
      "actor_generation,request_id",
    ),
    usage: ledgerDigest(
      db,
      "home_social_usage",
      "actor_generation,day,scope,kind",
    ),
    events: ledgerDigest(db, "home_social_events", "sequence"),
  });
  const before = ledgers();
  for (const limit of [0, MAX_PAGE + 1, 1.5]) {
    assert.throws(() => s.adminOverview(SOCIAL_ADMIN_PRINCIPAL, { limit }));
    assert.throws(() =>
      s.adminRead(SOCIAL_ADMIN_PRINCIPAL, {
        kind: "visit",
        id: sample.visits[0],
        limit,
      }),
    );
  }
  const seenOverview = new Set(),
    overviewCursors = new Set();
  let cursor,
    overviewPages = 0;
  const overviewStart = performance.now();
  do {
    const page = boundedQuery(db, "overview", 37, () =>
      s.adminOverview(SOCIAL_ADMIN_PRINCIPAL, {
        limit: 37,
        ...(cursor ? { cursor } : {}),
      }),
    );
    assert.ok(page.items.length <= 37);
    const encoded = JSON.stringify(page);
    assert.doesNotMatch(encoded, /LOAD_(?:PURPOSE|REASON|MESSAGE)_/);
    for (const item of page.items) {
      assert.ok(
        !("purpose" in item) && !("reason" in item) && !("body" in item),
      );
      const key = `${item.kind}:${item.id}`;
      assert.ok(!seenOverview.has(key), "overview never repeats an entity");
      seenOverview.add(key);
    }
    cursor = page.nextCursor;
    if (cursor) {
      assert.ok(!overviewCursors.has(cursor));
      overviewCursors.add(cursor);
    }
    assert.ok(
      ++overviewPages <= VISITS * 2,
      "overview traversal makes progress",
    );
  } while (cursor);
  const overviewMs = observations(overviewStart);
  assert.deepEqual(
    seenOverview,
    new Set([
      ...sample.invitations.map((id) => "invitation:" + id),
      ...sample.visits.map((id) => "visit:" + id),
    ]),
  );
  assert.deepEqual(
    ledgers(),
    before,
    "overview creates no social events, receipts or usage",
  );
  assert.equal(
    s.adminOverview(SOCIAL_ADMIN_PRINCIPAL, {
      agentId: "missing-synthetic-role",
      limit: MAX_PAGE,
    }).items.length,
    0,
  );
  assert.equal(s.adminOverview(SOCIAL_ADMIN_PRINCIPAL).items.length, 20);
  assert.equal(
    s.adminOverview(SOCIAL_ADMIN_PRINCIPAL, { limit: MAX_PAGE }).items.length,
    MAX_PAGE,
  );
  assert.equal(
    boundedQuery(db, "read", 20, () =>
      s.adminRead(SOCIAL_ADMIN_PRINCIPAL, {
        kind: "visit",
        id: sample.visits[0],
      }),
    ).messages.length,
    20,
  );

  const seenMessages = new Set(),
    auditIds = new Set();
  let readPages = 0;
  const readStart = performance.now();
  for (const visitId of sample.visits) {
    let messageCursor,
      lastSequence = 0;
    const cursors = new Set();
    do {
      const page = boundedQuery(db, "read", MAX_PAGE, () =>
        s.adminRead(SOCIAL_ADMIN_PRINCIPAL, {
          kind: "visit",
          id: visitId,
          limit: MAX_PAGE,
          ...(messageCursor ? { cursor: messageCursor } : {}),
        }),
      );
      assert.equal(page.id, visitId);
      assert.ok(page.messages.length <= MAX_PAGE);
      assert.ok(page.auditId && !auditIds.has(page.auditId));
      auditIds.add(page.auditId);
      const allowedMarkers = new Set();
      for (const message of page.messages) {
        const expected = sample.messages.get(message.messageId);
        assert.ok(expected && !seenMessages.has(message.messageId));
        seenMessages.add(message.messageId);
        assert.equal(expected.visitId, visitId);
        assert.equal(message.sequence, ++lastSequence);
        assert.equal(message.state, expected.state);
        if (expected.state === "committed") {
          assert.equal(message.body, expected.body);
          allowedMarkers.add(expected.marker);
        } else
          assert.ok(
            !("body" in message),
            "hidden and retracted bodies never leave the page",
          );
      }
      for (const marker of JSON.stringify(page).match(/LOAD_MESSAGE_\d+/g) ||
        [])
        assert.ok(
          allowedMarkers.has(marker),
          "no off-page message prose is returned",
        );
      assert.doesNotMatch(JSON.stringify(page), /LOAD_(?:PURPOSE|REASON)_/);
      messageCursor = page.nextCursor;
      if (messageCursor) {
        assert.ok(!cursors.has(messageCursor));
        cursors.add(messageCursor);
      }
      assert.ok(
        ++readPages <= sample.messages.size,
        "message traversal makes progress",
      );
    } while (messageCursor);
  }
  const readMs = observations(readStart);
  assert.deepEqual(seenMessages, new Set(sample.messages.keys()));
  assert.equal(
    db.prepare("SELECT count(*) n FROM home_social_read_cursors").get().n,
    0,
    "administrator browsing never advances role read cursors",
  );
  assert.deepEqual(
    ledgers(),
    before,
    "audited reads do not mutate social accounting",
  );
  assert.equal(
    s.adminRead(SOCIAL_ADMIN_PRINCIPAL, {
      kind: "invitation",
      id: sample.invitations[0],
    }).purpose,
    "LOAD_PURPOSE_0",
  );

  now += 2 * 86400000;
  const pruneStart = performance.now();
  const cleared = s.store.pruneBodies({ before: now - 86400000 });
  const pruneMs = observations(pruneStart);
  assert.deepEqual(cleared, {
    messages: sample.messages.size,
    invitations: VISITS,
  });
  assert.equal(
    db.prepare("SELECT count(*) n FROM home_social_messages").get().n,
    sample.messages.size,
  );
  assert.equal(
    db
      .prepare(
        "SELECT count(*) n FROM home_social_messages WHERE body<>'' OR body_cleared_at IS NULL",
      )
      .get().n,
    0,
  );
  assert.equal(
    db
      .prepare(
        "SELECT count(*) n FROM home_social_invitations WHERE purpose<>'' OR reason<>'' OR body_cleared_at IS NULL",
      )
      .get().n,
    0,
  );
  for (const row of db
    .prepare(
      "SELECT id,visit_id,sequence,revision,retracted_at,hidden_at FROM home_social_messages",
    )
    .iterate()) {
    const expected = sample.messages.get(row.id);
    assert.equal(row.visit_id, expected.visitId);
    assert.equal(row.sequence, expected.sequence);
    assert.equal(row.revision, 1);
    assert.equal(Boolean(row.hidden_at), expected.state === "hidden");
    assert.equal(Boolean(row.retracted_at), expected.state === "retracted");
  }
  assert.deepEqual(
    ledgers(),
    before,
    "retention keeps operation, usage/reservation and event ledgers byte-for-byte",
  );
  const prior = sample.firstReceipt;
  const receipt = s.store.execute({
    actorIdentity: prior.identity,
    requestId: prior.requestId,
    kind: "load_send",
    payload: operationPayload(0),
    apply: () => assert.fail("a retained operation must not execute again"),
  });
  assert.equal(receipt.operationId, prior.operationId);
  assert.equal(receipt.historicalReplay, true);
  assert.equal(Date.parse(receipt.committedAt), prior.createdAt);
  assert.deepEqual(receipt.result, prior.result);
  assert.deepEqual(ledgers(), before);
  const tombstones = boundedQuery(db, "read", MAX_PAGE, () =>
    s.adminRead(SOCIAL_ADMIN_PRINCIPAL, {
      kind: "visit",
      id: sample.visits[0],
      limit: MAX_PAGE,
    }),
  );
  assert.equal(tombstones.messages.length, MAX_PAGE);
  assert.ok(tombstones.messages.every((message) => !("body" in message)));
  assert.throws(
    () =>
      s.adminRead(SOCIAL_ADMIN_PRINCIPAL, {
        kind: "invitation",
        id: sample.invitations[0],
      }),
    /AUDIENCE_DENIED/,
  );
  assert.equal(f.backends.length, 0);
  assert.ok(
    [...f.runtime.transports.values()].every(
      (transport) => transport.sent.length === 0,
    ),
  );
  t.diagnostic(
    JSON.stringify({
      synthetic: true,
      scope: "SQLite admin pagination and retention only",
      invitations: VISITS,
      visits: VISITS,
      messages: sample.messages.size,
      operationReceipts: sample.messages.size,
      overviewPages,
      readPages,
      observedMilliseconds: {
        seed: seedMs,
        overview: overviewMs,
        read: readMs,
        prune: pruneMs,
      },
      timingThresholdApplied: false,
    }),
  );
});
