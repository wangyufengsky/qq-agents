import { randomUUID } from "node:crypto";
import { z } from "zod";
import { GardenStories } from "./garden-stories.mjs";
import { gardenPlantRef } from "./garden-journal.mjs";
import {
  adjustPlantQuality,
  DAY,
  gardenPlantRules,
  grantGrowth,
} from "./garden-rules.mjs";
import {
  drawGardenEvent,
  eventOdds,
  mysteryCrops,
  rankEventTarget,
} from "./garden-event-rules.mjs";
import { poolEntryId, weatherTrialInput } from "./garden-weather.mjs";

const system = { kind: "admin", id: "system" };
const trial = weatherTrialInput.extend({
  todayId: poolEntryId.optional(),
  day: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER).optional(),
});

/** @typedef {{id:string,name:string,status:"open"|"expired"|"claimed"|"chased"|"missed"|"resolved",outcome?:any}} EventBase */
/** @typedef {{cropId:string,name:string,premium:number,originalRate?:number,rates:Record<string,number>}} HarvestOffer */
/** @typedef {ReturnType<import("./garden-event-rules.mjs").eventPool["parse"]>["entries"][string]["effect"]} EventEffect */
/** @typedef {EventBase & (
 * {kind:"merchant",seedOffers:{cropId:string,name:string,rate:number,originalRate?:number,discount?:number}[],offer?:HarvestOffer,offers?:HarvestOffer[],fertilizerOffers?:{rate:number}[],giftOffers?:import("./garden-items.mjs").GiftOffer[]} |
 * {kind:"thief",reward:number,coinLoss:number,cropLoss:number,targetCropId?:string} |
 * {kind:"visitor",reward:{kind:"seed",cropId:string,quantity:number}|{kind:"fertilizer"|"fertilizer_credit",quantity:number}} |
 * {kind:"blessing",effect:Extract<EventEffect,{kind:"blessing"}>} |
 * {kind:"nuisance",effect:Extract<EventEffect,{kind:"nuisance"}>,startedAt:number,handledAt?:number} |
 * {kind:"weather_flip",effect:Extract<EventEffect,{kind:"weather_flip"}>,targetWeather:import("./garden-weather.mjs").Weather,forecast:import("./garden-weather.mjs").Weather} |
 * {kind:"harvest_bonus",effect:Extract<EventEffect,{kind:"harvest_bonus"}>,progress?:{current:number,required:number}} |
 * {kind:"choice",effect:Extract<EventEffect,{kind:"choice"}>} |
 * {kind:"story",effect:Extract<EventEffect,{kind:"story"}>,target?:{plot:number,plantId:string,cropName:string}} |
 * {kind:"mystery_box",effect:Extract<EventEffect,{kind:"mystery_box"}>,purchased?:number,available?:boolean}
 * )} GardenEvent */
export class GardenEvents {
  constructor(db, changeBalance, journal) {
    this.db = db;
    this.changeBalance = changeBalance;
    this.journal = journal;
    this.stories = new GardenStories(db, journal);
  }

  /** @param {number|undefined} day @returns {GardenEvent|null} */
  get(day) {
    const row = this.db
      .prepare("SELECT value FROM garden_events WHERE day=?")
      .get(day);
    return row ? JSON.parse(row.value) : null;
  }

  history() {
    return this.db
      .prepare(
        "SELECT day,value FROM garden_events WHERE value IS NOT NULL AND value<>'null' ORDER BY day DESC LIMIT 14",
      )
      .all()
      .map((row) => ({ day: row.day, ...JSON.parse(row.value) }));
  }

  update(day, entry) {
    this.db
      .prepare("UPDATE garden_events SET value=? WHERE day=?")
      .run(JSON.stringify(entry), day);
  }

