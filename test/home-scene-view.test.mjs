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
  } catch {
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
