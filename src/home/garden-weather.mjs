// @ts-check
import { createHash } from "node:crypto";
import { z } from "zod";

const entryId = z.string().regex(/^[a-z][a-z0-9-]{0,39}$/);
export const weatherKinds = z.enum(["sun", "cloud", "drizzle", "storm"]);
const comparison = z.enum(["eq", "gt", "gte", "lt", "lte"]);
const limit = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const match = z.discriminatedUnion("by", [
  z.strictObject({ by: z.literal("kind"), value: weatherKinds }),
  z.strictObject({ by: z.literal("id"), value: entryId }),
]);
export const weatherCondition = z.discriminatedUnion("field", [
  z.strictObject({ field: z.literal("previous"), match }),
  z.strictObject({
    field: z.literal("streak"),
    match,
    op: comparison,
    value: limit.max(365),
  }),
  z.strictObject({ field: z.literal("balance"), op: comparison, value: limit }),
  z.strictObject({
    field: z.literal("fertilizer"),
    op: comparison,
    value: limit,
  }),
  z.strictObject({
    field: z.enum(["seed", "harvest"]),
    cropId: entryId,
    op: comparison,
    value: limit,
  }),
]);
const weatherEntry = z.strictObject({
  name: z.string().trim().min(1).max(40),
  kind: weatherKinds,
  enabled: z.boolean(),
  weight: z.number().min(0).max(10000),
  mode: z.enum(["all", "any"]),
  conditions: z.array(weatherCondition).max(12),
  light: z.enum(["high", "medium", "low"]),
  demand: z.number().min(0).max(10),
  rain: z.number().min(0).max(2400),
  outdoorGrowth: z.number().min(0).max(4),
  qualityLoss: z.number().min(0).max(100),
});

export const weatherPool = z
  .strictObject({
    fallback: entryId,
    entries: z.record(entryId, weatherEntry),
  })
  .superRefine(({ fallback, entries }, ctx) => {
    const permanent = Object.hasOwn(entries, fallback) && entries[fallback];
    if (!permanent || !permanent.enabled || permanent.conditions.length)
      ctx.addIssue({
        code: "custom",
        path: ["fallback"],
        message: "GARDEN_WEATHER_FALLBACK",
      });
    if (Object.keys(entries).length > 40)
      ctx.addIssue({
        code: "custom",
        path: ["entries"],
        message: "GARDEN_WEATHER_LIMIT",
      });
    for (const [id, entry] of Object.entries(entries))
      for (const [index, condition] of entry.conditions.entries())
        if (
          "match" in condition &&
          condition.match.by === "id" &&
          !Object.hasOwn(entries, condition.match.value)
        )
          ctx.addIssue({
            code: "custom",
            path: ["entries", id, "conditions", index],
            message: "GARDEN_WEATHER_REFERENCE",
          });
  });

export const weatherTrialInput = z.strictObject({
  balance: limit.optional(),
  previousId: entryId.optional(),
  streak: limit.min(1).max(365).optional(),
});

/** @typedef {z.infer<typeof weatherPool>} WeatherPool */
/** @typedef {z.infer<typeof weatherEntry>} WeatherEntry */
/** @typedef {z.infer<typeof weatherCondition>} WeatherCondition */
/** @typedef {WeatherEntry & {id:string}} Weather */
/** @typedef {{day:number, revision:number, weather:Weather, kindStreak:number, idStreak:number}} GardenDay */
/** @typedef {{previous:GardenDay|null, balance:number, fertilizer:number, seeds:Record<string,number>, harvests:Record<string,number>}} DrawContext */

