// @ts-check
import { createHash } from "node:crypto";
import { z } from "zod";
import {
  defaultEvents,
  eventPoolStructure,
  gardenEventCapacity,
  validEventReferences,
} from "./garden-event-rules.mjs";
import { giftBudgetLimits } from "./garden-items.mjs";
import {
  defaultWeather,
  gardenCropId,
  weatherPool,
} from "./garden-weather.mjs";

export const HOUR = 3_600_000;
export const DAY = 24 * HOUR;
export const PLOT_COUNT = 9;

const count = z.number().int().min(0).max(1_000_000);
const water = z.number().min(0).max(100);
export const cropId = gardenCropId;
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
  maxHarvests: count.min(1).max(100).optional(),
  fertilizer: count.max(20),
  salePrice: count,
  yield: count.min(1).max(100),
  floodDays: count.min(1).max(30),
});

export const careMode = z.enum(["classic", "gentle"]);
export const careScope = z.enum(["future", "growing"]);

const gardenSettingsStructure = z
  .strictObject({
    enabled: z.boolean(),
    roles: z
      .record(z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/), z.uuid())
      .default({}),
    speed: z.number().min(0.125).max(16),
    turnLimit: count.max(100),
    giftBudgets: giftBudgetLimits.default(() => ({ total: 0, roles: {} })),
    giftBudgetGenerations: z.record(z.string(), z.uuid()).default({}),
    delegationHours: z.number().min(1).max(168).default(24),
    initialBalance: count,
    fertilizerPrice: count,
    startingWater: water.min(1),
    watering: water.min(1),
    lowWater: water.min(1),
    careMode: careMode.default("gentle"),
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
    events: eventPoolStructure.prefault(defaultEvents),
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
  )
  .refine(validEventReferences);

/** A full custom pool can grow during an edition upgrade. Keep every saved entry editable.
 * @param {number} existingCount */
export const gardenSettingsForPool = (existingCount) =>
  gardenSettingsStructure.refine(
    ({ events }) =>
      Object.keys(events.entries).length <=
      Math.max(gardenEventCapacity, existingCount),
  );
export const gardenSettings = gardenSettingsForPool(0);

const initialCrops = /** @type {const} */ ([
  ["clover", "野生三叶草", 0, 24, 15, "neutral", 0, 25],
  ["radish", "樱桃小萝卜", 30, 36, 25, "neutral", 1, 85],
  ["sunflower", "向日葵", 60, 48, 30, "sun", 1, 175],
  ["mint", "薄荷盆栽", 50, 48, 35, "shade", 1, 140],
  ["strawberry", "奶油草莓", 90, 72, 40, "neutral", 2, 290],
  ["moonflower", "月光夜来香", 140, 96, 25, "shade", 2, 460],
]);

export const CATNIP = "catnip";
export const MISTBELL = "mistbell";
export const SUNBERRY = "sunberry";
export const FOUR_LEAF_CLOVER = "four_leaf_clover";
export const CHAMOMILE = "chamomile";
export const MORNING_GLORY = "morning-glory";
export const RATTLE_PEA = "rattle-pea";
export const BALSAM = "balsam";
export const LAMBS_EAR = "lambs-ear";
const hydrangea = "hydrangea";

