import { drawGardenEvent, eventOdds } from "./garden-event-rules.mjs";
import { poolEntryId, weatherTrialInput } from "./garden-weather.mjs";

const system = { kind: "admin", id: "system" };
const trial = weatherTrialInput.extend({ todayId: poolEntryId.optional() });

/** @typedef {{id:string,name:string,status:"open"|"expired"|"claimed"|"chased"|"missed"}} EventBase */
/** @typedef {EventBase & (
 * {kind:"merchant",seedOffers:{cropId:string,name:string,rate:number}[],offer:{cropId:string,name:string,premium:number,rates:Record<string,number>}} |
 * {kind:"thief",reward:number,coinLoss:number,cropLoss:number} |
 * {kind:"visitor",reward:{kind:"seed",cropId:string,quantity:number}|{kind:"fertilizer"|"fertilizer_credit",quantity:number}}
 * )} GardenEvent */
export class GardenEvents {
  constructor(db, changeBalance) {
    this.db = db;
    this.changeBalance = changeBalance;
  }

  /** @param {number} day @returns {GardenEvent|null} */
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
    this.db
      .prepare("INSERT INTO garden_events(day,value) VALUES(?,?)")
      .run(day, JSON.stringify(entry));
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
      ...eventOdds(state.settings.events, ctx, today),
    };
  }

  close(day, state, now) {
    const entry = this.get(day);
    if (!entry || entry.status !== "open") return;
    let outcome;
    if (entry.kind === "thief") {
      const lot = this.db
        .prepare(
          "SELECT id,crop_id,quantity FROM garden_harvests WHERE quantity>0 ORDER BY rowid LIMIT 1",
        )
        .get();
      if (lot) {
        const quantity = Math.min(lot.quantity, entry.cropLoss);
        this.db
          .prepare(
            "UPDATE garden_harvests SET quantity=quantity-?,last_use='thief' WHERE id=?",
          )
          .run(quantity, lot.id);
        outcome = { harvestId: lot.id, cropId: lot.crop_id, quantity };
      } else {
        const coins = Math.min(state.balance, entry.coinLoss);
        this.changeBalance(now, system, "thief_loss", state, -coins);
        outcome = { coins };
      }
    }
    this.update(day, {
      ...entry,
      status: entry.kind === "thief" ? "missed" : "expired",
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
    return claimed;
  }

  perform(day, now, actor, action, state) {
    const entry = this.get(day);
    if (!entry || entry.id !== action.eventId)
      throw Error("GARDEN_EVENT_EXPIRED");
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
    if (entry.kind !== "merchant") throw Error("GARDEN_EVENT_OFFER");
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
    if (lot.crop_id !== entry.offer.cropId) throw Error("GARDEN_EVENT_OFFER");
    const price = Math.round(entry.offer.rates[lot.quality] * action.quantity);
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
