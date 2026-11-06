// @ts-check
import { catalog } from "../../public/home-preview/catalog.mjs";
import { createTemplate } from "../../public/home-preview/templates.mjs";
import {
  makeScene,
  validateScene,
  resolveScene,
} from "../../public/home-preview/scene.mjs";

/** @param {string} type @param {string[]} ids */
export function homeTemplate(type, ids = []) {
  return createTemplate(
    type,
    type === "hall" ? ids.length : 3,
    1,
    type === "hall" ? ids : null,
  );
}
/** @param {string} type */
export function defaultLayout(type) {
  return { ...makeScene(homeTemplate(type), type), kind: "scene-layout" };
}
/** @param {import("../../public/home-preview/scene.mjs").Scene} layout
 * @param {import("../../public/home-preview/scene.mjs").Template} template */
export function describeHomeScene(layout, template) {
  const objects = resolveScene(layout, template, catalog).map((o) => ({
      id: o.id,
      asset: o.asset,
      name: catalog[/** @type {keyof typeof catalog} */ (o.asset)].name,
      hidden: o.hidden,
    })),
    hiddenObjectCount = objects.filter((o) => o.hidden).length;
  return {
    objects,
    templateObjectCount: objects.length,
    visibleObjectCount: objects.length - hiddenObjectCount,
    hiddenObjectCount,
    customizedObjectCount: objects.filter((o) =>
      Object.hasOwn(layout.objects, o.id),
    ).length,
    notice:
      "这是模板与自定义覆盖合成后的实际物件清单；layout.objects 只保存自定义覆盖，为空仍有默认家具。customizedObjectCount 是当前模板内的自定义覆盖条目数，不含配色；隐藏状态包含父物件的影响。",
  };
}
/** @param {any} value @param {string} type @param {string[]} ids */
export function validateLayout(value, type, ids = []) {
  if (value?.kind !== "scene-layout" || value?.sceneId !== type)
    throw Error("HOME_SCENE_INVALID");
  const templates =
    type === "hall"
      ? Array.from({ length: Math.max(1, Math.ceil(ids.length / 3)) }, (_, i) =>
          createTemplate(type, ids.length, i + 1, ids),
        )
      : [homeTemplate(type)];
  for (const t of templates) {
    validateScene(value, t, catalog);
    for (const mobile of [false, true]) {
      const objects = resolveScene(value, t, catalog, mobile);
      for (const o of objects.filter((o) => !o.hidden)) {
        const a = catalog[/** @type {keyof typeof catalog} */ (o.asset)],
          ratio = mobile
            ? type === "room" && o.zone === "nook"
              ? 1.65
              : type === "hall"
                ? 1.4
                : type === "living"
                  ? 1 / 1.12
                  : 1 / 1.08
            : 1.5;
        const height = ((o.w * a.bounds[3]) / a.bounds[2]) * ratio;
        // Keep paper within the cardboard. Text navigation is outside this footprint.
        if (
          o.x - o.w / 2 < 2 ||
          o.x + o.w / 2 > 98 ||
          o.y > 97 ||
          o.y - height < 2
        )
          throw Error("HOME_LAYOUT_BOUNDS");
      }
      // Tables and attached objects may overlap; other furniture must not replace each other.
      const furniture = objects.filter(
        (o) =>
          !o.hidden &&
          (["door", "desk", "shelf", "bed", "sofa", "table"].includes(o.id) ||
            o.id.startsWith("door-")),
      );
      for (let i = 0; i < furniture.length; i++)
        for (const b of furniture.slice(i + 1)) {
          const a = furniture[i];
          if ([a.asset, b.asset].includes("coffee-table")) continue;
          if (mobile && (type === "hall" || a.zone !== b.zone)) continue;
          const overlap =
            Math.min(a.x + a.w / 2, b.x + b.w / 2) -
            Math.max(a.x - a.w / 2, b.x - b.w / 2);
          if (overlap > Math.min(a.w, b.w) * 0.35)
            throw Error("HOME_LAYOUT_OVERLAP");
        }
    }
  }
  return structuredClone(value);
}
