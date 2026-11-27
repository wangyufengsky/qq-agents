// @ts-check

export const gardenGrowthStages = /** @type {const} */ ([
  { ratio: 0.15, type: "sprouted", label: "发芽" },
  { ratio: 0.7, type: "developed", label: "长出新叶" },
  { ratio: 1, type: "mature", label: "成熟" },
]);

const flowerStages = ["发芽", "现蕾", "开花"];
const cropStages = /** @type {Record<string, string[]>} */ ({
  sunflower: flowerStages,
  moonflower: flowerStages,
  radish: ["发芽", "膨根", "可收成"],
  strawberry: ["发芽", "结果", "可收成"],
  catnip: flowerStages,
  mistbell: flowerStages,
  hydrangea: flowerStages,
  chamomile: flowerStages,
  tomato: ["发芽", "结果", "可收成"],
  sunberry: ["发芽", "结果", "可收成"],
  succulent: ["扎根", "饱满", "晶莹"],
  four_leaf_clover: ["发芽", "展叶", "可收成"],
  "morning-glory": flowerStages,
  "rattle-pea": ["发芽", "结荚", "豌豆荚成熟"],
  balsam: ["发芽", "现蕾", "弹籽荚成熟"],
  "lambs-ear": ["发芽", "展叶", "绒叶长成"],
  perilla: ["发芽", "舒叶", "叶片可采"],
  "sweet-corn": ["发芽", "抽穗", "玉米可收"],
  "pocket-pumpkin": ["发芽", "坐果", "南瓜可收"],
  "drift-gourd": ["发芽", "爬藤", "葫芦可收"],
  "paper-moon": flowerStages,
  "echo-tuberose": flowerStages,
});

/** @param {{status:string,growth:number,crop:{hours:number}}|null|undefined} plant */
export function gardenStageAt(plant) {
  if (!plant) return "empty";
  if (plant.status === "withered" || plant.status === "mature")
    return plant.status;
  return (
    gardenGrowthStages.findLast(
      ({ ratio }) => plant.growth >= plant.crop.hours * ratio,
    )?.type ?? "planted"
  );
}

/** @param {string} cropId @param {string} type */
export function gardenStageLabel(cropId, type) {
  if (type === "empty") return "空地";
  if (type === "planted") return "已播种";
  if (type === "withered") return "已枯萎";
  const index = gardenGrowthStages.findIndex((stage) => stage.type === type);
  return index < 0
    ? undefined
    : (cropStages[cropId]?.[index] ?? gardenGrowthStages[index].label);
}

/** @param {ReturnType<typeof gardenStageAt>} type */
export function gardenMachineStage(type) {
  if (type === "planted") return "seedling";
  if (type === "sprouted" || type === "developed") return "growing";
  return type;
}
