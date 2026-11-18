// @ts-check
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { canonical } from "../backends/session-contract.mjs";
import { GardenClock } from "./garden-clock.mjs";
import { GardenCalendar } from "./garden-calendar.mjs";
import { defaultWeather } from "./garden-weather.mjs";
import { defaultEvents } from "./garden-event-rules.mjs";
import {
  cropId,
  DAY,
  defaultGardenSettings,
  gardenSettings,
  PLOT_COUNT,
} from "./garden-rules.mjs";

const id = z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/);
const quantity = z.number().int().min(1).max(1_000_000);
const quotedPrice = z.number().int().min(0);
const plot = z.number().int().min(1).max(PLOT_COUNT);
const plantId = z.uuid();
const eventId = z.string().regex(/^\d+:[a-z][a-z0-9-]{0,39}$/);
const person = z.strictObject({ kind: z.enum(["admin", "agent"]), id });
const inputSchema = z.strictObject({
  requestId: z.string().regex(/^[A-Za-z0-9_-]{8,80}$/),
  action: z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("chase_thief"), eventId }),
    z.strictObject({
      kind: z.literal("merchant_buy"),
      eventId,
      cropId,
      quantity,
      price: quotedPrice,
    }),
    z.strictObject({
      kind: z.literal("merchant_sell"),
      eventId,
      harvestId: z.uuid(),
      quantity,
      price: quotedPrice,
    }),
    z.strictObject({ kind: z.enum(["shelter", "unshelter"]), plot }),
    z.strictObject({
      kind: z.literal("buy_seed"),
      cropId,
      quantity,
      price: quotedPrice,
    }),
    z.strictObject({
      kind: z.literal("buy_fertilizer"),
      quantity,
      price: quotedPrice,
    }),
    z.strictObject({
      kind: z.literal("plant"),
      plot,
      cropId,
      buyPrice: quotedPrice.optional(),
    }),
    z.strictObject({
      kind: z.enum(["water", "fertilize", "harvest", "clear"]),
      plot,
      plantId,
    }),
    z.strictObject({
      kind: z.literal("sell"),
      harvestId: z.uuid(),
      quantity,
      price: quotedPrice,
    }),
    z.strictObject({
      kind: z.literal("gift"),
      harvestId: z.uuid(),
      quantity,
      recipient: person,
    }),
  ]),
});

/** @typedef {import("./garden-rules.mjs").Settings} Settings */
/** @typedef {import("./garden-rules.mjs").Plant} Plant */
/** @typedef {{id: number, sheltered: boolean, plant: Plant | null}} Plot */
/** @typedef {{clock: number, revision: number, settingsRevision: number, settings: Settings,
 * balance: number, plots: Plot[], seeds: Record<string, number>, fertilizer: number}} State */
/** @typedef {{kind: "admin", id: string} | {kind: "agent", id: string, turnId: string}} Actor */
/** @typedef {ReturnType<typeof inputSchema.parse>["action"]} Action */
/** @typedef {{id: string, crop_id: string, planted_by: string,
 * quality: import("./garden-rules.mjs").Quality, quantity: number, harvested_at: number, last_use: string | null}} Harvest */

/** Shared garden persistence. Callers bind and authorize the actor before invoking it. */
export class GardenService {
  /** @param {{db: import("node:sqlite").DatabaseSync, transaction: <T>(fn: () => T) => T}} store */
  constructor(store) {
    this.store = store;
    this.db = store.db;
    this.calendar = new GardenCalendar(this.db, this.changeBalance.bind(this));
    const state = this.load();
    if (state && !this.calendar.latest())
      store.transaction(() => {
        if (!this.calendar.latest()) this.calendar.initialize(state, true);
      });
    this.clock = new GardenClock(state?.clock ?? 0, state?.settings.speed ?? 1);
    this.savedClock = this.clock.elapsed;
    this.enabled = state?.settings.enabled ?? false;
  }

  /** @returns {State | undefined} */
  load() {
    const row = this.db.prepare("SELECT * FROM garden_state WHERE id=1").get();
    if (!row) return;
    return {
      clock: Number(row.clock),
      revision: Number(row.revision),
      settingsRevision: Number(row.settings_revision),
      settings: {
        roles: {},
        delegationHours: 24,
        weather: defaultWeather,
        events: defaultEvents,
        ...JSON.parse(String(row.settings)),
      },
      balance: Number(row.balance),
      plots: JSON.parse(String(row.plots)),
      seeds: JSON.parse(String(row.seeds)),
      fertilizer: Number(row.fertilizer),
    };
  }

