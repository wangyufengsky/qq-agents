import test from "node:test";
import assert from "node:assert/strict";
import { fixture, context, config } from "./helpers.mjs";
import {
  homeScenePage,
  homeSceneView,
  renderHomeScene,
} from "../src/home/scene-view.mjs";
import { homeTemplate, defaultLayout } from "../src/home/layout.mjs";
import { findScreenshotBrowser } from "../src/tools/public-screenshot.mjs";

function setup(t) {
  const cfg = config();
  cfg.agents[0].subject.enabled = true;
  cfg.agents[0].home = {
    enabled: true,
    publishing: true,
    sceneView: { enabled: true },
  };
  const f = fixture(t, { cfg });
  return { ...f, ctx: context(f.runtime, "agent-0", "@subject") };
}
test("scene view is opt-in, own-target only and text fallback is explicit", async (t) => {
  const f = setup(t);
  const a = f.runtime.agent("agent-0");
  const backend = f.runtime.config.backends.find((b) => b.id === a.backendId);
  backend.type = "openai";
  backend.vision = false;
  const result = await homeSceneView(f.runtime, f.ctx, {
    type: "room",
    viewport: "mobile",
  });
  assert.equal(result.imageAvailable, false);
  assert.equal(result.reason, "VISION_UNSUPPORTED");
  assert.equal(result.view.ownerAgentId, a.id);
  assert.equal(result.view.layoutRevision, 0);
  a.home.sceneView.enabled = false;
  await assert.rejects(
    homeSceneView(f.runtime, f.ctx, { type: "room" }),
    /HOME_SCENE_VIEW_DISABLED/,
  );
});
test("real browser renders persisted scene with the packaged desktop and mobile renderer", async (t) => {
  let executablePath;
  try {
    executablePath = findScreenshotBrowser();
  } catch (error) {
    if (process.platform === "win32" && process.env.CI) throw error;
    t.skip("local Chromium unavailable; browser acceptance remains required");
    return;
  }
  const snapshot = {
    type: "room",
    view: { layout: defaultLayout("room") },
    template: homeTemplate("room"),
    residents: [],
  };
  const desktop = await renderHomeScene(snapshot, { executablePath });
  assert.equal(desktop.readUInt32BE(16), 960);
  assert.equal(desktop.readUInt32BE(20), 640);
  snapshot.view.layout.palette = "rose";
  const mobile = await renderHomeScene(snapshot, {
    executablePath,
    viewport: "mobile",
  });
  assert.equal(mobile.readUInt32BE(16), 390);
  assert.equal(mobile.readUInt32BE(20), 520);
  assert.notDeepEqual(desktop, mobile);
});

test("in-flight results are discarded on revoke, revision changes and cancellation", async (t) => {
  for (const mode of ["revoke", "revision", "cancel"]) {
    const f = setup(t);
    const render = async () => {
      if (mode === "revoke")
        f.runtime.agent("agent-0").home.sceneView.enabled = false;
      if (mode === "revision")
        f.runtime.home.rooms.store.db
          .prepare("UPDATE home_identities SET generation=? WHERE agent_id=?")
          .run("c8b67818-ddae-4d49-a180-d3de77941b21", "agent-0");
      if (mode === "cancel") f.ctx.controller.abort();
      return Buffer.from("discarded-pixels");
    };
    await assert.rejects(
      homeSceneView(f.runtime, f.ctx, { type: "room" }, render),
    );
  }
});