const expandedCrops = /** @type {const} */ ([
  [
    "perilla",
    "晚霞紫苏",
    "叶正面有醒目的叶脉，翻过来能看见晚霞般的色印。",
    true,
    62,
    44,
    24,
    "shade",
    1,
    155,
  ],
  [
    "sweet-corn",
    "奶油甜玉米",
    "一株先后长两穗。嫩穗可烤来分享，第二穗可在成熟后留 12 花园小时，干熟后做沙锤。",
    true,
    80,
    48,
    32,
    "sun",
    1,
    155,
  ],
  [
    "pocket-pumpkin",
    "口袋南瓜",
    "嫩瓜可以直接摘。成熟后再留 24 花园小时，硬皮可以刻灯。",
    true,
    72,
    50,
    26,
    "sun",
    1,
    205,
  ],
  [
    MORNING_GLORY,
    "早安牵牛",
    "清晨舒展花瓣，过了正午便把花瓣卷起。",
    true,
    45,
    30,
    20,
    "sun",
    1,
    105,
  ],
  [
    RATTLE_PEA,
    "响铃豌豆",
    "熟荚轻晃有响声，每一下嗒声都对应荚里的一粒豆子。",
    true,
    55,
    42,
    25,
    "neutral",
    1,
    55,
  ],
  [
    BALSAM,
    "跳跳凤仙",
    "采花可直接收获。也可以先轻碰熟荚，为公共仓库留下一袋种子。",
    true,
    65,
    44,
    25,
    "neutral",
    1,
    145,
  ],
  [
    LAMBS_EAR,
    "绒耳草",
    "露天的细雨会挂成一排银珠，完整的绒叶适合压制书签。",
    true,
    50,
    48,
    18,
    "shade",
    1,
    120,
  ],
  [
    hydrangea,
    "蓝雨绣球",
    "露天细雨滋养花朵，花色随生长期的天气变化。",
    true,
    75,
    60,
    35,
    "shade",
    1,
    225,
  ],
  [
    "tomato",
    "小灯笼番茄",
    "前两次收获后会继续结果，一株可收三茬。",
    true,
    80,
    48,
    32,
    "sun",
    1,
    120,
  ],
  [
    "succulent",
    "玻璃糖多肉",
    "十分耐旱，细雨天适合放在遮雨棚下。",
    true,
    55,
    72,
    8,
    "sun",
    0,
    160,
  ],
  [
    CHAMOMILE,
    "晚风洋甘菊",
    "成熟后留在地里，能替上下左右的邻株挡蚜虫、减轻晴天耗水。",
    true,
    70,
    48,
    22,
    "neutral",
    1,
    185,
  ],
  [
    SUNBERRY,
    "蜜糖太阳莓",
    "果实像是把阳光酿进了蜜糖。",
    false,
    0,
    72,
    30,
    "sun",
    2,
    420,
  ],
  [
    FOUR_LEAF_CLOVER,
    "四叶幸运草",
    "格外少见的四叶草收成。",
    false,
    0,
    24,
    15,
    "neutral",
    0,
    260,
  ],
]);

/**
 * @param {Pick<Plant,"id">} plant
 * @returns {number} One stable pod count shared by care views, guesses and harvest.
 */
export function rattlePeaCount(plant) {
  return (
    2 +
    (createHash("sha256").update(`pea:${plant.id}`).digest().readUInt32BE() % 4)
  );
}

/** @param {Pick<Plant,"id">} plant */
export function lambsEarLeafShape(plant) {
  const shapes = ["圆尖绒叶", "狭长绒叶", "宽圆绒叶"];
  return shapes[
    createHash("sha256").update(`leaf:${plant.id}`).digest().readUInt32BE() %
      shapes.length
  ];
}

export const perillaVariants = {
  "leaf-veins": "正面叶脉拓",
  "sunset-print": "背面晚霞印",
};

/** @param {Pick<Plant,"id">} plant */
export function perillaLeafPrint(plant) {
  const code = createHash("sha256").update(`perilla:${plant.id}`).digest()[0];
  return {
    leafFront: ["羽状叶脉", "叉状细脉", "梳状长脉"][code % 3],
    leafBack: ["暮紫色印", "玫霞色印", "霞橙色印"][Math.floor(code / 3) % 3],
  };
}

/** @typedef {{harvestStage?:"tender"|"dry"|"hard",ear?:number,leafFront?:string,leafBack?:string}} HarvestMeta */
/** @param {Pick<Plant,"id"|"cropId"|"status"|"maturedAt"|"harvestCount">} plant @param {number} clock @returns {HarvestMeta} */
export function gardenHarvestMeta(plant, clock) {
  if (plant.cropId === "perilla") return perillaLeafPrint(plant);
  if (plant.status !== "mature") return {};
  const elapsed = plant.maturedAt === undefined ? 0 : clock - plant.maturedAt;
  if (plant.cropId === "sweet-corn") {
    const ear = (plant.harvestCount ?? 0) + 1;
    return {
      ear,
      harvestStage: ear === 2 && elapsed >= 12 * HOUR ? "dry" : "tender",
    };
  }
  if (plant.cropId === "pocket-pumpkin")
    return { harvestStage: elapsed >= DAY ? "hard" : "tender" };
  return {};
}

