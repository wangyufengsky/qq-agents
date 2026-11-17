// @ts-check
import { z } from "zod";
import { defaultWeather, weatherPool } from "./garden-weather.mjs";

export const HOUR = 3_600_000;
export const DAY = 24 * HOUR;
export const PLOT_COUNT = 9;

const count = z.number().int().min(0).max(1_000_000);
const water = z.number().min(0).max(100);
export const cropId = z.string().regex(/^[a-z][a-z0-9-]{0,39}$/);
const lightRate = z.number().min(0).max(4);
export const lightDefaults = {
  sun: { high: 1.25, medium: 1, low: 0.75 },
  neutral: { high: 1, medium: 1, low: 0.85 },
  shade: { high: 0.8, medium: 1, low: 1.15 },
};
const cropSchema = z.strictObject({
  name: z.string().trim().min(1).max(60),
  description: z.string().max(400),
  enabled: z.boolean(),
  market: z.boolean(),
  seedPrice: count,
  hours: z.number().min(0.01).max(8760),
  dailyWater: water,
  light: z.enum(["sun", "neutral", "shade"]),
  lightRates: z
    .strictObject({
      high: lightRate.optional(),
      medium: lightRate.optional(),
      low: lightRate.optional(),
    })
    .optional(),
  rainSensitive: z.boolean().optional(),
  fertilizer: count.max(20),
  salePrice: count,
  yield: count.min(1).max(100),
  floodDays: count.min(1).max(30),
});

export const gardenSettings = z
  .strictObject({
    enabled: z.boolean(),
    roles: z
      .record(z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/), z.uuid())
      .default({}),
    speed: z.number().min(0.125).max(16),
    turnLimit: count.max(100),
    delegationHours: z.number().min(1).max(168).default(24),
    initialBalance: count,
    fertilizerPrice: count,
    startingWater: water.min(1),
    watering: water.min(1),
    lowWater: water.min(1),
    dryHours: z.number().min(1).max(8760),
    dryQualityLoss: water,
    baseQuality: water,
    fertilizerBonus: water,
    fineQuality: water,
    perfectQuality: water,
    fineMultiplier: z.number().min(1).max(10),
    perfectMultiplier: z.number().min(1).max(10),
    crops: z.record(cropId, cropSchema),
    weather: weatherPool.prefault(defaultWeather),
  })
  .refine(
    (settings) =>
      settings.fineQuality < settings.perfectQuality &&
      settings.fineMultiplier <= settings.perfectMultiplier &&
      Object.values(settings.crops).some(
        (crop) =>
          crop.enabled &&
          crop.market &&
          crop.seedPrice === 0 &&
          crop.salePrice > 0,
      ) &&
      Object.values(settings.weather.entries).every((entry) =>
        entry.conditions.every(
          (condition) =>
            !("cropId" in condition) ||
            Object.hasOwn(settings.crops, condition.cropId),
        ),
      ),
  );

const initialCrops = /** @type {const} */ ([
  ["clover", "野生三叶草", 0, 24, 15, "neutral", 0, 25],
  ["radish", "樱桃小萝卜", 30, 36, 25, "neutral", 1, 85],
  ["sunflower", "向日葵", 60, 48, 30, "sun", 1, 175],
  ["mint", "薄荷盆栽", 50, 48, 35, "shade", 1, 140],
  ["strawberry", "奶油草莓", 90, 72, 40, "neutral", 2, 290],
  ["moonflower", "月光夜来香", 140, 96, 25, "shade", 2, 460],
]);

export function defaultGardenSettings() {
  return gardenSettings.parse({
    enabled: true,
    speed: 1,
    turnLimit: 2,
    initialBalance: 1000,
    fertilizerPrice: 20,
    startingWater: 75,
    watering: 35,
    lowWater: 20,
    dryHours: 48,
    dryQualityLoss: 10,
    baseQuality: 60,
    fertilizerBonus: 40,
    fineQuality: 75,
    perfectQuality: 95,
    fineMultiplier: 1.25,
    perfectMultiplier: 1.5,
    crops: Object.fromEntries(
      initialCrops.map(
        ([
          id,
          name,
          seedPrice,
          hours,
          dailyWater,
          light,
          fertilizer,
          salePrice,
        ]) => [
          id,
          {
            name,
            description: "",
            enabled: true,
            market: true,
            seedPrice,
            hours,
            dailyWater,
            light,
            rainSensitive: id === "strawberry",
            fertilizer,
            salePrice,
            yield: 1,
            floodDays: 2,
          },
        ],
      ),
    ),
  });
}