  /** @param {number} now @param {unknown} settings */
  initialize(now, settings = defaultGardenSettings()) {
    const data = gardenSettings.parse(settings);
    this.store.transaction(() => {
      if (this.load()) return;
      const plots = Array.from({ length: PLOT_COUNT }, (_, i) => ({
        id: i + 1,
        sheltered: false,
        plant: null,
      }));
      this.db
        .prepare("INSERT INTO garden_state VALUES(1,0,0,0,?,?,?,'{}',0)")
        .run(JSON.stringify(data), data.initialBalance, JSON.stringify(plots));
      this.calendar.initialize(this.requireState());
      this.recordLedger(
        now,
        { kind: "admin", id: "system" },
        "initialize",
        data.initialBalance,
        data.initialBalance,
      );
    });
    const state = this.requireState();
    this.enabled = state.settings.enabled;
    this.clock.speed = state.settings.speed;
    return this.read(now);
  }

  initialized() {
    return Boolean(
      this.db.prepare("SELECT 1 FROM garden_state WHERE id=1").get(),
    );
  }

  /** @param {string} roleId @param {string} generation */
  allowsRole(roleId, generation) {
    const row = this.db
      .prepare(
        "SELECT value FROM garden_state,json_each(settings,'$.roles') WHERE garden_state.id=1 AND key=?",
      )
      .get(roleId);
    return row?.value === generation;
  }

  /** @param {string} roleId @param {string} turnId */
  turnUsed(roleId, turnId) {
    return Number(
      this.db
        .prepare(
          "SELECT count(*) AS count FROM garden_actions WHERE actor_kind='agent' AND actor_id=? AND turn_id=?",
        )
        .get(roleId, turnId)?.count,
    );
  }

  requireState() {
    const current = this.load();
    if (!current) throw Error("GARDEN_NOT_INITIALIZED");
    return current;
  }

  /** @param {number} now @param {number} lease */
  desktopSync(now, lease) {
    if (!this.enabled) return;
    this.clock.observe(now, lease);
    // Use existing heartbeats, coalescing durable checkpoints during normal use.
    if (this.clock.elapsed - this.savedClock >= 15_000 * this.clock.speed)
      this.checkpoint();
  }

  /** @param {number} now */
  desktopStop(now) {
    this.clock.stop(now);
    this.checkpoint();
  }

  checkpoint() {
    if (this.clock.elapsed <= this.savedClock) return;
    this.db
      .prepare("UPDATE garden_state SET clock=MAX(clock,?) WHERE id=1")
      .run(this.clock.elapsed);
    this.savedClock = this.clock.elapsed;
  }

  /** @param {number} now @param {number} expectedRevision @param {unknown} input */
  configure(now, expectedRevision, input) {
    const settings = this.store.transaction(() => {
      const current = this.requireState();
      const next = gardenSettings.parse(
        input && typeof input === "object"
          ? {
              weather: current.settings.weather,
              events: current.settings.events,
              ...input,
            }
          : input,
      );
      if (current.settingsRevision !== expectedRevision)
        throw Error("GARDEN_SETTINGS_CONFLICT");
      if (
        Object.keys(current.settings.crops).some(
          (key) => !Object.hasOwn(next.crops, key),
        )
      )
        throw Error("GARDEN_CROP_ID_REMOVED");
      this.calendar.advance(
        current,
        Math.max(current.clock, this.clock.elapsedAt(now)),
        now,
      );
      this.db
        .prepare(
          "UPDATE garden_state SET clock=MAX(clock,?),settings_revision=settings_revision+1,settings=? WHERE id=1",
        )
        .run(this.clock.elapsedAt(now), JSON.stringify(next));
      return next;
    });
    this.clock.advance(now);
    if (!settings.enabled) this.clock.stop(now);
    this.savedClock = this.clock.elapsed;
    this.enabled = settings.enabled;
    this.clock.speed = settings.speed;
    return this.read(now);
  }

