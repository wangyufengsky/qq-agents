import { gardenGiftId, gardenGiftOffers } from "./garden-items.mjs";
import { createHash } from "node:crypto";
import { z } from "zod";
import {
  compare,
  drawPool,
  matches,
  poolEntryId,
  poolOdds,
  weatherCondition,
  weatherMatch,
} from "./garden-weather.mjs";

const quantity = z.number().int().min(1).max(100);
const coins = z.number().int().min(0).max(1000);
const crops = z
  .array(poolEntryId)
  .max(20)
  .refine((ids) => new Set(ids).size === ids.length);
const effect = z.discriminatedUnion("kind", [
  z
    .strictObject({
      kind: z.literal("merchant"),
      giftOffers: z
        .array(
          z.strictObject({
            giftId: gardenGiftId,
            price: coins.optional(),
            stock: quantity,
          }),
        )
        .max(gardenGiftId.options.length)
        .refine(
          (rows) => new Set(rows.map((row) => row.giftId)).size === rows.length,
        )
        .optional(),
      seeds: crops,
      fertilizerOffers: z
        .array(z.strictObject({ rate: coins }))
        .max(1)
        .optional(),
      harvestOffers: z.number().int().min(1).max(20).optional(),
      harvests: crops,
      offers: z.number().int().min(1).max(20),
      discount: z.number().min(0).max(1),
      minPremium: z.number().min(1.3).max(1.6),
      maxPremium: z.number().min(1.3).max(1.6),
    })
    .refine((row) => row.minPremium <= row.maxPremium),
  z.strictObject({
    kind: z.literal("thief"),
    reward: coins,
    coinLoss: coins,
    cropLoss: quantity.max(5),
    targetCropId: poolEntryId.optional(),
  }),
  z.strictObject({
    kind: z.literal("visitor"),
    reward: z.discriminatedUnion("kind", [
      z.strictObject({
        kind: z.literal("seed"),
        cropId: poolEntryId,
        quantity,
      }),
      z.strictObject({ kind: z.literal("fertilizer"), quantity }),
      z.strictObject({
        kind: z.literal("fertilizer_credit"),
        quantity: z.literal(1),
      }),
    ]),
  }),
  z.strictObject({
    kind: z.literal("blessing"),
    effect: z.enum(["meteor", "dew", "firefly", "earthworm"]),
    quality: z.number().int().min(0).max(100).optional(),
    growth: z.number().min(0).max(24).optional(),
    water: z.number().min(0).max(100).optional(),
  }),
  z.strictObject({
    kind: z.literal("nuisance"),
    effect: z.enum(["cat", "aphids"]),
    reward: coins.optional(),
    cost: coins.optional(),
    growthRate: z.number().min(0).max(1).optional(),
    qualityLoss: z.number().int().min(0).max(100).optional(),
  }),
  z.strictObject({
    kind: z.literal("weather_flip"),
    targetWeatherId: poolEntryId,
    hour: z.number().int().min(1).max(23),
  }),
  z.strictObject({
    kind: z.literal("harvest_bonus"),
    effect: z.enum(["twin", "sketch"]),
    multiplier: quantity.optional(),
    required: quantity.max(9).optional(),
    reward: coins.optional(),
  }),
  z.strictObject({
    kind: z.literal("mystery_box"),
    price: coins,
    limit: quantity,
  }),
]);
const condition = z.union([
  weatherCondition,
  z.strictObject({ field: z.literal("today"), match: weatherMatch }),
  z.strictObject({
    field: z.enum(["growing", "sheltered", "fertilizable", "alive"]),
    cropId: poolEntryId.optional(),
    op: z.enum(["eq", "gt", "gte", "lt", "lte"]),
    value: z.number().int().min(0).max(9),
  }),
  z.strictObject({
    field: z.literal("weekDay"),
    days: z.array(z.number().int().min(1).max(7)).min(1).max(7),
  }),
]);
export const eventPool = z
  .strictObject({
    rate: z.number().min(0).max(1),
    entries: z.record(
      poolEntryId,
      z.strictObject({
        name: z.string().trim().min(1).max(40),
        enabled: z.boolean(),
        weight: z.number().min(0).max(10000),
        mode: z.enum(["all", "any"]),
        conditions: z.array(condition).max(12),
        effect,
      }),
    ),
  })
  .refine(({ entries }) => Object.keys(entries).length <= 40);
