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
