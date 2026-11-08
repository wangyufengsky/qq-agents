import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { randomBytes } from "node:crypto";
import { config, fixture, context } from "./helpers.mjs";
import { validateConfig } from "../src/core/config.mjs";
import { Runtime } from "../src/core/runtime.mjs";
import { MemoryStore } from "../src/memory/store.mjs";
import { backupDatabase } from "../src/memory/backup.mjs";
import { restoreExport } from "../src/memory/migrate.mjs";
import { exportToFile } from "../src/memory/export.mjs";
import { createServer } from "../src/server.mjs";

const OWNER = "private:30000",
  CONTENT = "待审的合成正文 <img src=x onerror=alert(1)>";
function setup(t) {
  const cfg = config(1);
  cfg.agents[0].ownerIds = ["30000"];
  cfg.agents[0].behavior.actions = { qzone: true };
  cfg.agents[0].subject = { enabled: true };
  cfg.agents[0].tools.push("qzone_read", "qzone_post");
  const f = fixture(t, { cfg: validateConfig(cfg) });
  f.calls = [];
  f.transport = f.runtime.transports.get("qq-0");
  f.transport.qzonePost = async (args) => {
    f.calls.push(args);
    return { confirmed: true };
  };
  f.ctx = context(f.runtime, "agent-0", OWNER);
  f.ctx.privateRead.add("operations:synthetic");
  f.mem = f.store.bind("agent-0");
  return f;
}
const post = (f, requestId = "draft-1", content = CONTENT) =>
  f.runtime.callTool(f.ctx, "qzone_post", { requestId, content });
const decision = (f, action = "approve") => {
  const r = f.runtime.qzoneApprovals.list()[0];
  return {
    approvalId: r.approvalId,
    agentId: r.agentId,
    digest: r.digest,
    action,
  };
};
async function restored(t, f) {
  const file = path.join(f.root, "restored.sqlite");
  await backupDatabase(f.store.file, file);
  const memory = new MemoryStore(file);
  const runtime = new Runtime({
    configStore: f.configStore,
    memory,
    backendFactory: () => ({ close() {} }),
  });
  runtime.transports.set("qq-0", f.transport);
  t.after(async () => {
    await runtime.close();
    memory.close();
  });
  return runtime;
}

test("reviewed post survives the original turn and restart without exposing its draft to model memory", async (t) => {
  const f = setup(t);
  const receipt = await post(f);
  assert.equal(receipt.status, "awaiting_approval");
  assert.equal(JSON.stringify(receipt).includes(CONTENT), false);
  assert.equal(f.runtime.status().disclosureRequests.length, 0);
  assert.equal(JSON.stringify(f.runtime.status()).includes(CONTENT), false);
  assert.equal(f.mem.search({ query: "待审的合成正文" }).items.length, 0);
  assert.equal(f.mem.delivery("draft-1"), undefined);
  assert.equal(f.calls.length, 0);
  const input = decision(f);
  f.ctx.controller.abort();
  f.runtime.capabilities.delete(f.ctx.token);
  const runtime = await restored(t, f);
  assert.equal(runtime.qzoneApprovals.list()[0].content, CONTENT);
  const result = await runtime.qzoneApprovals.act(input);
  assert.equal(result.status, "sent");
  assert.deepEqual(f.calls, [{ content: CONTENT }]);
  assert.equal(
    runtime.memory.bind("agent-0").delivery("draft-1").status,
    "sent",
  );
  await assert.rejects(
    runtime.qzoneApprovals.act(input),
    /QZONE_APPROVAL_CLOSED/,
  );
  assert.equal(f.calls.length, 1);
});

test("duplicate proposals keep their deadline, and changed text or forged approval cannot consume it", async (t) => {
  const f = setup(t),
    first = await post(f),
    input = decision(f);
  assert.deepEqual(await post(f), first);
  await assert.rejects(post(f, "draft-1", "改稿"), /QZONE_APPROVAL_CONFLICT/);
  for (const patch of [
    { digest: "0".repeat(64) },
    { agentId: "agent-1" },
    { content: "改稿" },
  ])
    await assert.rejects(f.runtime.qzoneApprovals.act({ ...input, ...patch }));
  assert.equal(f.runtime.qzoneApprovals.list().length, 1);
  assert.equal(f.calls.length, 0);
  // A broad disclosure grant does not approve arbitrary later public text.
  f.ctx.grants.add("operations:synthetic");
  assert.equal((await post(f, "draft-2", "改稿")).status, "awaiting_approval");
});