export const legacyEvents = eventPool.parse({
  rate: 0.4,
  entries: {
    merchant: {
      name: "流浪商人",
      enabled: true,
      weight: 3,
      mode: "all",
      conditions: [],
      effect: {
        kind: "merchant",
        seeds: ["sunflower", "strawberry", "moonflower"],
        harvests: ["sunflower", "strawberry", "moonflower"],
        offers: 2,
        discount: 0.75,
        minPremium: 1.3,
        maxPremium: 1.6,
      },
    },
    thief: {
      name: "小偷踩点",
      enabled: true,
      weight: 1,
      mode: "all",
      conditions: [{ field: "balance", op: "gt", value: 300 }],
      effect: { kind: "thief", reward: 15, coinLoss: 30, cropLoss: 1 },
    },
    visitor: {
      name: "幸运访客",
      enabled: true,
      weight: 2,
      mode: "all",
      conditions: [],
      effect: { kind: "visitor", reward: { kind: "fertilizer", quantity: 1 } },
    },
  },
});

const today = (value) => ({ field: "today", match: { by: "kind", value } });
const previous = (value) => ({
  field: "previous",
  match: { by: "kind", value },
});
const growing = { field: "growing", op: "gt", value: 0 };
const entry = (name, weight, conditions, effect, mode = "all") => ({
  name,
  weight,
  conditions,
  effect,
  mode,
  enabled: true,
});
const merchant = (
  seeds,
  harvests,
  offers,
  discount,
  minPremium,
  maxPremium,
) => ({
  kind: "merchant",
  seeds,
  harvests,
  offers,
  discount,
  minPremium,
  maxPremium,
});
const seedGift = (cropId) => ({
  kind: "visitor",
  reward: { kind: "seed", cropId, quantity: 1 },
});

export const mysteryCrops = [
  "clover",
  "radish",
  "sunflower",
  "mint",
  "strawberry",
  "moonflower",
];
export const defaultEvents = eventPool.parse({
  ...legacyEvents,
  entries: {
    ...legacyEvents.entries,
    merchant: {
      ...legacyEvents.entries.merchant,
      effect: {
        ...legacyEvents.entries.merchant.effect,
        seeds: ["radish", "sunflower", "mint", "strawberry", "moonflower"],
        fertilizerOffers: [{ rate: 20 }],
        offers: 5,
        harvestOffers: 2,
      },
    },
    "rain-merchant": entry(
      "雨夜斗篷花贩",
      2,
      [today("drizzle"), today("storm")],
      merchant(
        ["mint", "moonflower"],
        ["mint", "moonflower"],
        2,
        0.5,
        1.3,
        1.5,
      ),
      "any",
    ),
    "sunny-market": entry(
      "晴空集市大收购",
      2,
      [today("sun"), previous("sun")],
      merchant(
        ["sunflower", "radish"],
        ["sunflower", "radish"],
        2,
        0.85,
        1.5,
        1.6,
      ),
    ),
    "fox-thief": entry(
      "劫富济贫小狐狸",
      1,
      [{ field: "balance", op: "gt", value: 1000 }],
      { kind: "thief", reward: 35, coinLoss: 60, cropLoss: 2 },
    ),
    "hedgehog-thief": entry(
      "偷吃草莓的小刺猬",
      1,
      [{ field: "harvest", cropId: "strawberry", op: "gt", value: 0 }],
      {
        kind: "thief",
        reward: 20,
        coinLoss: 0,
        cropLoss: 1,
        targetCropId: "strawberry",
      },
    ),
    "sparrow-visitor": entry(
      "迷路小鸟衔来种子",
      2,
      [today("sun"), today("cloud")],
      seedGift("sunflower"),
      "any",
    ),
    "wind-moonflower": entry(
      "大风刮来的神秘花种",
      1,
      [previous("storm")],
      seedGift("moonflower"),
    ),
    "gardener-aid": entry(
      "隔壁老园丁的肥料赠礼",
      3,
      [{ field: "balance", op: "lt", value: 200 }],
      { kind: "visitor", reward: { kind: "fertilizer_credit", quantity: 1 } },
    ),
    "snail-express": entry("暴雨天的蜗牛快递员", 2, [today("storm")], {
      kind: "visitor",
      reward: { kind: "fertilizer", quantity: 2 },
    }),
    "clearance-oldman": entry(
      "清仓甩卖的种子老头",
      2,
      [{ field: "balance", op: "lte", value: 400 }],
      merchant(["radish", "mint"], ["radish", "mint"], 2, 0.4, 1.3, 1.4),
    ),
    "banquet-buyer": entry(
      "囤货大户的急单",
      2,
      [{ field: "harvest", cropId: "moonflower", op: "gte", value: 2 }],
      merchant(["moonflower", "strawberry"], ["moonflower"], 1, 0.9, 1.5, 1.6),
    ),
    "meteor-shower": entry("流星雨许愿夜", 1, [growing], {
      kind: "blessing",
      effect: "meteor",
      quality: 15,
      growth: 5,
    }),
    "morning-dew": entry("清晨甘露", 2, [growing], {
      kind: "blessing",
      effect: "dew",
      water: 30,
    }),
    "stray-cat": entry(
      "顽皮野猫来串门",
      1,
      [{ field: "sheltered", op: "gt", value: 0 }],
      { kind: "nuisance", effect: "cat", reward: 10 },
    ),
    "weather-blunder": entry("气象台乌龙预报", 1, [today("storm")], {
      kind: "weather_flip",
      targetWeatherId: "sun",
      hour: 12,
    }),
    "twin-fruit": entry("花园双胞胎变异", 1, [], {
      kind: "harvest_bonus",
      effect: "twin",
      multiplier: 2,
    }),
    "aphid-squad": entry("讨厌的蚜虫小分队", 1, [growing], {
      kind: "nuisance",
      effect: "aphids",
      growthRate: 0.5,
      cost: 10,
      qualityLoss: 10,
    }),
    "firefly-concert": entry(
      "萤火虫音乐会",
      1,
      [
        today("cloud"),
        { field: "alive", cropId: "moonflower", op: "gt", value: 0 },
      ],
      { kind: "blessing", effect: "firefly", quality: 20 },
      "any",
    ),
    "sketch-contest": entry("小窝花园写生竞赛", 1, [], {
      kind: "harvest_bonus",
      effect: "sketch",
      required: 3,
      reward: 80,
    }),
    "golden-earthworm": entry(
      "黄金蚯蚓松土",
      1,
      [{ field: "fertilizable", op: "gt", value: 0 }],
      { kind: "blessing", effect: "earthworm" },
    ),
    "mystery-seed-bag": entry(
      "周末盲盒种子袋",
      2,
      [{ field: "weekDay", days: [6, 7] }],
      { kind: "mystery_box", price: 25, limit: 2 },
    ),
  },
});