test("scene image survives MCP and existing OpenAI and Antigravity input adapters", async (t) => {
  const fs = await import("node:fs");
  const { mcpResult } = await import("../src/tools/index.mjs");
  const { OpenAIBackend } = await import("../src/backends/openai.mjs");
  const { AntigravityMedia } =
    await import("../src/backends/antigravity-media.mjs");
  const f = setup(t);
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
    "base64",
  );
  const result = mcpResult(
    await homeSceneView(f.runtime, f.ctx, { type: "room" }, async () => png),
  );
  assert.equal(result.content[1].type, "image");
  const backend = new OpenAIBackend(
    { toolServers: [], vision: true },
    { id: "synthetic" },
    { root: f.root },
  );
  const messages = await backend.toolMessages(
    { id: "scene", function: { name: "room_scene_view", arguments: "{}" } },
    async () => result,
    f.ctx.controller.signal,
  );
  assert.equal(
    messages.images[1].image_url.url,
    `data:image/png;base64,${png.toString("base64")}`,
  );
  const savedId = "1b163ba1-6d94-4fb2-b5d4-11bd73264c38";
  backend.store({
    id: savedId,
    messages: [{ role: "user", content: messages.images }],
  });
  assert.equal(
    fs
      .readFileSync(backend.file(savedId), "utf8")
      .includes(png.toString("base64")),
    false,
  );
  const media = new AntigravityMedia();
  try {
    const attached = await media.fromTool(result, f.ctx.controller.signal);
    assert.equal(media.catalog().length, 1);
    assert.match(attached.content[1].text, /pixels are not yet visible/);
    f.runtime.agent("agent-0").home.sceneView.enabled = false;
    assert.equal(media.catalog().length, 0);
  } finally {
    media.close();
  }
  assert.equal(media.catalog().length, 0);
});

test("native media dedup preserves independently authorized sources", async () => {
  const { AntigravityMedia } =
    await import("../src/backends/antigravity-media.mjs");
  const { mediaLease } = await import("../src/tools/media-lease.mjs");
  const image = {
    type: "image",
    mimeType: "image/png",
    data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
  };
  for (const ordinary of [false, true]) {
    const media = new AntigravityMedia();
    let valid = true;
    try {
      media.result({ content: [image], [mediaLease]: () => false });
      media.result(
        ordinary
          ? { content: [image] }
          : { content: [image], [mediaLease]: () => valid },
      );
      assert.equal(media.catalog().length, 1);
      valid = false;
      assert.equal(media.catalog().length, ordinary ? 1 : 0);
    } finally {
      media.close();
    }
  }
});

test("hall snapshots expose bounded first and last page for dynamic rosters", () => {
  for (const count of [0, 1, 4, 7]) {
    const ids = Array.from({ length: count }, (_, i) => `synthetic-${i}`);
    const pages = Math.max(1, Math.ceil(count / 3));
    for (const page of new Set([1, pages])) {
      const v = homeScenePage("hall", ids, page);
      assert.equal(v.pages, pages);
      assert.equal(v.page, page);
      assert.deepEqual(
        v.template.objects
          .filter((o) => o.id.startsWith("door-"))
          .map((o) => o.id),
        ids.slice((page - 1) * 3, page * 3).map((id) => `door-${id}`),
      );
    }
    assert.throws(
      () => homeScenePage("hall", ids, pages + 1),
      /HOME_SCENE_INVALID/,
    );
  }
  assert.throws(() => homeScenePage("room", [], 2), /HOME_SCENE_INVALID/);
});