for (const mode of ["cancel", "expire"])
  test(`${mode} closes a draft without publishing or extending its lifetime`, async (t) => {
    const f = setup(t),
      first = await post(f),
      input = decision(f);
    if (mode === "cancel")
      await f.runtime.qzoneApprovals.act({ ...input, action: "cancel" });
    else f.runtime.clock = () => new Date(first.expiresAt);
    await assert.rejects(
      f.runtime.qzoneApprovals.act(input),
      /QZONE_APPROVAL_CLOSED/,
    );
    assert.equal(
      (await post(f)).status,
      mode === "cancel" ? "cancelled" : "expired",
    );
    assert.equal(f.calls.length, 0);
  });

for (const mode of [
  "global pause",
  "role pause",
  "conversation pause",
  "quiet hours",
  "tool",
  "switch",
  "owner",
  "account",
  "connection",
  "budget",
  "isolation",
])
  test(`approval rechecks ${mode} and keeps the draft when no delivery was reserved`, async (t) => {
    const f = setup(t);
    await post(f);
    const input = decision(f);
    const a = f.runtime.agent("agent-0");
    if (mode === "global pause") f.runtime.config.globalPaused = true;
    if (mode === "role pause") a.paused = true;
    if (mode === "conversation pause")
      f.mem.setState(OWNER, { ...f.mem.state(OWNER), paused: true });
    if (mode === "quiet hours")
      a.silence = [
        {
          start: "00:00",
          end: "00:00",
          allDay: true,
          days: [0, 1, 2, 3, 4, 5, 6],
          timezone: "UTC",
        },
      ];
    if (mode === "tool") a.tools = a.tools.filter((n) => n !== "qzone_post");
    if (mode === "switch") a.behavior.actions.qzone = false;
    if (mode === "owner") a.ownerIds = [];
    if (mode === "account") f.runtime.connection("qq-0").accountId = "10001";
    if (mode === "connection") f.runtime.connection("qq-0").enabled = false;
    if (mode === "isolation") f.runtime.config.mode = "isolated";
    if (mode === "budget") {
      a.behavior.actions.qzoneMaxPerDay = 1;
      f.mem.append({
        dedupe: "previous-post",
        conversation: OWNER,
        kind: "message.send-attempt",
        payload: { actionKind: "qzone" },
      });
    }
    await assert.rejects(f.runtime.qzoneApprovals.act(input));
    assert.equal(f.calls.length, 0);
    assert.equal(
      f.runtime.qzoneApprovals.list()[0].status,
      "awaiting_approval",
    );
    assert.equal(f.mem.delivery("draft-1"), undefined);
  });

test("queued approval rechecks revocation at its actual delivery slot", async (t) => {
  const f = setup(t);
  await post(f);
  let release;
  f.runtime.delivery.queues.set(
    "qq-0",
    new Promise((resolve) => {
      release = resolve;
    }),
  );
  const pending = f.runtime.qzoneApprovals.act(decision(f));
  f.runtime.agent("agent-0").tools = [];
  release();
  await assert.rejects(pending, /TOOL_DISABLED/);
  assert.equal(f.calls.length, 0);
});

test("concurrent approval and restart cannot replay a sent or unknown post", async (t) => {
  const f = setup(t);
  await post(f);
  const input = decision(f);
  let release;
  f.transport.qzonePost = async (args) => {
    f.calls.push(args);
    await new Promise((resolve) => {
      release = resolve;
    });
    throw Error("SYNTHETIC_NETWORK_FAILURE");
  };
  const pending = f.runtime.qzoneApprovals.act(input);
  await assert.rejects(
    f.runtime.qzoneApprovals.act(input),
    /QZONE_APPROVAL_CLOSED/,
  );
  release();
  await assert.rejects(pending, /DELIVERY_UNKNOWN/);
  const runtime = await restored(t, f);
  await assert.rejects(
    runtime.qzoneApprovals.act(input),
    /QZONE_APPROVAL_CLOSED/,
  );
  await post(f, "draft-2", "另一个请求");
  await assert.rejects(
    f.runtime.qzoneApprovals.act(decision(f)),
    /QZONE_POST_UNCONFIRMED/,
  );
  assert.equal(f.calls.length, 1);
});

for (const phase of ["before-ledger", "pending-ledger", "sent-ledger"])
  test(`crash recovery closes an interrupted approval at ${phase}`, async (t) => {
    const f = setup(t);
    await post(f);
    const input = decision(f);
    f.store.db.prepare("UPDATE qzone_approvals SET state='submitting'").run();
    if (phase !== "before-ledger")
      f.mem.reserveDelivery("draft-1", OWNER, {
        kind: "qzone",
        content: CONTENT,
      });
    if (phase === "sent-ledger") f.mem.completeDelivery("draft-1", "sent");
    const runtime = await restored(t, f);
    await assert.rejects(
      runtime.qzoneApprovals.act(input),
      /QZONE_APPROVAL_CLOSED/,
    );
    assert.equal(f.calls.length, 0);
  });