  /** @param {number} now @param {boolean} [live] @param {Actor} [visitorActor] */
  snapshot(now, live = true, visitorActor) {
    const read = () => {
      const state = this.requireState();
      // Retain observed progress without extending the desktop lease.
      if (live) this.clock.advance(now);
      const elapsed = Math.max(state.clock, this.clock.elapsed);
      const current = this.calendar.advance(state, elapsed, now);
      const running = this.enabled && this.clock.running(now);
      const event =
        running && visitorActor
          ? this.calendar.events.claimVisitor(current.day, visitorActor, state)
          : this.calendar.events.get(current.day);
      return {
        ...state,
        event,
        fertilizerCredits: this.calendar.events.credits(),
        running,
        day: current.day,
        dayRemaining: DAY - (elapsed % DAY),
        weather: current.weather,
        weatherRevision: current.revision,
      };
    };
    return this.db.isTransaction ? read() : this.store.transaction(read);
  }

  /** @param {number} now @param {Actor} [visitorActor] */
  read(now, visitorActor) {
    return {
      ...this.snapshot(now, true, visitorActor),
      harvests: this.db
        .prepare(
          "SELECT * FROM garden_harvests WHERE quantity>0 ORDER BY rowid",
        )
        .all(),
      ledger: this.db
        .prepare("SELECT * FROM garden_ledger ORDER BY seq DESC LIMIT 50")
        .all(),
      activity: this.db
        .prepare(
          "SELECT actor_kind,actor_id,action,at,result FROM garden_actions ORDER BY seq DESC LIMIT 50",
        )
        .all()
        .map(({ result, ...entry }) => ({
          ...entry,
          result: JSON.parse(String(result)),
        })),
      gifts: this.db
        .prepare(
          "SELECT g.*, h.crop_id, h.quality FROM garden_gifts g JOIN garden_harvests h ON h.id=g.harvest_id ORDER BY g.rowid DESC LIMIT 50",
        )
        .all(),
    };
  }

  /** @param {number} now @param {Actor} actor @param {unknown} input @param {(action: Action) => void} [validate] @param {(recipient:{kind:"admin"|"agent",id:string},result:{giftId:string,cropId:string,quantity:number})=>void} [onGift] */
  act(now, actor, input, validate, onGift) {
    const { requestId, action } = inputSchema.parse(input);
    const turnId = actor.kind === "agent" ? actor.turnId : null;
    const digest = createHash("sha256")
      .update(JSON.stringify(canonical(action)))
      .digest("hex");
    const write = () => {
      const prior = this.db
        .prepare(
          "SELECT digest,result FROM garden_actions WHERE actor_kind=? AND actor_id=? AND request_id=?",
        )
        .get(actor.kind, actor.id, requestId);
      if (prior) {
        if (prior.digest !== digest) throw Error("GARDEN_REQUEST_CONFLICT");
        return { ...JSON.parse(String(prior.result)), replayed: true };
      }
      const state = this.requireState();
      if (!state.settings.enabled || !this.clock.running(now))
        throw Error("GARDEN_PAUSED");
      if (actor.kind === "agent") {
        if (!turnId) throw Error("GARDEN_TURN_REQUIRED");
        if (this.turnUsed(actor.id, turnId) >= state.settings.turnLimit)
          throw Error("GARDEN_TURN_LIMIT");
      }
      this.calendar.advance(
        state,
        Math.max(state.clock, this.clock.elapsedAt(now)),
        now,
      );
      validate?.(action);
      const result = this.apply(now, actor, action, state);
      if (
        action.kind === "gift" &&
        "giftId" in result &&
        result.giftId &&
        "cropId" in result &&
        result.cropId
      )
        onGift?.(
          action.recipient,
          /** @type {{giftId:string,cropId:string,quantity:number}} */ (result),
        );
      this.db
        .prepare(
          "UPDATE garden_state SET clock=?,revision=revision+1,balance=?,plots=?,seeds=?,fertilizer=? WHERE id=1",
        )
        .run(
          state.clock,
          state.balance,
          JSON.stringify(state.plots),
          JSON.stringify(state.seeds),
          state.fertilizer,
        );
      const receipt = {
        action: action.kind,
        revision: state.revision + 1,
        balance: state.balance,
        ...result,
      };
      this.db
        .prepare(
          "INSERT INTO garden_actions(actor_kind,actor_id,turn_id,request_id,action,at,digest,result) VALUES(?,?,?,?,?,?,?,?)",
        )
        .run(
          actor.kind,
          actor.id,
          turnId,
          requestId,
          action.kind,
          now,
          digest,
          JSON.stringify(receipt),
        );
      return { ...receipt, replayed: false };
    };
    // A delegated action and its progress receipt are committed by the same caller.
    if (this.db.isTransaction) return write();
    const response = this.store.transaction(write);
    if (!response.replayed) {
      this.clock.advance(now);
      this.savedClock = this.clock.elapsed;
    }
    return response;
  }