test("OpenAI batch retract cannot first deliver or persist stale scene text or pixels", async (t) => {
  const { OpenAIBackend } = await import("../src/backends/openai.mjs");
  const fs = await import("node:fs");
  for (const mode of ["image", "unsupported", "render-failed"]) {
    const vision = mode !== "unsupported";
    const f = setup(t);
    const view = await f.runtime.executeTool(f.ctx, "room_read", {});
    const marker = "SYNTHETIC_WITHDRAWN_SCENE_TEXT";
    await f.runtime.executeTool(f.ctx, "room_publish", {
      identityGeneration: view.identityGeneration,
      requestId: "batch-publish",
      slot: "intro",
      expectedItemRevision: 0,
      title: "合成标题",
      body: marker,
      source: "original-text",
    });
    f.runtime.config.backends.find(
      (b) => b.id === f.runtime.agent("agent-0").backendId,
    ).type = "openai";
    f.runtime.config.backends.find(
      (b) => b.id === f.runtime.agent("agent-0").backendId,
    ).vision = vision;
    let requests = 0,
      saved;
    const backend = new OpenAIBackend(
      {
        baseUrl: "https://synthetic.example.test/v1",
        model: "synthetic",
        vision,
        toolServers: [],
      },
      { id: "batch" },
      {
        root: f.root,
        fetch: async (_url, init) => {
          requests++;
          if (requests === 1)
            return new Response(
              JSON.stringify({
                choices: [
                  {
                    message: {
                      content: null,
                      tool_calls: [
                        {
                          id: "view",
                          type: "function",
                          function: {
                            name: "room_scene_view",
                            arguments: "{}",
                          },
                        },
                        {
                          id: "retract",
                          type: "function",
                          function: { name: "room_retract", arguments: "{}" },
                        },
                      ],
                    },
                  },
                ],
              }),
            );
          assert.equal(init.body.includes(marker), false);
          assert.equal(init.body.includes("image_url"), false);
          assert.equal(
            fs.readFileSync(backend.file(saved.id), "utf8").includes(marker),
            false,
          );
          return new Response(
            JSON.stringify({ choices: [{ message: { content: "完成" } }] }),
          );
        },
      },
    );
    await backend.run({
      prompt: "合成批次",
      tools: [],
      signal: f.ctx.controller.signal,
      session: null,
      saveSession: (s) => {
        saved = s;
      },
      callTool: async (name) => {
        if (name === "room_scene_view")
          return homeSceneView(f.runtime, f.ctx, { type: "room" }, async () => {
            if (mode === "render-failed")
              throw Error("SCREENSHOT_BROWSER_MISSING");
            return Buffer.from("synthetic-pixels");
          });
        return f.runtime.executeTool(f.ctx, "room_retract", {
          identityGeneration: view.identityGeneration,
          requestId: "batch-retract",
          slot: "intro",
          expectedItemRevision: 1,
        });
      },
    });
    assert.equal(requests, 2);
    assert.equal(
      fs.readFileSync(backend.file(saved.id), "utf8").includes(marker),
      false,
    );
  }
});