/** @param {Pick<Plant,"id"|"cropId"|"status"|"podPopped"|"maturedAt"|"harvestCount">} plant @param {number} clock
 * @param {import("./garden-weather.mjs").Weather["kind"]} weather @param {boolean} sheltered */
export function explorerPlantView(plant, clock, weather, sheltered) {
  if (plant.status === "withered") return undefined;
  if (plant.cropId === MORNING_GLORY && plant.status === "mature") {
    const hour = (clock % DAY) / HOUR;
    const bloom = hour >= 6 && hour < 12 ? "open" : "rolled";
    return { bloom, text: bloom === "open" ? "清晨花瓣舒展" : "花瓣轻轻卷起" };
  }
  if (plant.cropId === RATTLE_PEA && plant.status === "mature") {
    const rattles = Array.from({ length: rattlePeaCount(plant) }, () => "嗒");
    return { rattles, text: `轻晃豆荚，${rattles.join("、")}。` };
  }
  if (plant.cropId === BALSAM && plant.status === "mature")
    return plant.podPopped
      ? { canPop: false, text: "果荚已弹过籽" }
      : { canPop: true, text: "成熟果荚碰碰就会弹籽" };
  if (plant.cropId === LAMBS_EAR) {
    const leafShape = lambsEarLeafShape(plant);
    const silverBeads = !sheltered && weather === "drizzle";
    return {
      leafShape,
      silverBeads,
      text: silverBeads ? "绒叶挂着细雨银珠" : leafShape,
    };
  }
  if (plant.cropId === "perilla") {
    const { leafFront, leafBack } = perillaLeafPrint(plant);
    return {
      leafFront,
      leafBack,
      text: `正面是${leafFront}，背面是${leafBack}`,
    };
  }
  if (plant.cropId === "sweet-corn") {
    const ear = (plant.harvestCount ?? 0) + 1;
    const { harvestStage } = gardenHarvestMeta(plant, clock);
    return {
      ear,
      harvestStage,
      text:
        harvestStage === "dry"
          ? "第二穗已经干熟，可以做沙锤"
          : harvestStage === "tender"
            ? ear === 2
              ? "第二穗正嫩，可收下烤食，也可再留一会儿等它干熟"
              : "第一穗正嫩，可以摘下烤食"
            : ear === 2
              ? "第二穗正在长"
              : "第一穗正在长",
    };
  }
  if (plant.cropId === "pocket-pumpkin") {
    const { harvestStage } = gardenHarvestMeta(plant, clock);
    return {
      harvestStage,
      text:
        harvestStage === "hard"
          ? "瓜皮已经变硬，可以刻灯"
          : harvestStage === "tender"
            ? "嫩瓜可以摘，也可以留着养成适合刻灯的硬皮瓜"
            : "小瓜正在长",
    };
  }
  return undefined;
}

/** @param {string} id @param {Crop} crop */
export function gardenCropTraits(id, crop) {
  return [
    { sun: "喜阳", neutral: "光照适应性中等", shade: "喜阴" }[crop.light],
    ...((crop.rainSensitive ?? id === "strawberry") ? ["怕细雨"] : []),
    ...((crop.maxHarvests ?? 1) > 1 ? [`多茬采收(${crop.maxHarvests}次)`] : []),
    ...(id === hydrangea ? ["雨晴变色", "细雨滋养"] : []),
    ...(id === CHAMOMILE ? ["邻株护卫"] : []),
    ...(id === "succulent" ? ["耐旱"] : []),
    ...(id === MORNING_GLORY ? ["清晨开花"] : []),
    ...(id === RATTLE_PEA ? ["熟荚有响声"] : []),
    ...(id === BALSAM ? ["果荚弹籽"] : []),
    ...(id === LAMBS_EAR ? ["雨珠绒叶"] : []),
    ...(id === "perilla" ? ["双面叶拓"] : []),
    ...(id === "sweet-corn" ? ["第二穗可留至干熟"] : []),
    ...(id === "pocket-pumpkin" ? ["可留至硬皮"] : []),
  ];
}

