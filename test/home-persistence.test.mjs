import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { fixture, context, config } from "./helpers.mjs";
import { createServer } from "../src/server.mjs";
import { MemoryStore } from "../src/memory/store.mjs";
import { backupDatabase } from "../src/memory/backup.mjs";
import { HomeStore } from "../src/home/store.mjs";
import { HomeService } from "../src/home/service.mjs";
import { defaultLayout, validateLayout } from "../src/home/layout.mjs";
function shared(
  f,
  layout = defaultLayout("living"),
  expectedRevision = 0,
  requestId = "test-save-0001",
) {
  return {
    layout,
    expectedRevision,
    requestId,
    rosterRevision: f.runtime.home.rosterRevision(),
  };
}
async function server(t) {
  const f = fixture(t),
    token = randomBytes(32).toString("hex"),
    app = createServer({ runtime: f.runtime, token });
  const port = await app.listen();
  t.after(() => app.close());
  return {
    ...f,
    app,
    token,
    base: `http://127.0.0.1:${port}`,
    request: (url, body, headers = { "x-admin-token": token }) =>
      fetch(`http://127.0.0.1:${port}${url}`, {
        method: body ? "PUT" : "GET",
        headers,
        ...(body ? { body: JSON.stringify(body) } : {}),
      }),
  };
}
test("home reads real configured residents without allocating layout records or leaking private config", async (t) => {
  const f = await server(t);
  const before = f.store.db
    .prepare("SELECT count(*) n FROM home_layouts")
    .get().n;
  const r = await f.request("/api/home/overview"),
    data = await r.json();
  assert.equal(r.status, 200);
  assert.equal(data.residents.length, 3);
  assert.deepEqual(Object.keys(data.residents[0]).sort(), [
    "id",
    "name",
    "state",
  ]);
  assert.equal(data.residents[0].state, "online");
  for (const type of ["living", "hall", "room"]) {
    const r = await f.request(
      "/api/home/scene?type=" +
        type +
        (type === "room" ? "&agentId=agent-0" : ""),
    );
    const d = await r.json();
    assert.equal(d.layoutRevision, 0);
    assert.equal(d.capabilities.write, type !== "room");
    assert.equal(d.contentRevision, 0);
  }
  assert.equal(
    f.store.db.prepare("SELECT count(*) n FROM home_layouts").get().n,
    before,
  );
  assert.equal(
    (await f.request("/api/home/overview", undefined, {})).status,
    401,
  );
  const ctx = context(f.runtime);
  assert.equal(
    (
      await f.request("/api/home/overview", undefined, {
        "x-agent-capability": ctx.token,
      })
    ).status,
    401,
  );
  assert.equal(
    (
      await f.request("/api/home/overview", undefined, {
        "x-admin-token": f.token,
        origin: "https://example.invalid",
      })
    ).status,
    403,
  );
  assert.equal(
    (await f.request("/api/home/scene?type=room&agentId=agent-0", shared(f)))
      .status,
    403,
  );
  assert.equal(
    (await f.request("/api/home/scene?type=room", shared(f))).status,
    403,
  );
});
test("shared layout commit, stale revisions, canonical retries and undo survive reopen", (t) => {
  const f = fixture(t),
    h = f.runtime.home,
    layout = defaultLayout("living");
  layout.palette = "blue";
  const first = shared(f, layout),
    r = h.saveShared("living", first);
  assert.equal(r.layoutRevision, 1);
  assert.equal(
    h.saveShared("living", { ...first, layout: { ...layout, objects: {} } })
      .replayed,
    true,
  );
  assert.throws(
    () =>
      h.saveShared("living", {
        ...first,
        layout: { ...layout, palette: "rose" },
      }),
    /HOME_REQUEST_CONFLICT/,
  );
  assert.throws(
    () => h.saveShared("living", { ...first, requestId: "stale-save-0002" }),
    /HOME_REVISION_CONFLICT/,
  );
  const undo = {
    expectedRevision: 1,
    requestId: "test-undo-0001",
    undoRevision: 0,
    rosterRevision: h.rosterRevision(),
  };
  assert.equal(h.saveShared("living", undo).layoutRevision, 2);
  assert.equal(h.read("living").layout.palette, "cream");
  assert.equal(h.saveShared("living", first).layoutRevision, 1);
  assert.equal(h.read("living").layoutRevision, 2);
  const db = new DatabaseSync(f.store.file);
  try {
    const reopened = new HomeStore(db);
    assert.equal(
      reopened.read("shared:living", defaultLayout("living")).layoutRevision,
      2,
    );
    assert.equal(
      reopened.commit(
        "shared:living",
        undo,
        defaultLayout("living"),
        (v) => validateLayout(v, "living"),
        Date.now(),
      ).replayed,
      true,
    );
  } finally {
    db.close();
  }
});
test("failed layout batches and receipt write failures roll back atomically", (t) => {
  const f = fixture(t),
    h = f.runtime.home,
    bad = defaultLayout("living");
  bad.palette = "blue";
  bad.objects.door = { asset: "bed" };
  assert.throws(
    () => h.saveShared("living", shared(f, bad)),
    /HOME_SCENE_INVALID/,
  );
  assert.equal(h.read("living").layoutRevision, 0);
  const outside = defaultLayout("living");
  outside.objects.door = { dx: 6, scale: 1.15 };
  assert.throws(
    () => h.saveShared("living", shared(f, outside)),
    /HOME_LAYOUT_BOUNDS/,
  );
  f.store.db.exec(
    "CREATE TRIGGER test_home_receipt_failure BEFORE INSERT ON home_operations BEGIN SELECT RAISE(ABORT,'synthetic'); END",
  );
  assert.throws(() => h.saveShared("living", shared(f)), /synthetic/);
  assert.equal(h.read("living").layoutRevision, 0);
  assert.equal(
    f.store.db.prepare("SELECT count(*) n FROM home_operations").get().n,
    0,
  );
  f.store.db.exec("DROP TRIGGER test_home_receipt_failure");
  assert.equal(h.saveShared("living", shared(f)).layoutRevision, 1);
});
test("subject-only room foundation rejects foreign, expired, aborted, protected and paused callers", (t) => {
  const cfg = config();
  cfg.agents.forEach((a) => (a.subject.enabled = true));
  const f = fixture(t, { cfg }),
    h = f.runtime.home,
    gen = h.generation("agent-0");
  const data = {
    layout: defaultLayout("room"),
    requestId: "room-save-0001",
    expectedRevision: 0,
  };
  assert.throws(
    () => h.saveRoom(context(f.runtime), data, gen),
    /HOME_WRITE_DENIED/,
  );
  assert.throws(
    () => h.saveRoom(context(f.runtime, "agent-1", "@subject"), data, gen),
    /HOME_WRITE_DENIED/,
  );
  const a = context(f.runtime, "agent-0", "@subject");
  a.controller.abort();
  assert.throws(() => h.saveRoom(a, data, gen), /HOME_WRITE_DENIED/);
  const b = context(f.runtime, "agent-0", "@subject");
  b.expires = 0;
  assert.throws(() => h.saveRoom(b, data, gen), /HOME_WRITE_DENIED/);
  const c = context(f.runtime, "agent-0", "@subject");
  c.privateRead.add("operations:synthetic");
  assert.throws(() => h.saveRoom(c, data, gen), /HOME_WRITE_DENIED/);
  const d = context(f.runtime, "agent-0", "@subject");
  assert.equal(h.saveRoom(d, data, gen).layoutRevision, 1);
  assert.equal(h.read("room", "agent-1").layoutRevision, 0);
  f.runtime.config.globalPaused = true;
  assert.throws(() => h.saveRoom(d, data, gen), /HOME_WRITE_DENIED/);
});
test("removed identities lose access and re-addition cannot inherit old layouts or receipts", async (t) => {
  const cfg = config();
  cfg.agents.forEach((a) => (a.subject.enabled = true));
  const f = fixture(t, { cfg }),
    h = f.runtime.home,
    gen = h.generation("agent-0");
  const ctx = context(f.runtime, "agent-0", "@subject"),
    d = {
      layout: { ...defaultLayout("room"), palette: "rose" },
      expectedRevision: 0,
      requestId: "identity-save-001",
    };
  h.saveRoom(ctx, d, gen);
  const old = structuredClone(f.runtime.config),
    next = structuredClone(old);
  next.agents = next.agents.filter((a) => a.id !== "agent-0");
  await f.runtime.commitConfig(next, f.configStore.revision);
  assert.throws(() => h.read("room", "agent-0"), /HOME_ROOM_NOT_FOUND/);
  await f.runtime.commitConfig(old, f.configStore.revision);
  assert.notEqual(h.generation("agent-0"), gen);
  assert.equal(h.read("room", "agent-0").layoutRevision, 0);
  assert.throws(() => h.saveRoom(ctx, d, gen), /HOME_WRITE_DENIED/);
});
test("roster changes conflict with a shared edit and hallway instances stay tied to stable IDs", async (t) => {
  const f = fixture(t),
    h = f.runtime.home,
    layout = defaultLayout("hall");
  layout.objects["door-agent-0"] = { hidden: true };
  const d = shared(f, layout);
  const next = structuredClone(f.runtime.config);
  next.agents.reverse();
  await f.runtime.commitConfig(next, f.configStore.revision);
  assert.throws(() => h.saveShared("hall", d), /HOME_ROSTER_CONFLICT/);
  h.saveShared("hall", { ...d, rosterRevision: h.rosterRevision() });
  assert.deepEqual(h.read("hall").layout.objects["door-agent-0"], {
    hidden: true,
  });
  const gone = structuredClone(next);
  gone.agents = gone.agents.filter((a) => a.id !== "agent-0");
  await f.runtime.commitConfig(gone, f.configStore.revision);
  assert.equal(h.read("hall").layout.objects["door-agent-0"], undefined);
});
test("full SQLite backup restores layouts and receipts; single-agent export does not export shared homes", async (t) => {
  const f = fixture(t),
    h = f.runtime.home;
  h.saveShared(
    "living",
    shared(f, { ...defaultLayout("living"), palette: "blue" }),
  );
  const file = path.join(f.root, "home-backup.sqlite");
  assert.equal((await backupDatabase(f.store.file, file)).integrity, "ok");
  const copy = new MemoryStore(file);
  try {
    const rt = {
      ...f.runtime,
      memory: copy,
      config: f.runtime.config,
      now: () => f.runtime.now(),
    };
    const restored = new HomeService(rt);
    assert.equal(restored.read("living").layout.palette, "blue");
    assert.equal(
      restored.saveShared(
        "living",
        shared(f, { ...defaultLayout("living"), palette: "blue" }),
      ).replayed,
      true,
    );
  } finally {
    copy.close();
  }
  const exp = f.store.bind("agent-0").export();
  assert.ok(!Object.keys(exp.tables).some((k) => k.startsWith("home_")));
});
test("HTTP stale writes return 409 and never impersonate a board reader", async (t) => {
  const f = await server(t),
    first = shared(f);
  const url = "/api/home/scene?type=living";
  assert.equal((await f.request(url, first)).status, 200);
  assert.equal(
    (await f.request(url, { ...first, requestId: "stale-http-001" })).status,
    409,
  );
  assert.equal(
    (await f.request(url, { ...first, ownerAgentId: "agent-0" })).status,
    400,
  );
  const before = f.store.db.prepare("SELECT * FROM board_reads").all();
  await f.request("/api/board");
  await f.request("/api/home/overview");
  assert.deepEqual(
    f.store.db.prepare("SELECT * FROM board_reads").all(),
    before,
  );
  assert.equal(f.runtime.jobs.size, 0);
  f.runtime.maintenance.begin();
  assert.equal(
    (
      await f.request(url, {
        ...first,
        expectedRevision: 1,
        requestId: "maint-save-001",
      })
    ).status,
    409,
  );
});