function matchesEvent(condition, ctx, weather) {
  if (condition.field === "today")
    return weather?.[condition.match.by] === condition.match.value;
  if (condition.field === "weekDay")
    return condition.days.includes((((ctx.day ?? 1) - 1) % 7) + 1);
  if (
    ["growing", "sheltered", "fertilizable", "alive"].includes(condition.field)
  ) {
    const count = (ctx.plots ?? []).filter(({ plant, sheltered }) => {
      if (condition.field === "sheltered" && !condition.cropId)
        return sheltered;
      if (!plant || (condition.cropId && plant.cropId !== condition.cropId))
        return false;
      if (condition.field === "sheltered") return sheltered;
      if (condition.field === "alive") return plant.status !== "withered";
      return (
        plant.status === "growing" &&
        (condition.field !== "fertilizable" ||
          (plant.earthwormDay === undefined &&
            plant.fertilizer < plant.crop.fertilizer))
      );
    }).length;
    return compare[condition.op](count, condition.value);
  }
  return matches(condition, ctx);
}

export function rankEventTarget(seed, lane, day, targets, key) {
  return targets
    .map((target) => {
      const id = String(key(target));
      const rank = createHash("sha256")
        .update(`${seed}:${lane}:${day}:${id}`)
        .digest("hex");
      return { target, id, rank };
    })
    .sort((a, b) => a.rank.localeCompare(b.rank) || a.id.localeCompare(b.id))
    .map(({ target }) => target);
}

export function validEventReferences(settings) {
  return Object.values(settings.events.entries).every(
    ({ conditions, effect }) => {
      if (
        !conditions.every(
          (row) =>
            (!("cropId" in row) || Object.hasOwn(settings.crops, row.cropId)) &&
            (!("match" in row) ||
              row.match.by !== "id" ||
              Object.hasOwn(settings.weather.entries, row.match.value)),
        )
      )
        return false;
      if (effect.kind === "merchant")
        return [...effect.seeds, ...effect.harvests].every((id) =>
          Object.hasOwn(settings.crops, id),
        );
      if (effect.kind === "thief" && effect.targetCropId)
        return Object.hasOwn(settings.crops, effect.targetCropId);
      if (effect.kind === "weather_flip")
        return Object.hasOwn(settings.weather.entries, effect.targetWeatherId);
      return (
        effect.kind !== "visitor" ||
        effect.reward.kind !== "seed" ||
        Object.hasOwn(settings.crops, effect.reward.cropId)
      );
    },
  );
}