test("approval never replaces newer session taint or grants another model turn", async (t) => {
  const f = setup(t);
  await post(f);
  const input = decision(f);
  f.mem.setState(OWNER, {
    ...f.mem.state(OWNER),
    disclosureTaint: ["operations:newer"],
  });
  await f.runtime.qzoneApprovals.act(input);
  assert.deepEqual(f.mem.state(OWNER).disclosureTaint, ["operations:newer"]);
  const next = context(f.runtime, "agent-0", OWNER);
  assert.equal(next.grants.size, 0);
  assert.deepEqual([...next.privateRead], ["operations:newer"]);
});

test("SQLite migration and JSON export retain replay fences but restore no publish authority", async (t) => {
  const f = setup(t);
  await post(f);
  const output = path.join(f.root, "export.json");
  await exportToFile(f.store, "agent-0", output);
  const data = JSON.parse(fs.readFileSync(output, "utf8"));
  assert.equal(data.tables.qzone_approvals.length, 1);
  const restoredStore = new MemoryStore(path.join(f.root, "imported.sqlite"));
  t.after(() => restoredStore.close());
  restoreExport(restoredStore.bind("agent-0"), data);
  assert.equal(
    restoredStore.db.prepare("SELECT state FROM qzone_approvals").get().state,
    "cancelled",
  );
  assert.equal(
    restoredStore.bind("agent-0").search({ query: "待审的合成正文" }).items
      .length,
    0,
  );
});

test("pending approval count is bounded and credentials are rejected before storage", async (t) => {
  const f = setup(t);
  await assert.rejects(
    post(f, "secret", "sk-" + "a".repeat(40)),
    /SENSITIVE_OUTPUT_BLOCKED/,
  );
  assert.equal(f.runtime.qzoneApprovals.list().length, 0);
  for (let i = 0; i < 10; i++) await post(f, `draft-${i}`);
  await assert.rejects(post(f, "overflow"), /QZONE_APPROVAL_LIMIT/);
});

test("admin-only console escapes drafts and submits only the reviewed identity and digest", async (t) => {
  const f = setup(t);
  await post(f);
  const token = randomBytes(32).toString("hex");
  const app = createServer({ runtime: f.runtime, token, allowLive: true });
  const port = await app.listen();
  t.after(() => app.close());
  const request = (route, options = {}) =>
    fetch(`http://127.0.0.1:${port}${route}`, options);
  for (const headers of [{}, { "x-agent-capability": f.ctx.token }]) {
    assert.equal((await request("/api/status", { headers })).status, 401);
    assert.equal(
      (
        await request("/api/qzone/approval", {
          method: "POST",
          headers,
          body: JSON.stringify(decision(f)),
        })
      ).status,
      401,
    );
  }
  const response = await request("/api/status", {
    headers: { "x-admin-token": token },
  });
  assert.equal(response.headers.get("cache-control"), "no-store");
  const initialStatus = await response.json();
  const nodes = new Map();
  let submitted;
  const sandbox = vm.createContext({
    document: {
      querySelector: (s) => {
        if (!nodes.has(s)) nodes.set(s, { addEventListener() {} });
        return nodes.get(s);
      },
      querySelectorAll: () => [],
    },
    sessionStorage: { getItem: () => "" },
    setInterval() {},
    initialStatus,
    fetch: (route, options) => {
      submitted = JSON.parse(options.body);
      return request(route, {
        ...options,
        headers: { "x-admin-token": token },
      });
    },
  });
  vm.runInContext(
    fs.readFileSync(new URL("../public/app.js", import.meta.url), "utf8"),
    sandbox,
  );
  const html = vm.runInContext(
    'config = { agents: [{id:"agent-0",name:"角色"}] }; status = initialStatus; qzoneApprovalMarkup(status.qzoneApprovals)',
    sandbox,
  );
  assert(!html.includes("<img"));
  assert(html.includes("&lt;img"));
  assert(html.includes("批准并发布这条说说"));
  await vm.runInContext(
    'load = async () => {}; operate("qzone-approve", status.qzoneApprovals[0].approvalId)',
    sandbox,
  );
  assert.deepEqual(submitted, {
    ...decisionFrom(initialStatus.qzoneApprovals[0]),
    action: "approve",
  });
  assert.equal(f.calls.length, 1);
  assert.equal(
    JSON.stringify(f.runtime.diagnostics.snapshot()).includes(CONTENT),
    false,
  );
});
function decisionFrom(row) {
  return {
    approvalId: row.approvalId,
    agentId: row.agentId,
    digest: row.digest,
  };
}