  draw(state, ctx, weather, seed, day) {
    const entry = drawGardenEvent(state.settings, ctx, weather, seed, day);
    if (entry)
      this.journal.record({
        type: entry.kind === "visitor" ? "visitor" : "event",
        clock: (day - 1) * DAY,
        source: "event",
        detail: { name: entry.name },
        key: `event:${day}`,
      });
    if (entry?.kind === "choice" && entry.effect.story === "sketch")
      entry.outcome = {
        matureNames: state.plots.flatMap(({ plant }) =>
          plant?.status === "mature" ? [plant.crop.name] : [],
        ),
      };
    if (entry?.kind === "story") {
      if (entry.effect.story === "migratory_bird" && entry.target) {
        const { plot, cropName } = entry.target;
        entry.outcome = {
          detail: `有只候鸟落在 ${plot} 号地的${cropName}旁歇脚。`,
        };
        this.stories.schedule(
          entry.id,
          day + 1,
          "migratory_feather",
          { kind: "admin", id: "administrator", generation: "instance" },
          entry.target,
        );
      }
      if (entry.effect.story === "fence_note" && entry.target) {
        const { plot, cropName } = entry.target;
        entry.outcome = {
          detail: `${plot} 号地的${cropName}长得真精神，看得出来有好几双手在认真照料。`,
        };
      }
      if (entry.effect.story === "full_moon")
        entry.outcome = { detail: "今晚的满月会照亮花园露台。" };
    }
    if (entry?.kind === "blessing") this.bless(entry, state, seed, day);
    if (entry?.kind === "nuisance") entry.startedAt = (day - 1) * DAY;
    this.db
      .prepare("INSERT INTO garden_events(day,value) VALUES(?,?)")
      .run(day, JSON.stringify(entry));
  }

  bless(entry, state, seed, day) {
    const {
      effect,
      quality = effect === "meteor" ? 15 : effect === "firefly" ? 20 : 0,
      growth = effect === "meteor" ? 5 : 0,
      water = effect === "dew" ? 30 : 0,
    } = entry.effect;
    const targets = state.plots.filter(
      ({ plant }) =>
        plant?.status === "growing" &&
        (effect !== "firefly" || plant.crop.light === "shade"),
    );
    entry.status = "claimed";
    if (effect === "earthworm") {
      const eligible = targets.filter(
        ({ plant }) =>
          plant.earthwormDay === undefined &&
          plant.fertilizer < plant.crop.fertilizer,
      );
      const target = rankEventTarget(
        seed,
        "earthworm",
        day,
        eligible,
        ({ id }) => id,
      )[0];
      if (target) target.plant.earthwormDay = day;
      entry.outcome = target
        ? { plotId: target.id, plantId: target.plant.id, used: false }
        : null;
      return;
    }
    entry.outcome = {
      plots: targets
        .map(({ id, plant }) => {
          const before = plant.water;
          plant.water = Math.min(100, before + water);
          if (water > 0 && plant.water > 0) plant.dry = 0;
          if (effect === "meteor" || effect === "dew") plant.blessed = true;
          const previousGrowth = plant.growth;
          const qualityChange = adjustPlantQuality(plant, quality);
          const growthChange = grantGrowth(plant, growth);
          const clock = (day - 1) * DAY;
          this.journal.growth(
            gardenPlantRef(id, plant),
            plant,
            previousGrowth,
            plant.growth,
            clock,
            0,
            entry,
          );
          this.journal.updatePlant(plant);
          return {
            plotId: id,
            plantId: plant.id,
            quality: qualityChange,
            growth: growthChange,
            water: plant.water - before,
          };
        })
        .filter(({ quality, growth, water }) => quality || growth || water),
    };
  }

  progress(entry, state) {
    return {
      current: new Set(
        state.plots.flatMap(({ plant }) =>
          plant && plant.status !== "withered" ? [plant.cropId] : [],
        ),
      ).size,
      required: entry.effect.required ?? 3,
    };
  }

  /** @returns {GardenEvent|null} */
  view(day, state, claimed) {
    const entry = claimed ?? this.get(day);
    if (
      entry?.kind === "story" &&
      entry.effect.story === "migratory_bird" &&
      entry.target
    ) {
      const { plot, plantId } = entry.target;
      if (
        state.plots.find(({ id }) => id === plot)?.plant?.id !== plantId ||
        this.stories.wasHarvested(day, plot, plantId)
      )
        return {
          ...entry,
          outcome: { detail: "候鸟已经从这块地飞走了。", unavailable: true },
        };
    }
    if (entry?.kind === "harvest_bonus" && entry.effect.effect === "sketch")
      return { ...entry, progress: this.progress(entry, state) };
    if (
      entry?.kind === "blessing" &&
      entry.effect.effect === "earthworm" &&
      entry.outcome
    ) {
      const { plotId, plantId } = entry.outcome;
      const plant = state.plots.find(({ id }) => id === plotId)?.plant;
      if (plant?.id !== plantId || plant.status !== "growing")
        return { ...entry, outcome: { ...entry.outcome, unavailable: true } };
    }
    if (entry?.kind === "mystery_box")
      return {
        ...entry,
        available: mysteryCrops.some((id) => state.settings.crops[id]?.enabled),
      };
    return entry;
  }

