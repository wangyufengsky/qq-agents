import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createServer } from "../src/server.mjs";
import { fixture, context } from "./helpers.mjs";

async function unknownSend(runtime, requestId, text = "晚上八点见") {
  const transport = runtime.transports.get("qq-0");
  transport.failure = "TIMEOUT";
  await assert.rejects(
    runtime.send(context(runtime), { requestId, text }),
    /UNKNOWN/,
  );
  transport.failure = null;
}

test("unknown receipts are listed with their attempted text", async (t) => {
  const { runtime, store } = fixture(t);
  await unknownSend(runtime, "u-1");
  await runtime.send(context(runtime), { requestId: "ok-1", text: "fine" });
  const mem = store.bind("agent-0");
  assert.equal(mem.unresolvedDeliveryCount(), 1);
  const page = mem.unresolvedDeliveries();
  assert.equal(page.total, 1);
  assert.deepEqual(
    page.items.map(({ requestId, conversation, preview }) => ({
      requestId,
      conversation,
      preview,
    })),
    [{ requestId: "u-1", conversation: "group:20000", preview: "晚上八点见" }],
  );
  assert.equal(store.bind("agent-1").unresolvedDeliveryCount(), 0);
});

test("marking an unknown receipt sent settles it without resending", async (t) => {
  const { runtime, store } = fixture(t);
  await unknownSend(runtime, "u-sent");
  const mem = store.bind("agent-0");
  assert.deepEqual(mem.reconcileDelivery("u-sent", "sent"), {
    requestId: "u-sent",
    status: "sent",
  });
  assert.equal(mem.delivery("u-sent").status, "sent");
  assert.equal(mem.unresolvedDeliveryCount(), 0);
  const sentBefore = runtime.transports.get("qq-0").sent.length;
  const again = await runtime.send(context(runtime), {
    requestId: "u-sent",
    text: "晚上八点见",
  });
  assert.equal(again.duplicate, true);
  assert.equal(runtime.transports.get("qq-0").sent.length, sentBefore);
  const record = mem
    .search({ kind: "message.send-result" })
    .items.find((x) => x.status === "confirmed");
  assert.ok(record, "reconciliation is archived");
  assert.throws(
    () => mem.reconcileDelivery("u-sent", "failed"),
    /DELIVERY_ALREADY_SETTLED/,
  );
});

test("marking an unknown receipt failed keeps the same request fenced", async (t) => {
  const { runtime, store } = fixture(t);
  await unknownSend(runtime, "u-failed");
  store.bind("agent-0").reconcileDelivery("u-failed", "failed");
  await assert.rejects(
    runtime.send(context(runtime), {
      requestId: "u-failed",
      text: "晚上八点见",
    }),
    /ALREADY_ATTEMPTED_FAILED/,
  );
  assert.throws(
    () => store.bind("agent-0").reconcileDelivery("missing", "sent"),
    /DELIVERY_NOT_FOUND/,
  );
});

test("console lists, reconciles and reports blockers over HTTP", async (t) => {
  const f = fixture(t),
    token = randomBytes(32).toString("hex"),
    app = createServer({ runtime: f.runtime, token });
  const port = await app.listen();
  t.after(() => app.close());
  const request = (url, body) =>
    fetch(`http://127.0.0.1:${port}${url}`, {
      method: body ? "POST" : "GET",
      headers: {
        "x-admin-token": token,
        ...(body ? { "content-type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  await unknownSend(f.runtime, "u-http");
  let status = await (await request("/api/status")).json();
  const agent = status.agents.find((a) => a.id === "agent-0");
  assert.equal(agent.unresolvedDeliveries, 1);
  assert.deepEqual(agent.blockers, []);
  const page = await (await request("/api/deliveries?agentId=agent-0")).json();
  assert.equal(page.items[0].requestId, "u-http");
  assert.equal(
    (
      await request("/api/deliveries/reconcile", {
        agentId: "agent-0",
        requestId: "u-http",
        resolution: "resend",
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await request("/api/deliveries/reconcile", {
        agentId: "agent-0",
        requestId: "u-http",
        resolution: "sent",
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await request("/api/deliveries/reconcile", {
        agentId: "agent-0",
        requestId: "u-http",
        resolution: "sent",
      })
    ).status,
    409,
  );
  await f.runtime.pause("all", true);
  f.runtime.transports.get("qq-0").connected = false;
  status = await (await request("/api/status")).json();
  assert.deepEqual(status.agents.find((a) => a.id === "agent-0").blockers, [
    "GLOBAL_PAUSED",
    "QQ_NOT_CONNECTED",
  ]);
});

test("conversation blockers explain exactly why writable is false", async (t) => {
  const { runtime, store } = fixture(t);
  const a = runtime.agent("agent-0");
  assert.deepEqual(runtime.blockers(a, "group:20000"), []);
  assert.equal(runtime.writable(a, "group:20000"), true);
  assert.deepEqual(runtime.blockers(a, "group:99999"), ["NOT_ALLOWED"]);
  const mem = store.bind("agent-0");
  mem.setState("group:20000", {
    ...mem.state("group:20000"),
    paused: true,
    silenceUntil: runtime.now() + 60000,
  });
  assert.deepEqual(runtime.blockers(a, "group:20000"), [
    "CONVERSATION_PAUSED",
    "CONVERSATION_SILENCED",
  ]);
  assert.equal(runtime.writable(a, "group:20000"), false);
  await runtime.pause("agent-0", true);
  assert.deepEqual(runtime.blockers(runtime.agent("agent-0")), [
    "AGENT_PAUSED",
  ]);
});

test("reconciliation keeps the attempt's repository and operations protection", async (t) => {
  const { store } = fixture(t);
  const mem = store.bind("agent-0");
  mem.reserveDelivery("u-private", "group:20000", [{ type: "text" }]);
  mem.append({
    dedupe: "send:u-private:pending",
    connectionId: "qq-0",
    conversation: "group:20000",
    kind: "message.send-attempt",
    direction: "out",
    status: "pending",
    body: "私有仓库里的发布计划",
    payload: {
      requestId: "u-private",
      protectedRepositories: ["owner/private-repo"],
      protectedOperations: true,
    },
  });
  mem.completeDelivery("u-private", "unknown");
  mem.reconcileDelivery("u-private", "sent");
  const row = mem.db
    .prepare("SELECT body,payload FROM events WHERE agent_id=? AND dedupe=?")
    .get("agent-0", "send:u-private:reconciled");
  const payload = JSON.parse(row.payload);
  assert.equal(row.body, "私有仓库里的发布计划");
  assert.deepEqual(payload.protectedRepositories, ["owner/private-repo"]);
  assert.equal(payload.protectedOperations, true);
  assert.equal(payload.reconciledBy, "administrator");
  assert.equal(payload.resolution, "sent");
});