test("a queued autonomous post cannot inherit a later generic disclosure grant", async (t) => {
  const f = setup(t);
  f.ctx.privateRead.clear();
  let release;
  f.runtime.delivery.queues.set(
    "qq-0",
    new Promise((resolve) => {
      release = resolve;
    }),
  );
  const pending = post(f);
  f.ctx.privateRead.add("operations:parallel-read");
  f.ctx.grants.add("operations:parallel-read");
  release();
  await assert.rejects(pending, /PRIVATE_RECOLLECTION_EXTERNAL_CALL_BLOCKED/);
  assert.equal(f.calls.length, 0);
  assert.equal((await post(f)).status, "awaiting_approval");
});

test("an old SQLite database receives the approval table during schema initialization", async (t) => {
  const f = setup(t);
  const file = path.join(f.root, "old.sqlite");
  const old = new MemoryStore(file);
  old.db.exec("DROP TABLE qzone_approvals");
  old.close();
  const upgraded = new MemoryStore(file);
  t.after(() => upgraded.close());
  assert.equal(
    upgraded.db.prepare("SELECT count(*) AS n FROM qzone_approvals").get().n,
    0,
  );
  assert.equal(
    upgraded.db.prepare("PRAGMA user_version").get().user_version,
    7,
  );
});

test("a console started without live authority cannot publish an approved draft", async (t) => {
  const f = setup(t);
  await post(f);
  const token = randomBytes(32).toString("hex");
  const app = createServer({ runtime: f.runtime, token, allowLive: false });
  const port = await app.listen();
  t.after(() => app.close());
  const response = await fetch(`http://127.0.0.1:${port}/api/qzone/approval`, {
    method: "POST",
    headers: { "x-admin-token": token },
    body: JSON.stringify(decision(f)),
  });
  assert.equal((await response.json()).error, "ISOLATED_MODE");
  assert.equal(f.calls.length, 0);
  assert.equal(
    JSON.stringify(f.runtime.diagnostics.snapshot()).includes(CONTENT),
    false,
  );
});

for (const kind of ["chat", "other-post", "other-conversation"])
  test(`an existing ${kind} receipt cannot masquerade as a new draft`, async (t) => {
    const f = setup(t);
    const payload =
      kind === "chat"
        ? [{ type: "text", data: { text: "other message" } }]
        : {
            kind: "qzone",
            content: kind === "other-post" ? "other content" : CONTENT,
          };
    f.mem.reserveDelivery(
      "draft-1",
      kind === "other-conversation" ? "@subject" : OWNER,
      payload,
    );
    f.mem.completeDelivery("draft-1", "sent");
    await assert.rejects(post(f), /IDEMPOTENCY_CONFLICT/);
    assert.equal(f.runtime.qzoneApprovals.list().length, 0);
    assert.equal(f.calls.length, 0);
  });

test("a ledger collision after proposal closes the draft as failed across retries and restart", async (t) => {
  const f = setup(t);
  await post(f);
  const input = decision(f);
  f.mem.reserveDelivery("draft-1", OWNER, {
    kind: "qzone",
    content: "another post",
  });
  f.mem.completeDelivery("draft-1", "sent");
  await assert.rejects(
    f.runtime.qzoneApprovals.act(input),
    /IDEMPOTENCY_CONFLICT/,
  );
  assert.equal((await post(f)).status, "failed");
  assert.equal(f.mem.delivery("draft-1").status, "sent");
  const runtime = await restored(t, f);
  const next = context(runtime, "agent-0", OWNER);
  assert.equal(
    (
      await runtime.callTool(next, "qzone_post", {
        requestId: "draft-1",
        content: CONTENT,
      })
    ).status,
    "failed",
  );
  assert.equal(f.calls.length, 0);
});

test("crash recovery never adopts a different payload's sent receipt", async (t) => {
  const f = setup(t);
  await post(f);
  f.store.db.prepare("UPDATE qzone_approvals SET state='submitting'").run();
  f.mem.reserveDelivery("draft-1", OWNER, {
    kind: "qzone",
    content: "another post",
  });
  f.mem.completeDelivery("draft-1", "sent");
  const runtime = await restored(t, f);
  const next = context(runtime, "agent-0", OWNER);
  assert.equal(
    (
      await runtime.callTool(next, "qzone_post", {
        requestId: "draft-1",
        content: CONTENT,
      })
    ).status,
    "failed",
  );
  assert.equal(f.calls.length, 0);
});

test("a matching old post receipt needs no new approval and is never resent", async (t) => {
  const f = setup(t);
  f.mem.reserveDelivery("draft-1", OWNER, { kind: "qzone", content: CONTENT });
  f.mem.completeDelivery("draft-1", "sent");
  assert.equal((await post(f)).status, "sent");
  assert.equal(f.runtime.qzoneApprovals.list().length, 0);
  assert.equal(f.calls.length, 0);
});