test(
  "stalled browser startup aborts, times out and releases its process and slots",
  { skip: process.platform === "win32" },
  async (t) => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const os = await import("node:os");
    const net = await import("node:net");
    const { randomUUID } = await import("node:crypto");
    const { execFileSync } = await import("node:child_process");
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "home-stall-test-"));
    const nonce = randomUUID(),
      records = path.join(root, "records");
    const readRecords = () =>
      fs.existsSync(records)
        ? fs
            .readFileSync(records, "utf8")
            .trim()
            .split("\n")
            .filter(Boolean)
            .map((line) => JSON.parse(line))
        : [];
    const contact = (endpoint, action = "ping") =>
      new Promise((resolve) => {
        const socket = net.connect(endpoint);
        let response = "";
        const finish = (value) => {
          socket.destroy();
          resolve(value);
        };
        socket.setTimeout(100, () => finish(false));
        socket.on("error", () => finish(false));
        socket.on("close", () => finish(false));
        socket.on("connect", () => socket.write(`${action}:${nonce}\n`));
        socket.on("data", (data) => {
          response += data;
          if (response.includes("alive")) finish(true);
        });
      });
    const assertStopped = async ({ pid, endpoint }) => {
      assert.equal(
        await contact(endpoint),
        false,
        "owned synthetic browser still executes its authenticated endpoint",
      );
      try {
        process.kill(pid, 0);
      } catch (error) {
        assert.equal(error.code, "ESRCH");
        return;
      }
      let state;
      try {
        state = execFileSync("/bin/ps", ["-p", String(pid), "-o", "stat="], {
          encoding: "utf8",
        }).trim();
      } catch (error) {
        // Reaping between pid0 and ps is also a completed stop, not a live worker.
        try {
          process.kill(pid, 0);
        } catch (gone) {
          assert.equal(gone.code, "ESRCH");
          return;
        }
        throw error;
      }
      assert.match(
        state,
        /^Z/,
        `owned synthetic browser still executing: ${state}`,
      );
      console.log(
        JSON.stringify({ cleanupEvidence: "stopped-unreaped-zombie", state }),
      );
    };
    t.after(async () => {
      for (const record of readRecords())
        await contact(record.endpoint, "stop");
      fs.rmSync(root, { recursive: true, force: true });
    });
    const executablePath = path.join(root, "synthetic-browser");
    const marker = path.join(root, "pid");
    fs.writeFileSync(
      executablePath,
      [
        "#!/usr/bin/env node",
        `const net=require('node:net'),fs=require('node:fs'),path=require('node:path');const endpoint=path.join(${JSON.stringify(root)},'f'+process.pid+'.sock');`,
        `const server=net.createServer(s=>s.once('data',d=>{const v=d.toString().trim();if(v===${JSON.stringify("stop:" + nonce)})process.exit(0);else if(v===${JSON.stringify("ping:" + nonce)})s.end('alive');else s.destroy();}));`,
        `server.listen(endpoint,()=>{const row={pid:process.pid,endpoint};fs.appendFileSync(${JSON.stringify(records)},JSON.stringify(row)+${JSON.stringify("\n")});fs.writeFileSync(${JSON.stringify(marker)},JSON.stringify(row));});`,
      ].join("\n"),
      { mode: 0o700 },
    );
    const snapshot = {
      type: "room",
      view: { layout: defaultLayout("room") },
      template: homeTemplate("room"),
      residents: [],
    };
    for (const mode of ["cancel", "timeout", "cancel"]) {
      fs.rmSync(marker, { force: true });
      const controller = new AbortController();
      const pending = renderHomeScene(snapshot, {
        executablePath,
        signal: controller.signal,
        launchTimeoutMs: mode === "timeout" ? 4000 : 5000,
      });
      let launchError;
      const rejected = assert.rejects(pending, (error) => {
        launchError = error;
        return true;
      });
      let record;
      for (let n = 0; n < 300 && !record; n++) {
        try {
          record = JSON.parse(fs.readFileSync(marker, "utf8"));
        } catch (error) {
          if (error.code !== "ENOENT" && !(error instanceof SyntaxError))
            throw error;
        }
        if (!record) await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.ok(record, launchError?.cause?.message);
      const pid = record.pid;
      assert.equal(await contact(record.endpoint), true);
      const started = Date.now();
      if (mode === "cancel") controller.abort();
      await rejected;
      assert.ok(Date.now() - started < (mode === "timeout" ? 6000 : 2000));
      for (let n = 0; n < 200; n++) {
        try {
          process.kill(pid, 0);
        } catch {
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      await assertStopped(record);
    }
    const first = new AbortController(),
      second = new AbortController();
    const one = assert.rejects(
      renderHomeScene(snapshot, { executablePath, signal: first.signal }),
    );
    const two = assert.rejects(
      renderHomeScene(snapshot, { executablePath, signal: second.signal }),
    );
    await new Promise((resolve) => setTimeout(resolve, 100));
    first.abort();
    await assert.rejects(
      renderHomeScene(snapshot, { executablePath }),
      /HOME_SCENE_BUSY/,
    );
    second.abort();
    await Promise.all([one, two]);
    for (const record of readRecords()) await assertStopped(record);
  },
);

test("directory removal failure does not exhaust confirmed-clean browser slots", async () => {
  const fs = await import("node:fs/promises");
  const original = fs.default.rm;
  const leftovers = new Set();
  fs.default.rm = async (target, options) => {
    if (String(target).includes("qq-home-browser-")) {
      leftovers.add(target);
      throw Object.assign(Error("synthetic locked directory"), {
        code: "EPERM",
      });
    }
    return original(target, options);
  };
  try {
    for (let i = 0; i < 3; i++) {
      await assert.rejects(
        renderHomeScene({}, { executablePath: process.execPath }),
        (error) => error.code === "EPERM",
      );
    }
    assert.ok(leftovers.size >= 3);
  } finally {
    fs.default.rm = original;
    for (const target of leftovers)
      await original(target, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 100,
      });
  }
});