export function eventOdds(settings, ctx, weather) {
  const pool = settings.events;
  return poolOdds(
    pool.entries,
    (condition) => matchesEvent(condition, ctx, weather),
    null,
    pool.rate,
    (id) => {
      const { effect } = pool.entries[id];
      if (
        effect.kind === "merchant" &&
        !effect.fertilizerOffers?.length &&
        effect.giftOffers?.length === 0 &&
        !effect.harvests.some(
          (cropId) =>
            Object.hasOwn(ctx.harvests, cropId) && ctx.harvests[cropId] > 0,
        ) &&
        !effect.seeds.some((cropId) => settings.crops[cropId].enabled)
      )
        return "no_seeds";
      if (
        effect.kind === "weather_flip" &&
        (!settings.weather.entries[effect.targetWeatherId]?.enabled ||
          settings.weather.entries[effect.targetWeatherId].kind !== "sun")
      )
        return "weather_unavailable";
      if (
        effect.kind === "mystery_box" &&
        !mysteryCrops.some((id) => settings.crops[id]?.enabled)
      )
        return "no_seeds";
      return null;
    },
  );
}

export function drawGardenEvent(settings, ctx, weather, seed, day) {
  const pool = settings.events;
  const entryId = drawPool(
    eventOdds(settings, { ...ctx, day }, weather),
    seed,
    "event",
    day,
  );
  if (!entryId) return null;
  const { name, effect } = pool.entries[entryId];
  const base = {
    id: `${day}:${entryId}`,
    name,
    kind: effect.kind,
    status: "open",
  };
  if (effect.kind === "visitor") return { ...base, reward: effect.reward };
  if (effect.kind === "thief") {
    const { reward, coinLoss, cropLoss } = effect;
    return {
      ...base,
      reward,
      coinLoss,
      cropLoss,
      targetCropId: effect.targetCropId,
    };
  }
  if (effect.kind === "weather_flip")
    return {
      ...base,
      effect,
      forecast: weather,
      targetWeather: {
        ...settings.weather.entries[effect.targetWeatherId],
        id: effect.targetWeatherId,
      },
    };
  if (effect.kind !== "merchant") return { ...base, effect };
  const rank = (key) =>
    createHash("sha256")
      .update(`${seed}:merchant:${day}:${key}`)
      .digest()
      .readUInt32BE();
  const choose = (ids, lane) =>
    [...ids].sort(
      (a, b) => rank(lane + a) - rank(lane + b) || a.localeCompare(b),
    );
  const seedOffers = choose(
    effect.seeds.filter((id) => settings.crops[id].enabled),
    "seed:",
  )
    .slice(0, effect.offers)
    .map((cropId) => ({
      cropId,
      name: settings.crops[cropId].name,
      rate: settings.crops[cropId].seedPrice * effect.discount,
      originalRate: settings.crops[cropId].seedPrice,
      discount: effect.discount,
    }));

  const premium =
    Math.round(
      100 *
        (effect.minPremium +
          (effect.maxPremium - effect.minPremium) *
            (rank("premium") / 0xffffffff)),
    ) / 100;
  const offers = choose(effect.harvests, "harvest:")
    .slice(0, effect.harvestOffers ?? 1)
    .map((cropId) => {
      const originalRate = settings.crops[cropId].salePrice;
      const price = originalRate * premium;
      return {
        cropId,
        name: settings.crops[cropId].name,
        premium,
        originalRate,
        rates: {
          ordinary: price,
          fine: price * settings.fineMultiplier,
          perfect: price * settings.perfectMultiplier,
        },
      };
    });
  return {
    ...base,
    seedOffers,
    giftOffers: gardenGiftOffers(
      effect.giftOffers ??
        choose(gardenGiftId.options, "gift:")
          .slice(0, 3 + (rank("gift-count") % 3))
          .map((giftId) => ({
            giftId,
            stock: 2 + (rank("gift-stock:" + giftId) % 2),
          })),
    ),
    fertilizerOffers: effect.fertilizerOffers ?? [],
    offers,
    offer: offers[0],
  };
}