/** @param {number} a @param {number} b */
export function adjacentPlots(a, b) {
  return (
    Math.abs(Math.floor((a - 1) / 3) - Math.floor((b - 1) / 3)) +
      Math.abs(((a - 1) % 3) - ((b - 1) % 3)) ===
    1
  );
}

/** @param {{plots:import("./garden-service.mjs").Plot[]}} state @param {number} plot */
export function neighborBuffs(state, plot) {
  return state.plots.some(
    ({ id, plant }) =>
      adjacentPlots(id, plot) &&
      plant?.cropId === CHAMOMILE &&
      plant.status === "mature",
  )
    ? ["洋甘菊护卫"]
    : [];
}

export const gardenVariants = /** @type {const} */ ({
  rain_blue: "雨蓝绣球",
  sun_pink: "晴粉绣球",
  mist_lilac: "雾紫绣球",
});

/** @param {Plant} plant */
export function gardenVariantDetail(plant) {
  return plant.variant
    ? { variant: plant.variant, variantName: gardenVariants[plant.variant] }
    : {};
}

/** @param {Plant} plant @param {string} seed */
export function harvestCropId(plant, seed) {
  if (
    plant.cropId !== "clover" ||
    !(plant.quality === "perfect" || plant.blessed)
  )
    return plant.cropId;
  const roll = createHash("sha256")
    .update(JSON.stringify([seed, plant.id, FOUR_LEAF_CLOVER]))
    .digest()
    .readUInt32BE();
  return roll < 0x100000000 / 5 ? FOUR_LEAF_CLOVER : plant.cropId;
}

/** @type {Record<string, Crop>} */
const neighborCrops = {
  [CATNIP]: {
    name: "猫薄荷",
    description: "傍晚有时引来小蝴蝶。",
    enabled: true,
    market: true,
    seedPrice: 65,
    hours: 48,
    dailyWater: 28,
    light: "neutral",
    fertilizer: 1,
    salePrice: 195,
    yield: 1,
    floodDays: 2,
  },
  [MISTBELL]: {
    name: "星雾铃",
    description: "月光下开出蓝紫色的花，种子来自邻株发现。",
    enabled: true,
    market: false,
    seedPrice: 0,
    hours: 72,
    dailyWater: 30,
    light: "shade",
    fertilizer: 2,
    salePrice: 390,
    yield: 1,
    floodDays: 2,
  },
};

/** @param {Settings["crops"]} crops */
export function withExpandedCrops(crops) {
  const result = { ...crops };
  for (const [id, crop] of Object.entries(neighborCrops)) {
    if (!Object.hasOwn(result, id)) result[id] = { ...crop };
  }
  for (const [
    id,
    name,
    description,
    market,
    seedPrice,
    hours,
    dailyWater,
    light,
    fertilizer,
    salePrice,
  ] of expandedCrops) {
    if (Object.hasOwn(result, id)) continue;
    result[id] = {
      name,
      description,
      enabled: true,
      market,
      seedPrice,
      hours,
      dailyWater,
      light,
      fertilizer,
      salePrice,
      yield: 1,
      floodDays: 2,
      ...(id === "tomato" && { maxHarvests: 3 }),
      ...(id === "sweet-corn" && { maxHarvests: 2 }),
      ...(id === "succulent" && { rainSensitive: true }),
    };
  }
  return result;
}

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
    crops: withExpandedCrops(
      Object.fromEntries(
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
    ),
  });
}

