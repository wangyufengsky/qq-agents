import { createHash } from "node:crypto";
import { z } from "zod";
import {
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
  .min(1)
  .max(20)
  .refine((ids) => new Set(ids).size === ids.length);
const effect = z.discriminatedUnion("kind", [
  z
    .strictObject({
      kind: z.literal("merchant"),
      seeds: crops,
      harvests: crops,
      offers: z.number().int().min(1).max(2),
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
]);
const condition = z.union([
  weatherCondition,
  z.strictObject({ field: z.literal("today"), match: weatherMatch }),
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
export const defaultEvents = eventPool.parse({
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
      return (
        effect.kind !== "visitor" ||
        effect.reward.kind !== "seed" ||
        Object.hasOwn(settings.crops, effect.reward.cropId)
      );
    },
  );
}

export function eventOdds(pool, ctx, weather) {
  return poolOdds(
    pool.entries,
    (condition) =>
      condition.field === "today"
        ? weather?.[condition.match.by] === condition.match.value
        : matches(condition, ctx),
    null,
    pool.rate,
  );
}

export function drawGardenEvent(settings, ctx, weather, seed, day) {
  const pool = settings.events;
  const entryId = drawPool(eventOdds(pool, ctx, weather), seed, "event", day);
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
    return { ...base, reward, coinLoss, cropLoss };
  }
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
    }));
  const cropId = choose(effect.harvests, "harvest:")[0];
  const premium =
    Math.round(
      100 *
        (effect.minPremium +
          (effect.maxPremium - effect.minPremium) *
            (rank("premium") / 0xffffffff)),
    ) / 100;
  const price = settings.crops[cropId].salePrice * premium;
  return {
    ...base,
    seedOffers,
    offer: {
      cropId,
      name: settings.crops[cropId].name,
      premium,
      rates: {
        ordinary: price,
        fine: price * settings.fineMultiplier,
        perfect: price * settings.perfectMultiplier,
      },
    },
  };
}
