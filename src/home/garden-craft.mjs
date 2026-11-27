// @ts-check
import { z } from "zod";
import { gardenGifts } from "../../public/garden-art/gifts.js";

/** @typedef {import("node:sqlite").DatabaseSync} Database */
/** @typedef {import("./garden-service.mjs").State} State */
/** @typedef {import("./garden-items.mjs").GiftContext} GiftContext */
/** @typedef {{id:string,cropId:string,quality:string,plantId?:string}} Lot */
/** @typedef {{cropId:string,cropName:string,quality:string,plantId?:string,maturedDay?:number,carers?:string[]}} Ingredient */
/** @typedef {{recipeId:string,ingredients:Ingredient[]}} CraftMeta */
/** @typedef {{price:number,count:number,crops:string[],quality?:string,facility?:true,requirements:string[]}} Recipe */

const flowers = [
  "sunflower",
  "moonflower",
  "catnip",
  "mistbell",
  "hydrangea",
  "chamomile",
];

/** @type {Record<string,Recipe>} */
const recipes = {
  "craft-pressed-flower": {
    price: 10,
    count: 1,
    crops: flowers,
    quality: "perfect",
    requirements: ["1 份完美品质的花类收成"],
  },
  "craft-strawberry-jam": {
    price: 12,
    count: 1,
    crops: ["strawberry", "sunberry"],
    requirements: ["1 份奶油草莓或蜜糖太阳莓"],
  },
  "craft-mint-tea": {
    price: 8,
    count: 1,
    crops: ["mint"],
    requirements: ["1 份薄荷收成"],
  },
  "craft-chamomile-sachet": {
    price: 12,
    count: 1,
    crops: ["chamomile"],
    requirements: ["1 份晚风洋甘菊收成"],
  },
  "craft-flower-bouquet": {
    price: 18,
    count: 2,
    crops: flowers,
    facility: true,
    requirements: ["2 份不同品种的花类收成"],
  },
  "craft-mistbell-jar": {
    price: 20,
    count: 1,
    crops: ["mistbell"],
    facility: true,
    requirements: ["1 份星雾铃收成"],
  },
};

export const gardenRecipeId = z.enum(
  /** @type {[string,...string[]]} */ (Object.keys(recipes)),
);

/** @param {Database} db */
function harvestLots(db) {
  return db
    .prepare(
      `SELECT id,crop_id,quality,plant_id FROM garden_harvests WHERE quantity>0 ORDER BY rowid`,
    )
    .all()
    .map((row) => ({
      id: String(row.id),
      cropId: String(row.crop_id),
      quality: String(row.quality),
      ...(row.plant_id && { plantId: String(row.plant_id) }),
    }));
}

/** @param {Recipe} recipe @param {Lot} lot */
function accepts(recipe, lot) {
  return (
    recipe.crops.includes(lot.cropId) &&
    (!recipe.quality || lot.quality === recipe.quality)
  );
}

/** @param {Database} db @param {boolean} hasRack */
export function gardenCraftRecipes(db, hasRack) {
  const lots = harvestLots(db);
  return Object.entries(recipes).map(([id, recipe]) => {
    const gift = gardenGifts[/** @type {keyof typeof gardenGifts} */ (id)];
    const locked = Boolean(recipe.facility && !hasRack);
    const available = locked ? [] : lots.filter((lot) => accepts(recipe, lot));
    const picked = [
      ...new Map(available.map((lot) => [lot.cropId, lot.id])).values(),
    ].slice(0, recipe.count);
    const ready = picked.length === recipe.count;
    return {
      id,
      name: gift.name,
      price: hasRack ? recipe.price / 2 : recipe.price,
      usable: gift.usable,
      locked,
      ready,
      ingredientCount: recipe.count,
      requirements: locked ? ["需要干花晾晒架"] : recipe.requirements,
      harvestIds: available.map(({ id }) => id),
      suggestedHarvestIds: ready ? picked : [],
    };
  });
}

/** @param {Database} db @param {State} state @param {Lot} lot @param {GiftContext} context */
function provenance(db, state, lot, context) {
  const { cropId, quality, plantId } = lot;
  const cropName = state.settings.crops[cropId]?.name ?? cropId;
  if (!plantId) return { cropId, cropName, quality };
  const harvest = db
    .prepare(
      `SELECT id,clock,json_extract(detail,'$.maturedDay') AS matured_day,
    json_extract(detail,'$.cropName') AS crop_name FROM garden_facts
    WHERE type='harvest' AND json_extract(detail,'$.harvestId')=?`,
    )
    .get(lot.id);
  const carers =
    harvest?.clock == null
      ? []
      : db
          .prepare(
            `SELECT DISTINCT actor_kind AS kind,actor_id AS id,
      json_extract(detail,'$.actorGeneration') AS generation
    FROM garden_facts AS fact,json_each(fact.plants) AS plant
    WHERE fact.type IN ('planted','water','fertilize') AND fact.clock<=? AND fact.id<?
      AND json_extract(plant.value,'$.plantId')=?
    ORDER BY fact.id`,
          )
          .all(harvest.clock, harvest.id, plantId)
          .flatMap(({ kind, id, generation }) => {
            if (
              typeof id !== "string" ||
              (kind !== "admin" && kind !== "agent")
            )
              return [];
            const carer = context.recipient({ kind, id });
            return carer && carer.generation === generation ? [carer.name] : [];
          });
  return {
    cropId,
    cropName:
      typeof harvest?.crop_name === "string" ? harvest.crop_name : cropName,
    quality,
    plantId,
    ...(typeof harvest?.matured_day === "number" && {
      maturedDay: harvest.matured_day,
    }),
    ...(carers.length && { carers: [...new Set(carers)] }),
  };
}

/** @param {Database} db @param {State} state @param {GiftContext} context
 * @param {{recipeId:string, harvestIds:string[],price:number}} action @param {boolean} hasRack */
export function prepareGardenCraft(db, state, context, action, hasRack) {
  const recipe = recipes[action.recipeId];
  if (!recipe || (recipe.facility && !hasRack))
    throw Error("GARDEN_RECIPE_LOCKED");
  const price = hasRack ? recipe.price / 2 : recipe.price;
  if (action.price !== price) throw Error("GARDEN_PRICE_CHANGED");
  const lots = new Map(harvestLots(db).map((row) => [row.id, row]));
  const picked = action.harvestIds.flatMap((id) => {
    const lot = lots.get(id);
    return lot && accepts(recipe, lot) ? [lot] : [];
  });
  if (
    action.harvestIds.length !== recipe.count ||
    picked.length !== recipe.count ||
    new Set(picked.map(({ cropId }) => cropId)).size !== recipe.count
  )
    throw Error("GARDEN_RECIPE_INGREDIENTS");
  return {
    price,
    giftId: /** @type {keyof typeof gardenGifts} */ (action.recipeId),
    craftMeta: {
      recipeId: action.recipeId,
      ingredients: picked.map((lot) => provenance(db, state, lot, context)),
    },
  };
}