  useEarthworm(day, plotId, plantId) {
    if (day === undefined) return false;
    const entry = this.get(day);
    const target = entry?.outcome;
    if (
      entry?.kind !== "blessing" ||
      entry.effect.effect !== "earthworm" ||
      !target ||
      target.used ||
      target.plotId !== plotId ||
      target.plantId !== plantId
    )
      return false;
    this.update(day, { ...entry, outcome: { ...target, used: true } });
    return true;
  }

  harvestQuantity(day, plot, plant) {
    const entry = this.get(day);
    if (
      entry?.kind !== "harvest_bonus" ||
      entry.effect.effect !== "twin" ||
      entry.status !== "open"
    )
      return plant.crop.yield;
    const quantity = plant.crop.yield * (entry.effect.multiplier ?? 2);
    this.update(day, {
      ...entry,
      status: "claimed",
      outcome: { plotId: plot, plantId: plant.id, quantity },
    });
    return quantity;
  }

  grantMysteryBag(state, quantity = 1) {
    const candidates = mysteryCrops
      .filter((id) => state.settings.crops[id]?.enabled)
      .map((cropId) => ({ cropId, crop: state.settings.crops[cropId] }));
    if (!candidates.length) throw Error("GARDEN_SEED_UNAVAILABLE");
    const insert = this.db.prepare(
      "INSERT INTO garden_mystery_bags VALUES(?,?,?)",
    );
    const snapshot = JSON.stringify(candidates);
    const plantRules = JSON.stringify(gardenPlantRules(state.settings));
    for (let index = 0; index < quantity; index++)
      insert.run(randomUUID(), snapshot, plantRules);
  }

  mysteryStock() {
    const bags = this.db
      .prepare("SELECT candidates FROM garden_mystery_bags ORDER BY rowid")
      .all()
      .map(({ candidates }) => ({
        candidates: JSON.parse(candidates).map(({ cropId, crop }) => ({
          cropId,
          name: crop.name,
        })),
      }));
    return { count: bags.length, bags };
  }

  openBag() {
    const bag = this.db
      .prepare(
        "SELECT id,candidates,rules FROM garden_mystery_bags ORDER BY rowid LIMIT 1",
      )
      .get();
    if (!bag) throw Error("GARDEN_STOCK_UNAVAILABLE");
    const candidates = JSON.parse(bag.candidates);
    const result = rankEventTarget(
      this.seed(),
      "mystery-seed",
      bag.id,
      candidates,
      ({ cropId }) => cropId,
    )[0];
    this.db.prepare("DELETE FROM garden_mystery_bags WHERE id=?").run(bag.id);
    return {
      ...result,
      bagId: bag.id,
      rules: bag.rules && JSON.parse(bag.rules),
    };
  }

  seed() {
    return String(
      this.db.prepare("SELECT seed FROM garden_weather_seed WHERE id=1").get()
        ?.seed,
    );
  }

  trialInput(input) {
    return trial.parse(input);
  }

  trial(state, ctx, todayId, today) {
    if (todayId !== undefined) {
      if (!Object.hasOwn(state.settings.weather.entries, todayId))
        throw Error("INVALID_REQUEST");
      today = { ...state.settings.weather.entries[todayId], id: todayId };
    }
    return {
      today: today?.name ?? null,
      day: ctx.day,
      weatherBasis: "forecast",
      ...eventOdds(state.settings, ctx, today),
    };
  }

  settleFollowups(day, state, now, observe = true) {
    this.stories.settle(day, state, now, observe);
  }

