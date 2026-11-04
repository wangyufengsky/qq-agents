// @ts-check
import { catalogVersion } from "./catalog.mjs";

/** @typedef {{x:number,y:number,w:number}} Anchor */
/** @typedef {{id:string,asset:string,anchorId:string,parentId:string|null,base:Anchor,phone:Anchor|null,z:number,zone:string,variants:string[]}} Instance */
/** @typedef {{templateId:string,boardAssetId:string,objects:Instance[],allInstanceIds?:string[],hotspots:Record<string,string>}} Template */
/** @typedef {{asset?:string,assetVersion?:number,dx?:number,dy?:number,scale?:number,z?:number,hidden?:boolean,flip?:boolean}} Override */
/** @typedef {{schemaVersion:number,kind:string,sceneId:string,templateId:string,assetCatalogVersion:string,palette:string,objects:Record<string,Override>}} Scene */
/** @typedef {Record<string,{assetVersion:number}>} Catalog */
/** @typedef {Instance & {x:number,y:number,w:number,hidden:boolean,flip:boolean}} Resolved */

/** @param {Template} template @param {string} sceneId @returns {Scene} */
export function makeScene(template, sceneId) {
  return {
    schemaVersion: 1,
    kind: "scene-preview-only",
    sceneId,
    templateId: template.templateId,
    assetCatalogVersion: catalogVersion,
    palette: "cream",
    objects: {},
  };
}

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function record(value) {
  return (
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    [Object.prototype, null].includes(Object.getPrototypeOf(value))
  );
}
/** @param {Record<string,unknown>} value @param {string[]} keys */
function onlyKeys(value, keys) {
  return Object.keys(value).every((key) => keys.includes(key));
}
/** @returns {never} */
function invalid() {
  throw Error("HOME_SCENE_INVALID");
}

/**
 * Preview layouts are deliberately bounded; this is not a room write permission check.
 * Template anchors and semantic actions cannot be replaced by stored preferences.
 * @param {unknown} value @param {Template} template @param {Catalog} catalog
 * @returns {Scene}
 */
export function validateScene(value, template, catalog) {
  if (
    !record(value) ||
    !onlyKeys(value, [
      "schemaVersion",
      "kind",
      "sceneId",
      "templateId",
      "assetCatalogVersion",
      "palette",
      "objects",
    ]) ||
    value.schemaVersion !== 1 ||
    !["scene-preview-only", "scene-layout"].includes(String(value.kind)) ||
    typeof value.sceneId !== "string" ||
    !(value.kind === "scene-layout"
      ? /^(living|hall|room)$/.test(value.sceneId)
      : /^(living|hall|room-[1-8])$/.test(value.sceneId)) ||
    value.templateId !== template.templateId ||
    value.templateId !==
      `paperbook-${value.sceneId.startsWith("room-") ? "room" : value.sceneId}-v1` ||
    value.assetCatalogVersion !== catalogVersion ||
    typeof value.palette !== "string" ||
    !["cream", "blue", "rose"].includes(value.palette) ||
    !record(value.objects)
  )
    return invalid();
  // Hall pages share one preference map, but unknown instances are never accepted.
  const validIds =
    template.allInstanceIds ||
    (template.templateId === "paperbook-hall-v1"
      ? [
          "plant",
          ...Array.from({ length: 7 }, (_, i) => [
            `door-${i + 1}`,
            `sign-${i + 1}`,
          ]).flat(),
        ]
      : template.objects.map((o) => o.id));
  for (const [id, p] of Object.entries(value.objects)) {
    if (
      !validIds.includes(id) ||
      !record(p) ||
      !onlyKeys(p, [
        "asset",
        "assetVersion",
        "dx",
        "dy",
        "scale",
        "z",
        "hidden",
        "flip",
      ])
    )
      return invalid();
    const o = template.objects.find((item) => item.id === id);
    const baseAsset =
      o?.asset ||
      (id.startsWith("door-")
        ? "door"
        : id.startsWith("sign-")
          ? "nameplate"
          : "plant");
    const variants =
      o?.variants ||
      (baseAsset === "plant" ? ["plant", "plant-tall"] : [baseAsset]);
    if (
      p.asset !== undefined &&
      (typeof p.asset !== "string" || !variants.includes(p.asset))
    )
      return invalid();
    const asset = catalog[String(p.asset || baseAsset)];
    if (
      !asset ||
      (p.assetVersion !== undefined && p.assetVersion !== asset.assetVersion)
    )
      return invalid();
    for (const [key, min, max] of /** @type {[string,number,number][]} */ ([
      ["dx", -6, 6],
      ["dy", -5, 5],
      ["scale", 0.8, 1.15],
      ["z", 1, 8],
    ])) {
      if (
        p[key] !== undefined &&
        (typeof p[key] !== "number" ||
          !Number.isFinite(p[key]) ||
          p[key] < min ||
          p[key] > max)
      )
        return invalid();
    }
    if (p.z !== undefined && !Number.isInteger(p.z)) return invalid();
    for (const key of ["hidden", "flip"])
      if (p[key] !== undefined && typeof p[key] !== "boolean") return invalid();
  }
  return /** @type {Scene} */ (value);
}

/** @param {Scene} scene @param {Template} template @param {Catalog} catalog @param {boolean} mobile @returns {Resolved[]} */
export function resolveScene(scene, template, catalog, mobile = false) {
  validateScene(scene, template, catalog);
  const byId = new Map(template.objects.map((o) => [o.id, o]));
  if (byId.size !== template.objects.length) return invalid();
  /** @type {Map<string, Resolved>} */
  const cache = new Map();
  const visiting = new Set();
  /** @param {Instance} o @returns {Resolved} */
  function resolve(o) {
    const known = cache.get(o.id);
    if (known) return known;
    if (visiting.has(o.id)) return invalid();
    visiting.add(o.id);
    const p = scene.objects[o.id] || {},
      base = mobile ? o.phone || o.base : o.base;
    let asset = p.asset || o.asset;
    if (["bed", "rug"].includes(asset) && catalog[`${asset}-${scene.palette}`])
      asset = `${asset}-${scene.palette}`;
    const v = {
      ...o,
      asset,
      x: base.x + (p.dx || 0),
      y: base.y + (p.dy || 0),
      w: base.w * (p.scale || 1),
      z: p.z ?? o.z,
      hidden: p.hidden === true,
      flip: p.flip === true,
    };
    if (o.parentId) {
      const parent = byId.get(o.parentId);
      if (!parent) return invalid();
      const pv = resolve(parent),
        pb = mobile ? parent.phone || parent.base : parent.base;
      const scale = pv.w / pb.w;
      v.x = pv.x + (base.x - pb.x) * scale * (pv.flip ? -1 : 1) + (p.dx || 0);
      v.y = pv.y + (base.y - pb.y) * scale + (p.dy || 0);
      v.w *= scale;
      v.hidden ||= pv.hidden;
      v.flip = v.flip !== pv.flip;
      v.z = Math.max(v.z, pv.z + 1);
    }
    visiting.delete(o.id);
    cache.set(o.id, v);
    return v;
  }
  return template.objects.map(resolve);
}
