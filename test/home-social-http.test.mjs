import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import http from "node:http";
import { fixture } from "./helpers.mjs";
import { createServer } from "../src/server.mjs";

async function setup(t) {
  const f = fixture(t),
    token = randomBytes(32).toString("hex"),
    audit = [],
    calls = [];
  f.runtime.homeSocial = {
    auditAdminAccess(row) {
      audit.push(row);
    },
    adminOverview(auth, query) {
      calls.push({ method: "overview", auth, query });
      return { items: [], permittedActions: ["read"] };
    },
    adminRead(auth, input) {
      audit.push({
        principal: auth,
        action: "read",
        targetId: input.id,
        outcome: "success",
      });
      if (Object.hasOwn(input, "actingAgentId")) throw Error("AUDIENCE_DENIED");
      calls.push({ method: "read", auth, input });
      return {
        id: input.id,
        messages: [{ body: "Synthetic private body" }],
        auditId: "synthetic-audit",
      };
    },
    moderate(auth, input) {
      calls.push({ method: "moderate", auth, input });
      if (
        !["hide-message", "close-window", "terminate-visit"].includes(
          input.action,
        )
      )
        throw Error("AUDIENCE_DENIED");
      if (input.expectedRevision === 0) throw Error("REVISION_CONFLICT");
      return { changed: true, state: "ended" };
    },
  };
  const app = createServer({ runtime: f.runtime, token });
  const port = await app.listen();
  t.after(() => app.close());
  const request = (route, options = {}) =>
    new Promise((resolve, reject) => {
      const req = http.request(
        {
          hostname: "127.0.0.1",
          port,
          path: route,
          method: options.method || "GET",
          headers: { "x-admin-token": token, ...options.headers },
        },
        (res) => {
          let text = "";
          res.setEncoding("utf8");
          res.on("data", (chunk) => {
            text += chunk;
          });
          res.on("end", () =>
            resolve({
              status: res.statusCode,
              headers: { get: (name) => res.headers[name] },
              json: async () => JSON.parse(text),
            }),
          );
        },
      );
      req.on("error", reject);
      req.end(options.body);
    });
  return { ...f, app, token, audit, calls, request, port };
}

test("social HTTP reads require admin authority, leave no role read cursor, and never accept agent credentials", async (t) => {
  const f = await setup(t);
  for (const headers of [
    { "x-admin-token": "" },
    { "x-admin-token": "", "x-agent-capability": "synthetic-role-token" },
  ]) {
    const res = await f.request("/api/home-social/read", {
      method: "POST",
      headers,
      body: JSON.stringify({ id: "private-record" }),
    });
    assert.equal(res.status, 401);
    assert(
      !JSON.stringify(await res.json()).includes("Synthetic private body"),
    );
  }
  assert.equal(f.calls.length, 0);
  assert.equal(f.audit.length, 2);
  assert(
    f.audit.every(
      (a) => a.principal === "unauthenticated" && a.targetId === "unknown",
    ),
  );
  const before = f.runtime.memory.bind("agent-0").state("@subject");
  const res = await f.request("/api/home-social/read", {
    method: "POST",
    body: JSON.stringify({ kind: "visit", id: "private-record", limit: 20 }),
  });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("cache-control"), "no-store");
  assert.equal((await res.json()).messages[0].body, "Synthetic private body");
  assert.deepEqual(f.runtime.memory.bind("agent-0").state("@subject"), before);
  assert.equal(f.calls[0].auth, "instance-administrator");
});

test("host, origin, method and malformed social body rejection are audited without copying input", async (t) => {
  const f = await setup(t);
  for (const headers of [
    { host: "invalid.example" },
    { origin: "https://invalid.example" },
    { "sec-fetch-site": "cross-site" },
  ]) {
    const res = await f.request("/api/home-social/read", {
      method: "POST",
      headers,
      body: "private-payload",
    });
    assert.equal(res.status, 403);
  }
  assert.equal((await f.request("/api/home-social/read")).status, 405);
  assert.equal(
    (
      await f.request("/api/home-social/read", {
        method: "POST",
        body: "private-payload",
      })
    ).status,
    400,
  );
  assert.equal(f.calls.length, 0);
  assert.equal(f.audit.length, 5);
  assert(!JSON.stringify(f.audit).includes("private-payload"));
});

test("admin overview remains metadata-only and moderation passes only a real admin principal", async (t) => {
  const f = await setup(t);
  const overview = await f.request(
    "/api/home-social/overview?agentId=agent-0&limit=20",
  );
  assert.equal(overview.status, 200);
  assert.deepEqual((await overview.json()).items, []);
  assert.equal(f.audit.length, 0);
  assert.equal(f.calls[0].query.limit, 20);
  for (const action of ["accept", "send", "decline"]) {
    const res = await f.request("/api/home-social/moderate", {
      method: "POST",
      body: JSON.stringify({ action, targetId: "private-record" }),
    });
    assert.equal(res.status, 403);
  }
  const conflict = await f.request("/api/home-social/moderate", {
    method: "POST",
    body: JSON.stringify({
      action: "terminate-visit",
      targetId: "private-record",
      expectedRevision: 0,
    }),
  });
  assert.equal(conflict.status, 409);
  const res = await f.request("/api/home-social/moderate", {
    method: "POST",
    body: JSON.stringify({
      action: "terminate-visit",
      targetId: "private-record",
      expectedRevision: 1,
    }),
  });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).changed, true);
  assert(f.calls.every((c) => c.auth === "instance-administrator"));
});