  close(day, state, now) {
    const entry = this.get(day);
    if (
      entry?.kind === "story" &&
      entry.effect.story === "migratory_bird" &&
      entry.target
    ) {
      const { plot, plantId } = entry.target;
      const plant = state.plots.find(({ id }) => id === plot)?.plant;
      if (
        plant?.id !== plantId ||
        this.stories.wasHarvested(day, plot, plantId)
      )
        this.stories.cancel(entry.id, now);
    }
    if (!entry || entry.status !== "open") return;
    let outcome;
    if (entry.kind === "thief") {
      const lot = this.db
        .prepare(
          "SELECT id,crop_id,quantity FROM garden_harvests WHERE quantity>0 AND (crop_id=? OR ? IS NULL) ORDER BY rowid LIMIT 1",
        )
        .get(entry.targetCropId ?? null, entry.targetCropId ?? null);
      if (lot) {
        const quantity = Math.min(lot.quantity, entry.cropLoss);
        this.db
          .prepare(
            "UPDATE garden_harvests SET quantity=quantity-?,last_use='thief' WHERE id=?",
          )
          .run(quantity, lot.id);
        outcome = { harvestId: lot.id, cropId: lot.crop_id, quantity };
      } else if (entry.targetCropId && entry.coinLoss === 0) {
        outcome = { empty: true };
      } else {
        const coins = Math.min(state.balance, entry.coinLoss);
        this.changeBalance(now, system, "thief_loss", state, -coins);
        outcome = { coins };
      }
    }
    if (entry.kind === "nuisance") {
      if (entry.effect.effect === "cat") {
        const shelved = state.plots.filter(({ sheltered }) => sheltered);
        const target = rankEventTarget(
          this.seed(),
          "stray-cat",
          day,
          shelved,
          ({ id }) => id,
        )[0];
        if (target) target.sheltered = false;
        outcome = target
          ? { plotId: target.id, sheltered: false }
          : { empty: true };
      } else {
        const plots = state.plots.flatMap(({ id, plant }) =>
          plant?.status === "growing"
            ? [
                {
                  plotId: id,
                  plantId: plant.id,
                  quality: adjustPlantQuality(
                    plant,
                    -(entry.effect.qualityLoss ?? 10),
                  ),
                },
              ]
            : [],
        );
        outcome = { plots };
      }
    }
    this.update(day, {
      ...entry,
      status:
        entry.kind === "thief" || entry.kind === "nuisance"
          ? "missed"
          : "expired",
      outcome,
    });
  }

  credits() {
    return Number(
      this.db
        .prepare(
          "SELECT fertilizer_credits FROM garden_reward_stock WHERE id=1",
        )
        .get().fertilizer_credits,
    );
  }

  useCredit() {
    return (
      this.db
        .prepare(
          "UPDATE garden_reward_stock SET fertilizer_credits=fertilizer_credits-1 WHERE id=1 AND fertilizer_credits>0",
        )
        .run().changes > 0
    );
  }

  /** @returns {GardenEvent|null} */
  claimVisitor(day, actor, state) {
    const entry = this.get(day);
    if (!entry || entry.kind !== "visitor" || entry.status !== "open")
      return entry;
    const reward = entry.reward;
    if (reward.kind === "seed")
      state.seeds[reward.cropId] =
        (Object.hasOwn(state.seeds, reward.cropId)
          ? state.seeds[reward.cropId]
          : 0) + reward.quantity;
    else if (reward.kind === "fertilizer") state.fertilizer += reward.quantity;
    else
      this.db
        .prepare(
          "UPDATE garden_reward_stock SET fertilizer_credits=fertilizer_credits+1 WHERE id=1",
        )
        .run();
    this.db
      .prepare(
        "UPDATE garden_state SET seeds=?,fertilizer=?,revision=revision+1 WHERE id=1",
      )
      .run(JSON.stringify(state.seeds), state.fertilizer);
    state.revision++;
    const claimed = {
      ...entry,
      status: /** @type {const} */ ("claimed"),
      actor: { kind: actor.kind, id: actor.id },
    };
    this.update(day, claimed);
    this.journal.record({
      type: "visitor_reward",
      clock: state.clock,
      actor,
      source: "event",
      detail: { name: entry.name },
      key: `visitor_reward:${day}`,
    });
    return claimed;
  }