/** @param {Settings} settings */
export function gardenPlantRules(settings) {
  const {
    crops: _crops,
    roles: _roles,
    weather: _weather,
    events: _events,
    giftBudgets: _giftBudgets,
    giftBudgetGenerations: _giftBudgetGenerations,
    delegationHours: _delegationHours,
    enabled: _enabled,
    speed: _speed,
    turnLimit: _turnLimit,
    initialBalance: _initialBalance,
    fertilizerPrice: _price,
    ...rules
  } = settings;
  return rules;
}

/** @typedef {ReturnType<typeof gardenSettings.parse>} Settings */
/** @typedef {Settings["crops"][string]} Crop */
/** @typedef {"ordinary" | "fine" | "perfect"} Quality */
/**
 * @typedef {{id: string, cropId: string, actorId: string, plantedAt: number, sownClock?: number,
 * settledAt: number, maturedAt?: number, harvestCount?: number, blessed?: boolean, podPopped?: boolean, fullMoonDay?: number,
 * variant?: keyof typeof gardenVariants, variantName?: string, rainHours?: number, sunHours?: number, weatherHours?: number,
 * drizzleBonusDay?: number, water: number, growth: number, dry: number, low: number,
 * floodDays?: number, floodLoss?: number, qualityAdjustment?: number, earthwormDay?: number, witheredReason?: "drought" | "flood", fertilizer: number, status: "growing" | "mature" | "withered", quality: Quality | null,
 * crop: Crop, rules: Omit<ReturnType<typeof gardenPlantRules>, "careMode"> & {careMode?: Settings["careMode"]}}} Plant
 */

/** @param {Plant} plant */
function rawQualityScore(plant) {
  const { crop, rules } = plant;
  const fertilizer = crop.fertilizer
    ? (rules.fertilizerBonus * plant.fertilizer) / crop.fertilizer
    : 0;
  return (
    rules.baseQuality +
    fertilizer -
    (rules.dryQualityLoss * plant.low) / 24 -
    (plant.floodLoss ?? 0) +
    (plant.qualityAdjustment ?? 0)
  );
}

/** @param {number} value */
function clampScore(value) {
  return Math.min(100, Math.max(0, value));
}

/** @param {Plant} plant @param {number} amount */
export function adjustPlantQuality(plant, amount) {
  if (!amount) return 0;
  const raw = rawQualityScore(plant);
  const before = clampScore(raw);
  const after = clampScore(before + amount);
  plant.qualityAdjustment = (plant.qualityAdjustment ?? 0) + after - raw;
  return after - before;
}

/** @param {Plant} plant */
export function qualityOf(plant) {
  const { rules } = plant;
  const score = clampScore(rawQualityScore(plant));
  return score >= rules.perfectQuality
    ? "perfect"
    : score >= rules.fineQuality
      ? "fine"
      : "ordinary";
}

/** @param {Plant} plant @param {number} clock */
function maturePlant(plant, clock) {
  plant.status = "mature";
  plant.maturedAt = clock;
  plant.quality = qualityOf(plant);
  if (plant.cropId !== hydrangea) return;
  const rain = plant.rainHours ?? 0;
  const sun = plant.sunHours ?? 0;
  const total = plant.weatherHours ?? rain + sun;
  plant.variant =
    total > 0 && rain / total >= 0.55
      ? "rain_blue"
      : total > 0 && sun / total >= 0.55
        ? "sun_pink"
        : "mist_lilac";
  plant.variantName = gardenVariants[plant.variant];
}

/** @param {Plant} plant @param {WeatherEntry} weather @param {boolean} sheltered @param {number} clock @param {number} hours */
function trackHydrangeaWeather(plant, weather, sheltered, clock, hours) {
  if (plant.cropId !== hydrangea || hours <= 0) return;
  const rain =
    !sheltered && (weather.kind === "drizzle" || weather.kind === "storm");
  const day = Math.floor(clock / DAY) + 1;
  plant.weatherHours =
    (plant.weatherHours ?? (plant.rainHours ?? 0) + (plant.sunHours ?? 0)) +
    hours;
  if (rain) plant.rainHours = (plant.rainHours ?? 0) + hours;
  if (weather.kind === "sun") plant.sunHours = (plant.sunHours ?? 0) + hours;
  if (rain && weather.kind === "drizzle" && plant.drizzleBonusDay !== day) {
    adjustPlantQuality(plant, 5);
    plant.drizzleBonusDay = day;
  }
}