test("home social scripts and styles are served from the fixed packaged whitelist", async (t) => {
  const f = await setup(t);
  for (const [file, type] of [
    ["social.mjs", "text/javascript"],
    ["social.css", "text/css"],
  ]) {
    const res = await f.request("/home-space/" + file);
    assert.equal(res.status, 200);
    assert.ok(res.headers.get("content-type").startsWith(type));
    assert.equal(res.headers.get("cache-control"), "no-store");
  }
  assert.equal(
    (await f.request("/home-space/private-social.json")).status,
    404,
  );
  assert.equal(f.calls.length, 0);
});

test("real admin HTTP reads commit audits, preserve AI cursors, and fail closed when audit storage fails", async (t) => {
  const f = await setup(t);
  delete f.runtime.homeSocial;
  const s = f.runtime.home.social,
    db = s.db;
  const host = s.identity("agent-0").generation,
    guest = s.identity("agent-1").generation;
  const invitationId = randomUUID(),
    visitId = randomUUID(),
    messageId = randomUUID(),
    now = f.runtime.now();
  db.prepare(
    "INSERT INTO home_social_invitations(id,host_agent_id,host_generation,guest_agent_id,guest_generation,initiator_generation,recipient_generation,room_id,audience,requested_scope,status,policy_revision,created_at,expires_at) VALUES(?,'agent-0',?,'agent-1',?,?,?,'room-fixture','[]',?,'accepted',1,?,?)",
  ).run(
    invitationId,
    host,
    guest,
    host,
    guest,
    JSON.stringify({ scope: ["layout"], selectedItems: [] }),
    now,
    now + 86400000,
  );
  db.prepare(
    "INSERT INTO home_social_visits(id,invitation_id,host_agent_id,host_generation,guest_agent_id,guest_generation,room_id,pair_key,status,policy_revision,started_at,expires_at) VALUES(?,?,'agent-0',?,'agent-1',?,'room-fixture','fixture-pair','active',1,?,?)",
  ).run(visitId, invitationId, host, guest, now, now + 86400000);
  db.prepare(
    "INSERT INTO home_social_messages(id,visit_id,author_agent_id,author_generation,sequence,body,source_labels,audience,created_at) VALUES(?,?,'agent-0',?,1,'synthetic real service body','[]','[]',?)",
  ).run(messageId, visitId, host, now);
  const read = () =>
    f.request("/api/home-social/read", {
      method: "POST",
      body: JSON.stringify({ kind: "visit", id: visitId, limit: 20 }),
    });
  const res = await read();
  assert.equal(res.status, 200);
  const value = await res.json();
  assert.equal(value.messages[0].body, "synthetic real service body");
  assert.equal(
    db
      .prepare("SELECT outcome FROM home_social_admin_access_audit WHERE id=?")
      .get(value.auditId).outcome,
    "success",
  );
  assert.equal(
    db.prepare("SELECT count(*) AS n FROM home_social_read_cursors").get().n,
    0,
  );
  db.exec(
    "CREATE TRIGGER deny_admin_audit BEFORE INSERT ON home_social_admin_access_audit BEGIN SELECT RAISE(ABORT,'synthetic audit failure'); END",
  );
  const failed = await read();
  assert.ok(failed.status >= 400);
  assert.equal(
    JSON.stringify(await failed.json()).includes("synthetic real service body"),
    false,
  );
  db.exec("DROP TRIGGER deny_admin_audit");
  const hidden = await f.request("/api/home-social/moderate", {
    method: "POST",
    body: JSON.stringify({
      requestId: "admin-hide-real",
      policyRevision: s.policy().revision,
      action: "hide-message",
      targetId: messageId,
      expectedRevision: 1,
    }),
  });
  assert.equal(hidden.status, 200);
  const reread = await (await read()).json();
  assert.equal(reread.messages[0].state, "hidden");
  assert.equal(reread.messages[0].body, undefined);
  assert.equal(
    db.prepare("SELECT count(*) AS n FROM home_social_read_cursors").get().n,
    0,
  );
  const overview = await f.request("/api/home-social/overview?limit=1");
  assert.equal(overview.status, 200);
  const page = await overview.json();
  assert.equal(page.items.length, 1);
  assert.ok(page.nextCursor);
  assert.equal(
    JSON.stringify(page).includes("synthetic real service body"),
    false,
  );
});