test("shared scene decorations expose only own tagline and bind its independent revision", async (t) => {
  const { mediaLease } = await import("../src/tools/media-lease.mjs");
  const { mcpResult } = await import("../src/tools/index.mjs");
  const f = setup(t);
  const b = f.runtime.agent("agent-1");
  b.home = structuredClone(f.runtime.agent("agent-0").home);
  b.subject.enabled = true;
  const second = context(f.runtime, "agent-1", "@subject");
  const tagA = "甲角色独有门牌" + "一盏暖灯".repeat(12),
    tagB = "乙角色独有门牌";
  async function publish(ctx, body, requestId) {
    const current = await f.runtime.executeTool(ctx, "room_read", {});
    return f.runtime.executeTool(ctx, "room_publish", {
      identityGeneration: current.identityGeneration,
      requestId,
      slot: "tagline",
      expectedItemRevision: current.items.find(
        (item) => item.slot === "tagline",
      ).itemRevision,
      title: "门牌",
      body,
      source: "original-text",
    });
  }
  await publish(f.ctx, tagA, "tagline-A-first");
  await publish(second, tagB, "tagline-B-first");
  let room, hall;
  await homeSceneView(f.runtime, f.ctx, { type: "room" }, async (snapshot) => {
    room = snapshot;
    return Buffer.from("synthetic-room");
  });
  assert.equal(room.residents.length, 1);
  assert.equal(room.residents[0].tagline, tagA);
  assert.equal(JSON.stringify(room).includes(tagB), false);
  const before = await homeSceneView(
    f.runtime,
    second,
    { type: "hall" },
    async (snapshot) => {
      hall = snapshot;
      return Buffer.from("synthetic-hall");
    },
  );
  assert.equal(JSON.stringify(hall).includes(tagA), false);
  assert.equal(
    hall.residents.find((resident) => resident.id === b.id).tagline,
    tagB,
  );
  assert.equal(
    hall.residents.find((resident) => resident.id === b.id).taglineRevision,
    1,
  );
  const current = await f.runtime.executeTool(second, "room_read", {});
  await f.runtime.executeTool(second, "room_retract", {
    identityGeneration: current.identityGeneration,
    requestId: "tagline-B-retract",
    slot: "tagline",
    expectedItemRevision: 1,
  });
  await publish(second, tagB, "tagline-B-again");
  assert.equal(before[mediaLease](), false);
  const denied = mcpResult(before);
  assert.equal(denied.isError, true);
  assert.equal(JSON.stringify(denied).includes(tagB), false);
  assert.equal(
    denied.content.some((part) => part.type === "image"),
    false,
  );
});

test("MCP delivery rejects invalid observations and validator errors while ordinary media stays unchanged", () => {
  return Promise.all([
    import("../src/tools/index.mjs"),
    import("../src/tools/media-lease.mjs"),
  ]).then(([{ mcpResult }, { mediaLease }]) => {
    const ordinary = {
      content: [
        { type: "text", text: "ordinary synthetic media" },
        { type: "image", mimeType: "image/png", data: "ordinary-image" },
      ],
    };
    assert.equal(mcpResult(ordinary), ordinary);
    for (const validator of [
      () => false,
      () => {
        throw Error("SYNTHETIC_PRIVATE_VALIDATOR_DETAIL");
      },
    ]) {
      const value = {
        ...ordinary,
        content: [
          { type: "text", text: "SYNTHETIC_PRIVATE_SCENE" },
          ...ordinary.content,
        ],
        [mediaLease]: validator,
      };
      const result = mcpResult(value);
      assert.equal(result.isError, true);
      assert.equal(result.content.length, 1);
      assert.equal(result.content[0].type, "text");
      assert.match(result.content[0].text, /HOME_REVISION_CONFLICT/);
      assert.doesNotMatch(
        result.content[0].text,
        /SYNTHETIC_PRIVATE|ordinary-image/,
      );
    }
  });
});
