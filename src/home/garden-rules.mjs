// @ts-check
import { z } from "zod";

export const HOUR = 3_600_000;
export const DAY = 24 * HOUR;
export const PLOT_COUNT = 9;

const count = z.number().int().min(0).max(1_000_000);
const water = z.number().min(0).max(100);
export const cropId = z.string().regex(/^[a-z][a-z0-9-]{0,39}$/);
const cropSchema = z.strictObject({
  name: z.string().trim().min(1).max(60),
  description: z.string().max(400),
  enabled: z.boolean(),
  market: z.boolean(),
  seedPrice: count,
  hours: z.number().min(0.01).max(8760),
  dailyWater: water,
  light: z.enum(["sun", "neutral", "shade"]),
  fertilizer: count.max(20),
  salePrice: count,
  yield: count.min(1).max(100),
  floodDays: count.min(1).max(30),
});

export const gardenSettings = z
  .strictObject({
    enabled: z.boolean(),
    speed: z.number().min(0.125).max(16),
    turnLimit: count.max(100),
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
 * witheredReason?: "drought", fertilizer: number, status: "growing" | "mature" | "withered", quality: Quality | null,
 * crop: Crop, rules: Omit<Settings, "crops" | "enabled" | "speed" | "turnLimit" |
 * "initialBalance" | "fertilizerPrice">}} Plant
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
      rules.baseQuality + fertilizer - (rules.dryQualityLoss * plant.low) / 24,
    ),
  );
  return score >= rules.perfectQuality
    ? "perfect"
    : score >= rules.fineQuality
      ? "fine"
      : "ordinary";
}

/** @param {Plant} original @param {number} elapsed */
export function projectPlant(original, elapsed) {
  if (original.status !== "growing" || elapsed <= original.settledAt)
    return original;
  const plant = { ...original };
  const demand = plant.crop.dailyWater / 24;
  const { lowWater, dryHours } = plant.rules;
  let remaining = (elapsed - plant.settledAt) / HOUR;
  // Split at moisture thresholds so refresh frequency cannot change growth.
  while (remaining > 0 && plant.status === "growing") {
    const wet =
      plant.water > lowWater || (plant.water === lowWater && demand === 0);
    const watered = plant.water > 0;
    const growthRate = wet ? 1 : watered ? 0.5 : 0;
    const boundary = wet ? lowWater : 0;
    const untilBoundary =
      demand && watered ? (plant.water - boundary) / demand : Infinity;
    const untilMature = growthRate
      ? (plant.crop.hours - plant.growth) / growthRate
      : Infinity;
    const untilWithered = watered ? Infinity : dryHours - plant.dry;
    const time = Math.min(remaining, untilBoundary, untilMature, untilWithered);
    plant.growth += time * growthRate;
    if (!wet) plant.low += time;
    if (!watered) plant.dry += time;
    plant.water =
      time === untilBoundary
        ? boundary
        : Math.max(0, plant.water - demand * time);
    remaining -= time;
    if (time === untilMature) {
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
