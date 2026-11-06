// @ts-check
import { describeHomeScene } from "./layout.mjs";
import { assertRoomItemShareable } from "../core/social-protection.mjs";

/** Saved room photos retain their own source, not the caller's chat or work.
 * @param {any} runtime @param {any} ctx @param {any} snapshot
 * @param {Buffer} buffer @param {string} capturedAt */
export function saveHomeSceneMedia(runtime, ctx, snapshot, buffer, capturedAt) {
  const a = runtime.assertActive(ctx);
  if (snapshot.type !== "room" || snapshot.view.ownerAgentId !== a.id)
    throw Error("HOME_SOURCE_DENIED");
  const resident = snapshot.residents.find(
    (/** @type {any} */ r) => r.id === a.id,
  );
  let tagline = null;
  if (
    resident?.tagline &&
    describeHomeScene(snapshot.view.layout, snapshot.template).objects.some(
      (object) => object.id === "nameplate" && !object.hidden,
    )
  ) {
    const item = snapshot.roomContent.items.find(
      (/** @type {any} */ row) => row.slot === "tagline",
    );
    if (!item?.visible || item.body !== resident.tagline)
      throw Error("HOME_SOURCE_DENIED");
    tagline = { itemId: item.itemId, itemRevision: item.itemRevision };
  }
  const homeScene = {
    version: 1,
    ownerAgentId: a.id,
    identityGeneration: snapshot.identityGeneration,
    layoutRevision: snapshot.view.layoutRevision,
    tagline,
  };
  assertHomeSceneMedia(runtime, ctx, { homeScene });
  if (!runtime.media) throw Error("MEDIA_UNAVAILABLE");
  const saved = runtime.media.put(a.id, buffer, "image/png", {
    saved: true,
    kind: "room-scene",
    title: "我的小窝",
    createdAt: capturedAt,
    homeScene,
  });
  return { mediaId: saved.id, mimeType: saved.mimeType, bytes: saved.bytes };
}

/** Current visibility protects reads; sharing additionally proves any rendered words.
 * Furniture changes do not revoke a frozen photo.
 * @param {any} runtime @param {any} ctx @param {any} meta
 * @param {{sharing?:boolean}} [options] */
export function assertHomeSceneMedia(
  runtime,
  ctx,
  meta,
  { sharing = false } = {},
) {
  if (meta?.homeScene === undefined) return;
  const source = meta.homeScene,
    a = runtime.agent(ctx.agentId);
  if (
    source?.version !== 1 ||
    source.ownerAgentId !== a.id ||
    source.identityGeneration !== runtime.home.generation(a.id) ||
    a.home?.enabled !== true ||
    a.home.sceneView?.enabled !== true
  )
    throw Error("HOME_SOURCE_DENIED");
  if (!source.tagline) return;
  const item = runtime.home.rooms.store.item(
    source.identityGeneration,
    "tagline",
  );
  if (
    !a.home.publishing ||
    !item ||
    item.state !== "published" ||
    item.item_id !== source.tagline.itemId ||
    item.revision !== source.tagline.itemRevision
  )
    throw Error("HOME_SOURCE_DENIED");
  if (sharing) {
    try {
      assertRoomItemShareable(runtime, ctx, {
        hostGeneration: source.identityGeneration,
        slot: "tagline",
        itemId: source.tagline.itemId,
        itemRevision: source.tagline.itemRevision,
      });
    } catch {
      throw Error("HOME_SOURCE_DENIED");
    }
  }
}