  /** @param {number} now @param {Actor} actor @param {Action} action @param {State} state */
  apply(now, actor, action, state) {
    const rules = state.settings;
    switch (action.kind) {
      case "merchant_buy":
      case "merchant_sell":
      case "chase_thief":
        return this.calendar.events.perform(
          Math.floor(state.clock / DAY) + 1,
          now,
          actor,
          action,
          state,
        );
      case "buy_seed": {
        const crop = this.getCrop(rules, action.cropId);
        if (!crop.market || !crop.enabled)
          throw Error("GARDEN_SEED_UNAVAILABLE");
        const price = crop.seedPrice * action.quantity;
        if (price !== action.price) throw Error("GARDEN_PRICE_CHANGED");
        this.changeBalance(now, actor, action.kind, state, -price);
        state.seeds[action.cropId] =
          this.seedCount(state, action.cropId) + action.quantity;
        return { cropId: action.cropId, quantity: action.quantity };
      }
      case "buy_fertilizer": {
        const price = rules.fertilizerPrice * action.quantity;
        if (price !== action.price) throw Error("GARDEN_PRICE_CHANGED");
        this.changeBalance(now, actor, action.kind, state, -price);
        state.fertilizer += action.quantity;
        return { quantity: action.quantity };
      }
      case "sell":
      case "gift":
        return this.useHarvest(now, actor, action, state);
      default: {
        const entry = state.plots[action.plot - 1];
        if (action.kind === "plant")
          return this.plant(now, actor, action, entry, state);
        if (action.kind === "shelter" || action.kind === "unshelter") {
          const sheltered = action.kind === "shelter";
          if (entry.sheltered === sheltered)
            throw Error("GARDEN_SHELTER_UNCHANGED");
          entry.sheltered = sheltered;
          return { plot: entry.id, sheltered };
        }
        if (
          !("plantId" in action) ||
          !entry.plant ||
          entry.plant.id !== action.plantId
        )
          throw Error("GARDEN_PLANT_CHANGED");
        const plant = entry.plant;
        switch (action.kind) {
          case "water":
            if (plant.status !== "growing") throw Error("GARDEN_PLANT_STATE");
            if (plant.water >= 100) throw Error("GARDEN_WATER_FULL");
            plant.water = Math.min(100, plant.water + plant.rules.watering);
            plant.dry = 0;
            return { plot: entry.id, plantId: plant.id, water: plant.water };
          case "fertilize": {
            if (plant.status !== "growing") throw Error("GARDEN_PLANT_STATE");
            if (plant.fertilizer >= plant.crop.fertilizer)
              throw Error("GARDEN_FERTILIZER_FULL");
            const usedCredit = this.calendar.events.useCredit();
            if (!usedCredit) {
              if (!state.fertilizer) throw Error("GARDEN_STOCK_UNAVAILABLE");
              state.fertilizer--;
            }
            plant.fertilizer++;
            return {
              plot: entry.id,
              plantId: plant.id,
              fertilizer: plant.fertilizer,
              ...(usedCredit && { usedCredit }),
            };
          }
          case "harvest": {
            if (plant.status !== "mature" || !plant.quality)
              throw Error("GARDEN_PLANT_STATE");
            const harvestId = randomUUID();
            this.db
              .prepare("INSERT INTO garden_harvests VALUES(?,?,?,?,?,?,NULL)")
              .run(
                harvestId,
                plant.cropId,
                plant.actorId,
                plant.quality,
                plant.crop.yield,
                now,
              );
            entry.plant = null;
            return {
              plot: entry.id,
              plantId: plant.id,
              harvestId,
              quality: plant.quality,
              quantity: plant.crop.yield,
            };
          }
          case "clear":
            if (plant.status !== "withered") throw Error("GARDEN_PLANT_STATE");
            entry.plant = null;
            return { plot: entry.id, plantId: plant.id };
        }
      }
    }
  }

  /** @param {State} state @param {string} key */
  seedCount(state, key) {
    return Object.hasOwn(state.seeds, key) ? state.seeds[key] : 0;
  }

  /** @param {Settings} settings @param {string} key */
  getCrop(settings, key) {
    if (!Object.hasOwn(settings.crops, key)) throw Error("GARDEN_CROP_UNKNOWN");
    return settings.crops[key];
  }

