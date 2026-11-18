// @ts-check
import { gardenGifts } from "./gifts.js";

export { gardenGifts };

export const cropArtIds = [
  "clover",
  "radish",
  "sunflower",
  "mint",
  "strawberry",
  "moonflower",
];
const stages = ["seedling", "growing", "mature", "withered"];
const weatherKinds = ["sun", "cloud", "drizzle", "storm"];
const eventKinds = [
  "merchant",
  "thief",
  "visitor",
  "cat",
  "aphids",
  "blessing",
  "weather-flip",
  "twin",
  "sketch",
  "mystery-box",
];
const eventIcons = new Map([
  ["rain-merchant", "merchant"],
  ["sunny-market", "merchant"],
  ["clearance-oldman", "merchant"],
  ["banquet-buyer", "merchant"],
  ["fox-thief", "thief"],
  ["hedgehog-thief", "thief"],
  ["stray-cat", "cat"],
  ["aphid-squad", "aphids"],
  ["nuisance", "cat"],
  ["weather_flip", "weather-flip"],
  ["weather-blunder", "weather-flip"],
  ["twin-fruit", "twin"],
  ["harvest_bonus", "twin"],
  ["sketch-contest", "sketch"],
  ["mystery_box", "mystery-box"],
  ["mystery-seed-bag", "mystery-box"],
  ...[
    "meteor-shower",
    "morning-dew",
    "firefly-concert",
    "golden-earthworm",
  ].map((id) => /** @type {[string,string]} */ ([id, "blessing"])),
  ...[
    "sparrow-visitor",
    "wind-moonflower",
    "gardener-aid",
    "snail-express",
  ].map((id) => /** @type {[string,string]} */ ([id, "visitor"])),
]);
const artwork = new Set([
  "paper.webp",
  "plant-seedling.webp",
  "supply-fertilizer.webp",
  "gift-wrapped.webp",
  ...Object.keys(gardenGifts).map((id) => "gift-" + id + ".webp"),
  ...["normal", "low", "saturated"].map((soil) => `soil-${soil}.webp`),
  "shelter-back.webp",
  "shelter-front.webp",
  ...cropArtIds.flatMap((cropId) =>
    stages.map((stage) => `plant-${cropId}-${stage}.webp`),
  ),
  ...weatherKinds.map((kind) => `weather-${kind}.webp`),
  ...eventKinds.map((kind) => `event-${kind}.webp`),
]);

/** @param {string} file */
export const isGardenArtImage = (file) => artwork.has(file);
/** @param {string} file */
export const isGardenArtResource = (file) =>
  file === "art.js" ||
  file === "gifts.js" ||
  file === "workspace.js" ||
  file === "art.css" ||
  isGardenArtImage(file);

/** @typedef {{file:string, layer:"soil"|"rear"|"plant"|"roof"}} Layer */
/** @typedef {{cropId:string,status:string,growth:number,crop:{hours:number},water:number,rules:{lowWater:number}}} Plant */

/** @param {{plant?:Plant|null, sheltered:boolean}} plot @returns {Layer[]} */
export function gardenLayers({ plant, sheltered }) {
  const soil = !plant
    ? "normal"
    : plant.water < plant.rules.lowWater
      ? "low"
      : plant.water === 100
        ? "saturated"
        : "normal";
  /** @type {Layer[]} */
  const layers = [{ file: `soil-${soil}.webp`, layer: "soil" }];
  if (sheltered) layers.push({ file: "shelter-back.webp", layer: "rear" });
  if (plant && cropArtIds.includes(plant.cropId)) {
    const stage =
      plant.status === "growing" && plant.growth / plant.crop.hours < 0.25
        ? "seedling"
        : plant.status;
    if (stages.includes(stage))
      layers.push({
        file:
          stage === "seedling"
            ? "plant-seedling.webp"
            : `plant-${plant.cropId}-${stage}.webp`,
        layer: "plant",
      });
  }
  if (sheltered) layers.push({ file: "shelter-front.webp", layer: "roof" });
  return layers;
}

/** @param {{kind:string,id?:string,effect?:{effect?:string}|unknown}} event */
export function gardenEventArtId(event) {
  const id = event.id?.split(":").at(-1) ?? "";
  if (eventIcons.has(id)) return id;
  const variant =
    event.effect && typeof event.effect === "object" && "effect" in event.effect
      ? event.effect.effect
      : null;
  return typeof variant === "string" && eventKinds.includes(variant)
    ? variant
    : event.kind;
}

/** @param {"weather"|"event"|"gift"|"crop"|"supply"} group @param {string} kind */
export function gardenIconFile(group, kind) {
  if (group === "gift")
    return Object.hasOwn(gardenGifts, kind) ? `gift-${kind}.webp` : null;
  if (group === "crop")
    return cropArtIds.includes(kind) ? "plant-" + kind + "-mature.webp" : null;
  if (group === "supply")
    return kind === "fertilizer" ? "supply-fertilizer.webp" : null;
  if (group === "event") kind = eventIcons.get(kind) ?? kind;
  const kinds = group === "weather" ? weatherKinds : eventKinds;
  return kinds.includes(kind) ? `${group}-${kind}.webp` : null;
}

/** @param {string} file */
const browserUrl = (file) => new URL(file, import.meta.url).href;

/** @param {Layer[]} layers @param {(file:string)=>string|undefined} [url] */
export function gardenArtMarkup(layers, url = browserUrl) {
  const images = layers
    .map(({ file, layer }) => {
      const src = url(file);
      return src
        ? `<img class="garden-art-layer garden-art-${layer}" src="${src}" alt="" draggable="false">`
        : "";
    })
    .join("");
  return images
    ? `<span class="garden-art-plot" aria-hidden="true">${images}</span>`
    : "";
}

/** @param {"weather"|"event"|"gift"|"crop"|"supply"} group @param {string} kind @param {(file:string)=>string|undefined} [url] */
export function gardenIconMarkup(group, kind, url = browserUrl) {
  const file = gardenIconFile(group, kind);
  const src = file && url(file);
  return src
    ? `<img class="garden-art-icon" src="${src}" alt="" draggable="false">`
    : "";
}

/** @param {Element} root */
export function hideFailedGardenArt(root) {
  root.addEventListener(
    "error",
    (event) => {
      const img = /** @type {HTMLImageElement|null} */ (event.target);
      if (img?.matches?.(".garden-art-layer, .garden-art-icon")) img.remove();
    },
    true,
  );
}

/** @param {Plant|null|undefined} plant */
export function gardenPlotStatus(plant) {
  if (!plant) return "可播种";
  if (plant.status === "mature") return "可收成";
  if (plant.status === "withered") return "已枯萎";
  if (plant.water < plant.rules.lowWater) return "缺水";
  return plant.growth / plant.crop.hours < 0.25 ? "幼苗" : "生长中";
}

/** @param {number} amount */
export function gardenBalanceMarkup(amount) {
  const formatted = amount.toLocaleString("zh-CN");
  return `<span class="garden-coins"><span class="garden-coin-icon" aria-hidden="true">✦</span><span><small>公共金币</small><strong>${formatted}</strong></span></span>`;
}