  perform(day, now, actor, action, state, owner) {
    const entry = this.get(day);
    if (!entry || entry.id !== action.eventId)
      throw Error("GARDEN_EVENT_EXPIRED");
    if (action.kind === "choose_event") {
      if (entry.kind !== "choice") throw Error("GARDEN_EVENT_CHOICE_INVALID");
      if (entry.status !== "open") throw Error("GARDEN_EVENT_ALREADY_RESOLVED");
      if (!owner) throw Error("GARDEN_ROLE_UNAVAILABLE");
      const receipt = this.stories.choose(
        entry,
        state,
        now,
        day,
        action,
        owner,
        (coins) => this.changeBalance(now, actor, action.kind, state, coins),
        () => this.grantMysteryBag(state),
      );
      this.update(day, {
        ...entry,
        status: "resolved",
        actor: { kind: actor.kind, id: actor.id },
        outcome: receipt.outcome,
      });
      return receipt;
    }
    if (entry.status !== "open") throw Error("GARDEN_EVENT_HANDLED");
    if (action.kind === "chase_thief") {
      if (entry.kind !== "thief") throw Error("GARDEN_EVENT_OFFER");
      this.changeBalance(now, actor, "chase_thief", state, entry.reward);
      this.update(day, {
        ...entry,
        status: "chased",
        actor: { kind: actor.kind, id: actor.id },
        outcome: { reward: entry.reward },
      });
      return { eventId: entry.id, reward: entry.reward };
    }
    if (action.kind === "resolve_event") {
      let delta;
      if (entry.kind === "nuisance") {
        delta =
          entry.effect.effect === "cat"
            ? (entry.effect.reward ?? 10)
            : -(entry.effect.cost ?? 10);
      } else if (
        entry.kind === "harvest_bonus" &&
        entry.effect.effect === "sketch"
      ) {
        const { current, required } = this.progress(entry, state);
        if (current < required) throw Error("GARDEN_EVENT_OFFER");
        delta = entry.effect.reward ?? 80;
      } else throw Error("GARDEN_EVENT_OFFER");
      this.changeBalance(now, actor, action.kind, state, delta);
      const outcome = { reward: Math.max(delta, 0), cost: Math.max(-delta, 0) };
      this.update(day, {
        ...entry,
        status: "claimed",
        handledAt: state.clock,
        actor: { kind: actor.kind, id: actor.id },
        outcome,
      });
      return { eventId: entry.id, ...outcome };
    }
    if (action.kind === "buy_mystery_seed") {
      if (entry.kind !== "mystery_box") throw Error("GARDEN_EVENT_OFFER");
      const purchased = (entry.purchased ?? 0) + action.quantity;
      if (purchased > entry.effect.limit)
        throw Error("GARDEN_STOCK_UNAVAILABLE");
      const price = entry.effect.price * action.quantity;
      if (price !== action.price) throw Error("GARDEN_PRICE_CHANGED");
      this.changeBalance(now, actor, action.kind, state, -price);
      this.grantMysteryBag(state, action.quantity);
      this.update(day, { ...entry, purchased });
      return { eventId: entry.id, price, quantity: action.quantity, purchased };
    }
    if (entry.kind !== "merchant") throw Error("GARDEN_EVENT_OFFER");
    if (action.kind === "merchant_buy_fertilizer") {
      const offer = entry.fertilizerOffers?.[0];
      if (!offer) throw Error("GARDEN_EVENT_OFFER");
      const price = offer.rate * action.quantity;
      if (price !== action.price) throw Error("GARDEN_PRICE_CHANGED");
      this.changeBalance(now, actor, action.kind, state, -price);
      state.fertilizer += action.quantity;
      return { eventId: entry.id, price, quantity: action.quantity };
    }
    if (action.kind === "merchant_buy") {
      const offer = entry.seedOffers.find(
        ({ cropId }) => cropId === action.cropId,
      );
      if (!offer) throw Error("GARDEN_EVENT_OFFER");
      const price = Math.round(offer.rate * action.quantity);
      if (price !== action.price) throw Error("GARDEN_PRICE_CHANGED");
      this.changeBalance(now, actor, action.kind, state, -price);
      state.seeds[action.cropId] =
        (Object.hasOwn(state.seeds, action.cropId)
          ? state.seeds[action.cropId]
          : 0) + action.quantity;
      return { eventId: entry.id, ...offer, price, quantity: action.quantity };
    }
    const lot = this.db
      .prepare("SELECT * FROM garden_harvests WHERE id=?")
      .get(action.harvestId);
    if (!lot || lot.quantity < action.quantity)
      throw Error("GARDEN_STOCK_UNAVAILABLE", {
        cause: {
          available: lot?.quantity ?? 0,
          lastUse: lot?.last_use ?? null,
        },
      });
    const offer = (entry.offers ?? (entry.offer ? [entry.offer] : [])).find(
      ({ cropId }) => cropId === lot.crop_id,
    );
    if (!offer) throw Error("GARDEN_EVENT_OFFER");
    const price = Math.round(offer.rates[lot.quality] * action.quantity);
    if (price !== action.price) throw Error("GARDEN_PRICE_CHANGED");
    this.changeBalance(now, actor, action.kind, state, price);
    this.db
      .prepare(
        "UPDATE garden_harvests SET quantity=quantity-?,last_use='sell' WHERE id=?",
      )
      .run(action.quantity, lot.id);
    return {
      eventId: entry.id,
      harvestId: lot.id,
      price,
      quantity: action.quantity,
    };
  }
}