  /** @param {number} now @param {Actor} actor @param {Extract<Action, {kind:"plant"}>} action @param {Plot} entry @param {State} state */
  plant(now, actor, action, entry, state) {
    if (entry.plant) throw Error("GARDEN_PLOT_OCCUPIED");
    const crop = this.getCrop(state.settings, action.cropId);
    if (!crop.enabled) throw Error("GARDEN_SEED_UNAVAILABLE");
    const count = this.seedCount(state, action.cropId);
    if (count) {
      state.seeds[action.cropId] = count - 1;
    } else {
      if (
        !crop.market ||
        (action.buyPrice === undefined && crop.seedPrice !== 0)
      )
        throw Error("GARDEN_SEED_UNAVAILABLE");
      if ((action.buyPrice ?? 0) !== crop.seedPrice)
        throw Error("GARDEN_PRICE_CHANGED");
      this.changeBalance(
        now,
        actor,
        "buy_seed_and_plant",
        state,
        -crop.seedPrice,
      );
    }
    const {
      crops: _crops,
      roles: _roles,
      weather: _weather,
      events: _events,
      delegationHours: _delegationHours,
      enabled: _enabled,
      speed: _speed,
      turnLimit: _turnLimit,
      initialBalance: _initialBalance,
      fertilizerPrice: _price,
      ...rules
    } = state.settings;
    const plantId = randomUUID();
    entry.plant = {
      id: plantId,
      cropId: action.cropId,
      actorId: actor.id,
      plantedAt: now,
      settledAt: state.clock,
      water: rules.startingWater,
      growth: 0,
      dry: 0,
      low: 0,
      fertilizer: 0,
      status: "growing",
      quality: null,
      crop,
      rules,
    };
    return { plot: entry.id, plantId };
  }

  /** @param {number} now @param {Actor} actor @param {Extract<Action, {kind:"sell"|"gift"}>} action @param {State} state */
  useHarvest(now, actor, action, state) {
    const harvest = /** @type {Harvest | undefined} */ (
      this.db
        .prepare("SELECT * FROM garden_harvests WHERE id=?")
        .get(action.harvestId)
    );
    if (!harvest || harvest.quantity < action.quantity)
      throw Error("GARDEN_STOCK_UNAVAILABLE", {
        cause: {
          available: harvest?.quantity ?? 0,
          lastUse: harvest?.last_use ?? null,
        },
      });
    let giftId;
    if (action.kind === "sell") {
      const crop = this.getCrop(state.settings, harvest.crop_id);
      const multiplier =
        harvest.quality === "perfect"
          ? state.settings.perfectMultiplier
          : harvest.quality === "fine"
            ? state.settings.fineMultiplier
            : 1;
      const price = Math.round(crop.salePrice * multiplier * action.quantity);
      if (price !== action.price) throw Error("GARDEN_PRICE_CHANGED");
      this.changeBalance(now, actor, "sell", state, price);
    } else {
      giftId = randomUUID();
      this.db
        .prepare("INSERT INTO garden_gifts VALUES(?,?,?,?,?,?,?,?)")
        .run(
          giftId,
          now,
          harvest.id,
          actor.kind,
          actor.id,
          action.recipient.kind,
          action.recipient.id,
          action.quantity,
        );
    }
    this.db
      .prepare(
        "UPDATE garden_harvests SET quantity=quantity-?,last_use=? WHERE id=?",
      )
      .run(action.quantity, action.kind, harvest.id);
    return {
      harvestId: harvest.id,
      quantity: action.quantity,
      ...(giftId && { giftId, cropId: harvest.crop_id }),
    };
  }

  /** @param {number} now @param {Actor} actor @param {string} action @param {State} state @param {number} delta */
  changeBalance(now, actor, action, state, delta) {
    if (!delta) return;
    const balance = state.balance + delta;
    if (balance < 0) throw Error("GARDEN_BALANCE_LOW");
    if (!Number.isSafeInteger(balance)) throw Error("GARDEN_BALANCE_OVERFLOW");
    this.recordLedger(now, actor, action, delta, balance);
    state.balance = balance;
  }

  /** @param {number} now @param {Actor} actor @param {string} action @param {number} delta @param {number} balance */
  recordLedger(now, actor, action, delta, balance) {
    this.db
      .prepare(
        "INSERT INTO garden_ledger(at,actor_kind,actor_id,action,delta,balance) VALUES(?,?,?,?,?,?)",
      )
      .run(now, actor.kind, actor.id, action, delta, balance);
  }
}