/** @param {Plant} plant @param {number} hours */
export function grantGrowth(plant, hours) {
  const before = plant.growth;
  plant.growth = Math.min(plant.crop.hours, before + hours);
  if (plant.growth === plant.crop.hours) maturePlant(plant, plant.settledAt);
  return plant.growth - before;
}

/** @typedef {import("./garden-weather.mjs").WeatherEntry} WeatherEntry */
const cloud = defaultWeather.entries.cloud;
const shelteredLight = /** @type {const} */ ({
  high: "medium",
  medium: "low",
  low: "low",
});

/** @param {Plant} plant @param {WeatherEntry} weather @param {boolean} sheltered @param {boolean} [guarded] */
export function moistureRate(plant, weather, sheltered, guarded = false) {
  const demand =
    guarded && weather.kind === "sun" ? weather.demand * 0.85 : weather.demand;
  return ((sheltered ? 0 : weather.rain) - plant.crop.dailyWater * demand) / 24;
}

/** @param {Plant} original @param {number} elapsed @param {WeatherEntry} [weather] @param {boolean} [sheltered] @param {number} [growthMultiplier] @param {(before:number,after:number,clock:number,clockPerGrowth:number,plant:Plant)=>void} [onGrowth] @param {boolean} [guarded] */
export function projectPlant(
  original,
  elapsed,
  weather = cloud,
  sheltered = false,
  growthMultiplier = 1,
  onGrowth,
  guarded = false,
) {
  if (original.status !== "growing" || elapsed < original.settledAt)
    return original;
  const plant = { ...original };
  const flooded = weather.kind === "storm" && !sheltered;
  if (flooded) {
    plant.water = 100;
    plant.dry = 0;
  }
  const rate = flooded ? 0 : moistureRate(plant, weather, sheltered, guarded);
  const light = sheltered ? shelteredLight[weather.light] : weather.light;
  const lightGrowth =
    plant.crop.lightRates?.[light] ?? lightDefaults[plant.crop.light][light];
  const { lowWater, dryHours } = plant.rules;
  const gentle = plant.rules.careMode === "gentle";
  const outdoorGrowth = flooded && gentle ? 0 : weather.outdoorGrowth;
  const weatherGrowth =
    lightGrowth *
    (sheltered ? 1 : outdoorGrowth) *
    (guarded ? (1 + growthMultiplier) / 2 : growthMultiplier);
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
    const untilWithered = watered || gentle ? Infinity : dryHours - plant.dry;
    const time = Math.min(remaining, untilBoundary, untilMature, untilWithered);
    const before = plant.growth;
    const clock = elapsed - remaining * HOUR;
    trackHydrangeaWeather(plant, weather, sheltered, clock, time);
    plant.growth += time * growthRate;
    if (!wet && !gentle) plant.low += time;
    plant.dry = watered ? 0 : plant.dry + time;
    plant.water =
      time === untilBoundary
        ? boundary
        : Math.min(100, Math.max(0, plant.water + rate * time));
    remaining -= time;
    if (time === untilMature) {
      plant.growth = plant.crop.hours;
      maturePlant(plant, elapsed - remaining * HOUR);
    } else if (time === untilWithered) {
      plant.status = "withered";
      plant.witheredReason = "drought";
    }
    if (growthRate && time > 0)
      onGrowth?.(before, plant.growth, clock, HOUR / growthRate, plant);
  }
  plant.settledAt = elapsed - remaining * HOUR;
  return plant;
}

/** @param {Plant} plant @param {WeatherEntry} weather @param {boolean} sheltered */
export function closePlantDay(plant, weather, sheltered) {
  if (plant.status !== "growing" || plant.rules.careMode === "gentle")
    return plant;
  const storm = !sheltered && weather.kind === "storm";
  const drizzle =
    !sheltered &&
    weather.kind === "drizzle" &&
    plant.cropId !== hydrangea &&
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
