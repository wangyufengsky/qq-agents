// @ts-check
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
const eventKinds = ["merchant", "thief", "visitor"];
const artwork = new Set([
  "paper.webp",
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
  file === "art.js" || file === "art.css" || isGardenArtImage(file);

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
        file: `plant-${plant.cropId}-${stage}.webp`,
        layer: "plant",
      });
  }
  if (sheltered) layers.push({ file: "shelter-front.webp", layer: "roof" });
  return layers;
}

/** @param {"weather"|"event"} group @param {string} kind */
export function gardenIconFile(group, kind) {
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

/** @param {"weather"|"event"} group @param {string} kind @param {(file:string)=>string|undefined} [url] */
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
