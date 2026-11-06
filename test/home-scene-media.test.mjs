import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fixture, config, context } from "./helpers.mjs";
import { MediaStore } from "../src/tools/media.mjs";
import { mediaLease } from "../src/tools/media-lease.mjs";
import { homeTemplate } from "../src/home/layout.mjs";
import {
  saveHomeSceneMedia,
  assertHomeSceneMedia,
} from "../src/home/scene-media.mjs";

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
  "base64",
);
function setup(t) {
  const cfg = config(2);
  for (const a of cfg.agents) {
    a.subject.enabled = true;
    a.home = { enabled: true, publishing: true, sceneView: { enabled: true } };
    a.tools.push("media_list", "sticker_read");
  }
  const f = fixture(t, { cfg });
  f.runtime.media = new MediaStore(path.join(f.root, "media"));
  return { ...f, ctx: context(f.runtime) };
}
function snapshot(f) {
  const h = f.runtime.home;
  return {
    type: "room",
    view: h.read("room", f.ctx.agentId),
    template: homeTemplate("room"),
    identityGeneration: h.generation(f.ctx.agentId),
    residents: h
      .overview(f.ctx.agentId)
      .residents.filter((r) => r.id === f.ctx.agentId),
    roomContent: h.rooms.display(f.ctx.agentId),
  };
}
function save(f, value = snapshot(f)) {
  return saveHomeSceneMedia(
    f.runtime,
    f.ctx,
    value,
    png,
    new Date().toISOString(),
  );
}
async function publish(f) {
  const ctx = context(f.runtime, f.ctx.agentId, "@subject");
  const v = await f.runtime.executeTool(ctx, "room_read", {});
  await f.runtime.executeTool(ctx, "room_publish", {
    identityGeneration: v.identityGeneration,
    requestId: "publish-tagline",
    slot: "tagline",
    expectedItemRevision: v.items.find((i) => i.slot === "tagline")
      .itemRevision,
    title: "门牌",
    body: "欢迎来坐坐",
    source: "original-text",
  });
  return ctx;
}
async function retract(f, ctx) {
  const v = await f.runtime.executeTool(ctx, "room_read", {});
  return f.runtime.executeTool(ctx, "room_retract", {
    identityGeneration: v.identityGeneration,
    requestId: "retract-tagline",
    slot: "tagline",
    expectedItemRevision: v.items.find((i) => i.slot === "tagline")
      .itemRevision,
  });
}

test("room photos survive media reload and are readable and sendable in another own chat without file permission", async (t) => {
  const f = setup(t),
    image = save(f);
  f.runtime.media = new MediaStore(path.join(f.root, "media"));
  const ctx = context(f.runtime, "agent-0", "private:30000");
  const page = await f.runtime.callTool(ctx, "media_list", {
    query: "我的小窝",
  });
  assert.equal(page.items[0].mediaId, image.mediaId);
  const meta = f.runtime.media.metadata(ctx.agentId, image.mediaId);
  assert.equal(meta.title, "我的小窝");
  assert.equal(meta.conversation, undefined);
  assert.deepEqual(meta.sources, []);
  assert.equal(f.runtime.agent(ctx.agentId).files.enabled, false);
  const result = await f.runtime.callTool(ctx, "sticker_read", {
    mediaId: image.mediaId,
  });
  assert(result.content.some((c) => c.type === "image"));
  assert.equal(result[mediaLease](), true);
  assert.equal(
    (
      await f.runtime.callTool(ctx, "qq_send", {
        requestId: "photo-1",
        mediaId: image.mediaId,
      })
    ).status,
    "sent",
  );
  assert.equal(
    (
      await f.runtime.callTool(ctx, "qq_send", {
        requestId: "photo-1",
        mediaId: image.mediaId,
      })
    ).duplicate,
    true,
  );
  assert.equal(f.runtime.transports.get("qq-0").sent.length, 1);
  const other = context(f.runtime, "agent-1");
  assert.equal(
    (await f.runtime.callTool(other, "media_list", {})).items.length,
    0,
  );
  await assert.rejects(
    f.runtime.callTool(other, "sticker_read", { mediaId: image.mediaId }),
    /MEDIA_NOT_FOUND/,
  );
  assert.throws(
    () => assertHomeSceneMedia(f.runtime, other, meta),
    /HOME_SOURCE_DENIED/,
  );
  assert.throws(
    () => save(f, { ...snapshot(f), type: "hall" }),
    /HOME_SOURCE_DENIED/,
  );
});