/** @type {WeatherPool} */
export const defaultWeather = {
  fallback: "cloud",
  entries: {
    sun: {
      name: "晴天",
      kind: "sun",
      enabled: true,
      weight: 4,
      mode: "all",
      conditions: [],
      light: "high",
      demand: 1.5,
      rain: 0,
      outdoorGrowth: 1,
      qualityLoss: 0,
    },
    cloud: {
      name: "多云",
      kind: "cloud",
      enabled: true,
      weight: 4,
      mode: "all",
      conditions: [],
      light: "medium",
      demand: 1,
      rain: 0,
      outdoorGrowth: 1,
      qualityLoss: 0,
    },
    drizzle: {
      name: "细雨",
      kind: "drizzle",
      enabled: true,
      weight: 2,
      mode: "all",
      conditions: [],
      light: "medium",
      demand: 1,
      rain: 45,
      outdoorGrowth: 1,
      qualityLoss: 5,
    },
    storm: {
      name: "暴雨",
      kind: "storm",
      enabled: true,
      weight: 1,
      mode: "all",
      conditions: [],
      light: "low",
      demand: 1,
      rain: 0,
      outdoorGrowth: 0,
      qualityLoss: 15,
    },
  },
};

const compare = {
  eq: (/** @type {number} */ a, /** @type {number} */ b) => a === b,
  gt: (/** @type {number} */ a, /** @type {number} */ b) => a > b,
  gte: (/** @type {number} */ a, /** @type {number} */ b) => a >= b,
  lt: (/** @type {number} */ a, /** @type {number} */ b) => a < b,
  lte: (/** @type {number} */ a, /** @type {number} */ b) => a <= b,
};

/** @param {WeatherCondition} condition @param {DrawContext} ctx */
function matches(condition, ctx) {
  if ("match" in condition) {
    const { previous } = ctx;
    const same =
      previous?.weather[condition.match.by] === condition.match.value;
    if (condition.field === "previous") return same;
    const count =
      same && previous
        ? condition.match.by === "id"
          ? previous.idStreak
          : previous.kindStreak
        : 0;
    return compare[condition.op](count, condition.value);
  }
  const value =
    condition.field === "seed"
      ? Object.hasOwn(ctx.seeds, condition.cropId)
        ? ctx.seeds[condition.cropId]
        : 0
      : condition.field === "harvest"
        ? Object.hasOwn(ctx.harvests, condition.cropId)
          ? ctx.harvests[condition.cropId]
          : 0
        : condition.field === "balance"
          ? ctx.balance
          : ctx.fertilizer;
  return compare[condition.op](value, condition.value);
}

/** @param {WeatherPool} pool @param {DrawContext} ctx */
export function weatherOdds(pool, ctx) {
  const rows = Object.keys(pool.entries)
    .sort()
    .map((id) => {
      const entry = pool.entries[id];
      const failedConditions = entry.conditions.flatMap((condition, index) =>
        matches(condition, ctx) ? [] : [index],
      );
      const eligible =
        !entry.conditions.length ||
        (entry.mode === "all"
          ? !failedConditions.length
          : failedConditions.length < entry.conditions.length);
      const reason = !entry.enabled
        ? "disabled"
        : entry.weight === 0
          ? "zero_weight"
          : !eligible
            ? "conditions"
            : null;
      return {
        id,
        name: entry.name,
        reason,
        failedConditions,
        weight: reason ? 0 : entry.weight,
      };
    });
  const total = rows.reduce((sum, row) => sum + row.weight, 0);
  return {
    fallback: total === 0 ? pool.fallback : null,
    rows: rows.map(({ weight, ...row }) => ({
      ...row,
      probability:
        total > 0 ? weight / total : Number(row.id === pool.fallback),
    })),
  };
}

/** @param {WeatherPool} pool @param {DrawContext} ctx @param {string} seed @param {number} day */
export function drawWeather(pool, ctx, seed, day) {
  const odds = weatherOdds(pool, ctx);
  let roll =
    createHash("sha256")
      .update(`${seed}:weather:${day}`)
      .digest()
      .readUInt32BE() /
    2 ** 32;
  const choices = odds.rows.filter(({ probability }) => probability > 0);
  for (const choice of choices) {
    roll -= choice.probability;
    if (roll < 0) return { ...pool.entries[choice.id], id: choice.id };
  }
  // Rounding can leave the final subtraction just above zero.
  const id = choices.at(-1)?.id ?? pool.fallback;
  return { ...pool.entries[id], id };
}