/** @typedef {ReturnType<typeof gardenSettings.parse>} Settings */
/** @typedef {Settings["crops"][string]} Crop */
/** @typedef {"ordinary" | "fine" | "perfect"} Quality */
/**
 * @typedef {{id: string, cropId: string, actorId: string, plantedAt: number,
 * settledAt: number, water: number, growth: number, dry: number, low: number,
 * floodDays?: number, floodLoss?: number, witheredReason?: "drought" | "flood", fertilizer: number, status: "growing" | "mature" | "withered", quality: Quality | null,
 * crop: Crop, rules: Omit<Settings, "crops" | "enabled" | "speed" | "turnLimit" |
 * "initialBalance" | "fertilizerPrice" | "roles" | "delegationHours" | "weather">}} Plant
 */

/** @param {Plant} plant */
export function qualityOf(plant) {
  const { crop, rules } = plant;
  const fertilizer = crop.fertilizer
    ? (rules.fertilizerBonus * plant.fertilizer) / crop.fertilizer
    : 0;
  const score = Math.min(
    100,
    Math.max(
      0,
      rules.baseQuality +
        fertilizer -
        (rules.dryQualityLoss * plant.low) / 24 -
        (plant.floodLoss ?? 0),
    ),
  );
  return score >= rules.perfectQuality
    ? "perfect"
    : score >= rules.fineQuality
      ? "fine"
      : "ordinary";
}

/** @typedef {import("./garden-weather.mjs").WeatherEntry} WeatherEntry */
const cloud = defaultWeather.entries.cloud;
const shelteredLight = /** @type {const} */ ({
  high: "medium",
  medium: "low",
  low: "low",
});

/** @param {Plant} plant @param {WeatherEntry} weather @param {boolean} sheltered */
export function moistureRate(plant, weather, sheltered) {
  return (
    ((sheltered ? 0 : weather.rain) - plant.crop.dailyWater * weather.demand) /
    24
  );
}

/** @param {Plant} original @param {number} elapsed @param {WeatherEntry} [weather] @param {boolean} [sheltered] */
export function projectPlant(
  original,
  elapsed,
  weather = cloud,
  sheltered = false,
) {
  if (original.status !== "growing" || elapsed < original.settledAt)
    return original;
  const plant = { ...original };
  const flooded = weather.kind === "storm" && !sheltered;
  if (flooded) {
    plant.water = 100;
    plant.dry = 0;
  }
  const rate = flooded ? 0 : moistureRate(plant, weather, sheltered);
  const light = sheltered ? shelteredLight[weather.light] : weather.light;
  const lightGrowth =
    plant.crop.lightRates?.[light] ?? lightDefaults[plant.crop.light][light];
  const weatherGrowth = lightGrowth * (sheltered ? 1 : weather.outdoorGrowth);
  const { lowWater, dryHours } = plant.rules;
  let remaining = (elapsed - plant.settledAt) / HOUR;
  // Exact threshold crossings keep incremental actions and lazy reads equivalent.
  while (remaining > 0 && plant.status === "growing") {
    const wet =
      plant.water > lowWater || (plant.water === lowWater && rate >= 0);
    const watered = plant.water > 0 || rate > 0;
    const growthRate = weatherGrowth * (wet ? 1 : watered ? 0.5 : 0);
    const boundary = rate > 0 || wet ? lowWater : 0;
    const untilBoundary =
      (rate > 0 && plant.water < lowWater) ||
      (rate < 0 && plant.water > boundary)
        ? (boundary - plant.water) / rate
        : Infinity;
    const untilMature = growthRate
      ? (plant.crop.hours - plant.growth) / growthRate
      : Infinity;
    const untilWithered = watered ? Infinity : dryHours - plant.dry;
    const time = Math.min(remaining, untilBoundary, untilMature, untilWithered);
    plant.growth += time * growthRate;
    if (!wet) plant.low += time;
    plant.dry = watered ? 0 : plant.dry + time;
    plant.water =
      time === untilBoundary
        ? boundary
        : Math.min(100, Math.max(0, plant.water + rate * time));
    remaining -= time;
    if (time === untilMature) {
      plant.growth = plant.crop.hours;
      plant.status = "mature";
      plant.quality = qualityOf(plant);
    } else if (time === untilWithered) {
      plant.status = "withered";
      plant.witheredReason = "drought";
    }
  }
  plant.settledAt = elapsed - remaining * HOUR;
  return plant;
}

/** @param {Plant} plant @param {WeatherEntry} weather @param {boolean} sheltered */
export function closePlantDay(plant, weather, sheltered) {
  if (plant.status !== "growing") return plant;
  const storm = !sheltered && weather.kind === "storm";
  const drizzle =
    !sheltered &&
    weather.kind === "drizzle" &&
    (plant.crop.rainSensitive ?? plant.cropId === "strawberry");
  const floodDays = storm ? (plant.floodDays ?? 0) + 1 : 0;
  const floodLoss =
    (plant.floodLoss ?? 0) + (storm || drizzle ? weather.qualityLoss : 0);
  return {
    ...plant,
    floodDays,
    floodLoss,
    ...(floodDays >= plant.crop.floodDays && {
      status: /** @type {const} */ ("withered"),
      witheredReason: /** @type {const} */ ("flood"),
    }),
  };
}