test("current home and scene permissions and identity fence stored photos and delayed native reads", async (t) => {
  const f = setup(t),
    image = save(f),
    a = f.runtime.agent(f.ctx.agentId);
  const result = await f.runtime.callTool(f.ctx, "sticker_read", {
    mediaId: image.mediaId,
  });
  for (const permission of [a.home, a.home.sceneView]) {
    permission.enabled = false;
    assert.equal(result[mediaLease](), false);
    assert.equal(
      (await f.runtime.callTool(f.ctx, "media_list", {})).items.length,
      0,
    );
    await assert.rejects(
      f.runtime.callTool(f.ctx, "sticker_read", { mediaId: image.mediaId }),
      /RECALL_SOURCE_NOT_ALLOWED/,
    );
    await assert.rejects(
      f.runtime.callTool(f.ctx, "qq_send", {
        requestId: "disabled",
        mediaId: image.mediaId,
      }),
      /RECALL_SOURCE_NOT_ALLOWED/,
    );
    permission.enabled = true;
  }
  f.store.db
    .prepare("UPDATE home_identities SET generation=? WHERE agent_id=?")
    .run(randomUUID(), f.ctx.agentId);
  assert.equal(result[mediaLease](), false);
  assert.equal(
    (await f.runtime.callTool(f.ctx, "media_list", {})).items.length,
    0,
  );
  assert.equal(f.runtime.transports.get("qq-0").sent.length, 0);
});

test("ordinary furniture changes keep old photos; only visible rendered taglines require sharing proof", async (t) => {
  const f = setup(t),
    subject = await publish(f),
    image = save(f);
  const before = await f.runtime.executeTool(subject, "room_scene_read", {});
  await f.runtime.executeTool(subject, "room_scene_patch", {
    identityGeneration: before.identityGeneration,
    requestId: "change-palette",
    expectedLayoutRevision: before.layoutRevision,
    operations: [{ action: "palette", palette: "rose" }],
  });
  assert.equal(
    (
      await f.runtime.callTool(f.ctx, "qq_send", {
        requestId: "old-photo",
        mediaId: image.mediaId,
      })
    ).status,
    "sent",
  );
  f.store.db.prepare("DELETE FROM home_social_item_proofs").run();
  assert(
    (
      await f.runtime.callTool(f.ctx, "sticker_read", {
        mediaId: image.mediaId,
      })
    ).content.some((c) => c.type === "image"),
  );
  await assert.rejects(
    f.runtime.callTool(f.ctx, "qq_send", {
      requestId: "legacy-no-proof",
      mediaId: image.mediaId,
    }),
    /HOME_SOURCE_DENIED/,
  );
  const hidden = snapshot(f);
  hidden.view.layout.objects.nameplate = { hidden: true };
  const hiddenImage = save(f, hidden);
  assert.equal(
    f.runtime.media.metadata(f.ctx.agentId, hiddenImage.mediaId).homeScene
      .tagline,
    null,
  );
  assert.equal(
    (
      await f.runtime.callTool(f.ctx, "qq_send", {
        requestId: "hidden-nameplate",
        mediaId: hiddenImage.mediaId,
      })
    ).status,
    "sent",
  );
  await retract(f, subject);
  assert.equal(
    (
      await f.runtime.callTool(f.ctx, "sticker_read", {
        mediaId: hiddenImage.mediaId,
      })
    )[mediaLease](),
    true,
  );
});