test("hall undo filters removed doors but still validates the surviving furniture", async (t) => {
  const f = fixture(t),
    h = f.runtime.home;
  const first = {
    ...defaultLayout("hall"),
    palette: "blue",
    objects: { "door-agent-0": { dx: 1 }, plant: { scale: 0.9 } },
  };
  h.saveShared("hall", shared(f, first, 0, "hall-undo-first"));
  h.saveShared(
    "hall",
    shared(f, { ...first, palette: "rose" }, 1, "hall-undo-second"),
  );
  const next = structuredClone(f.runtime.config);
  next.agents.shift();
  await f.runtime.commitConfig(next, f.runtime.configStore.revision);
  const undo = h.saveShared("hall", {
    expectedRevision: 2,
    rosterRevision: h.rosterRevision(),
    requestId: "hall-undo-after-delete",
    undoRevision: 1,
  });
  assert.equal(undo.layoutRevision, 3);
  assert.equal(undo.layout.palette, "blue");
  assert.deepEqual(undo.layout.objects, { plant: { scale: 0.9 } });
  assert.equal(h.read("hall").layout.palette, "blue");
  assert.throws(
    () => h.saveShared("hall", shared(f, first, 3, "new-write-old-door")),
    /HOME_SCENE_INVALID/,
  );
  f.store.db
    .prepare(
      "UPDATE home_layouts SET layout=? WHERE scene_key=? AND revision=1",
    )
    .run(
      JSON.stringify({ ...first, objects: { plant: { scale: 5 } } }),
      "shared:hall",
    );
  assert.throws(
    () =>
      h.saveShared("hall", {
        expectedRevision: 3,
        rosterRevision: h.rosterRevision(),
        requestId: "invalid-history-undo",
        undoRevision: 1,
      }),
    /HOME_SCENE_INVALID/,
  );
  assert.equal(h.read("hall").layoutRevision, 3);
});
