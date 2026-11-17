// @ts-check

/** @param {import("./garden-rules.mjs").Plant} plant @param {boolean} sheltered @param {import("./garden-weather.mjs").Weather} weather */
export function floodRisk(plant, sheltered, weather) {
  if (sheltered || weather.kind !== "storm" || plant.status !== "growing")
    return null;
  return (plant.floodDays ?? 0) + 1 >= plant.crop.floodDays
    ? "critical"
    : "waterlogging";
}

/** @param {number} hours */
export function gardenHours(hours) {
  return Math.ceil(hours * 10) / 10;
}