test("tagline withdrawal revokes delayed reads and a queued photo before the gateway starts it", async (t) => {
  const f = setup(t),
    subject = await publish(f),
    image = save(f);
  const read = await f.runtime.callTool(f.ctx, "sticker_read", {
    mediaId: image.mediaId,
  });
  const transport = f.runtime.transports.get("qq-0");
  let release, entered;
  const gate = new Promise((r) => {
    release = r;
  });
  const started = new Promise((r) => {
    entered = r;
  });
  const originalSend = transport.send.bind(transport);
  transport.send = async (...args) => {
    entered();
    await gate;
    return originalSend(...args);
  };
  const first = f.runtime.callTool(context(f.runtime), "qq_send", {
    requestId: "blocking-send",
    text: "稍等片刻",
  });
  await started;
  const queuedCtx = context(f.runtime, "agent-0", "private:30000");
  const second = f.runtime.callTool(queuedCtx, "qq_send", {
    requestId: "queued-photo",
    mediaId: image.mediaId,
  });
  const rejected = assert.rejects(second, /HOME_SOURCE_DENIED/);
  assert.equal(queuedCtx.pendingDeliveries, 1);
  await retract(f, subject);
  assert.equal(read[mediaLease](), false);
  release();
  await first;
  await rejected;
  assert.equal(transport.sent.length, 1);
  assert.equal(f.store.bind(f.ctx.agentId).delivery("queued-photo"), undefined);
});

test("photo saves neither inherit caller taint nor erase existing protections for identical bytes", async (t) => {
  const f = setup(t);
  f.ctx.privateRead.add("operations:synthetic");
  const clean = save(f);
  assert(f.ctx.privateRead.has("operations:synthetic"));
  assert.equal(
    f.runtime.media.metadata(f.ctx.agentId, clean.mediaId).protectedOperations,
    false,
  );
  f.runtime.media.put(f.ctx.agentId, png, "image/png", {
    protectedOperations: true,
    sources: [
      {
        conversation: "@work:fixture",
        eventId: "source-fixture",
        type: "image",
        index: 0,
      },
    ],
  });
  save(f);
  const meta = f.runtime.media.metadata(f.ctx.agentId, clean.mediaId);
  assert.equal(meta.protectedOperations, true);
  assert.equal(meta.sources[0].eventId, "source-fixture");
  const ctx = context(f.runtime);
  assert.equal(
    (await f.runtime.callTool(ctx, "media_list", {})).items.length,
    0,
  );
  await assert.rejects(
    f.runtime.callTool(ctx, "sticker_read", { mediaId: clean.mediaId }),
    /RECALL_SOURCE_NOT_ALLOWED/,
  );
  await assert.rejects(
    f.runtime.callTool(ctx, "qq_send", {
      requestId: "protected-photo",
      mediaId: clean.mediaId,
    }),
    /RECALL_SOURCE_NOT_ALLOWED/,
  );
  assert.equal(f.runtime.transports.get("qq-0").sent.length, 0);
});

test("unknown photo deliveries remain fenced and normal media has no scene-specific lease", async (t) => {
  const f = setup(t),
    image = save(f),
    transport = f.runtime.transports.get("qq-0");
  transport.failure = "TIMEOUT";
  await assert.rejects(
    f.runtime.callTool(f.ctx, "qq_send", {
      requestId: "unknown-photo",
      mediaId: image.mediaId,
    }),
    /DELIVERY_UNKNOWN/,
  );
  transport.failure = null;
  await assert.rejects(
    f.runtime.callTool(f.ctx, "qq_send", {
      requestId: "unknown-photo",
      mediaId: image.mediaId,
    }),
    /DELIVERY_ALREADY_ATTEMPTED_UNKNOWN/,
  );
  assert.equal(transport.sent.length, 1);
  const ordinary = f.runtime.media.put(
    f.ctx.agentId,
    Buffer.concat([png, Buffer.from("other")]),
    "image/png",
  );
  assert.equal(
    (await f.runtime.callTool(f.ctx, "sticker_read", { mediaId: ordinary.id }))[
      mediaLease
    ],
    undefined,
  );
});
