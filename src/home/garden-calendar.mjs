// @ts-check
import { GardenNeighbors } from "./garden-neighbors.mjs";
import { gardenPlantRef } from "./garden-journal.mjs";
import { GardenEvents } from "./garden-events.mjs";
import { randomUUID } from "node:crypto";
import { closePlantDay, DAY, HOUR, projectPlant } from "./garden-rules.mjs";
import {
  defaultWeather,
  drawWeather,
  weatherOdds,
  weatherTrialInput,
} from "./garden-weather.mjs";

/** @typedef {import("./garden-weather.mjs").GardenDay} GardenDay */
/** @typedef {ReturnType<import("./garden-service.mjs").GardenService["requireState"]>} State */

/** Calls that update the calendar run inside the garden service transaction. */
export class GardenCalendar {
  /** @param {import("node:sqlite").DatabaseSync} db
   * @param {(now:number, actor:import("./garden-service.mjs").Actor,action:string,state:State,delta:number)=>void} changeBalance
   * @param {import("./garden-journal.mjs").GardenJournal} journal
   */
  constructor(db, changeBalance, journal) {
    this.db = db;
    this.neighbors = new GardenNeighbors(db);
    this.journal = journal;
    this.events = new GardenEvents(db, changeBalance, journal);
  }

  /** @param {number} [before] @returns {GardenDay|null} */
  latest(before) {
    const row =
      before === undefined
        ? this.db
            .prepare("SELECT * FROM garden_days ORDER BY day DESC LIMIT 1")
            .get()
        : this.db
            .prepare(
              "SELECT * FROM garden_days WHERE day<? ORDER BY day DESC LIMIT 1",
            )
            .get(before);
    return row
      ? {
          day: Number(row.day),
          revision: Number(row.rules_revision),
          weather: JSON.parse(String(row.weather)),
          kindStreak: Number(row.kind_streak),
          idStreak: Number(row.id_streak),
        }
      : null;
  }

  /** @param {State} state @param {GardenDay|null} previous */
  drawContext(state, previous) {
    const harvests = Object.fromEntries(
      this.db
        .prepare(
          "SELECT crop_id,SUM(quantity) AS count FROM garden_harvests WHERE quantity>0 GROUP BY crop_id",
        )
        .all()
        .map((row) => [String(row.crop_id), Number(row.count)]),
    );
    return {
      previous,
      balance: state.balance,
      fertilizer: state.fertilizer,
      seeds: state.seeds,
      harvests,
      plots: state.plots,
      day: (previous?.day ?? 0) + 1,
    };
  }

  /** @param {State} state @param {unknown} input @param {boolean} [event] */
  trial(state, input, event = false) {
    const { todayId, day, ...params } = event
      ? this.events.trialInput(input)
      : {
          ...weatherTrialInput.parse(input),
          todayId: undefined,
          day: undefined,
        };
    const pool = state.settings.weather;
    const current = this.latest();
    let previous = event && current ? this.latest(current.day) : current;
    if (params.previousId !== undefined) {
      if (!Object.hasOwn(pool.entries, params.previousId))
        throw Error("INVALID_REQUEST");
      const weather = {
        ...pool.entries[params.previousId],
        id: params.previousId,
      };
      previous = {
        day: previous?.day ?? 0,
        revision: state.settingsRevision,
        weather,
        idStreak: params.streak ?? 1,
        kindStreak: params.streak ?? 1,
      };
    } else if (params.streak !== undefined) throw Error("INVALID_REQUEST");
    const ctx = {
      ...this.drawContext(state, previous),
      balance: params.balance ?? state.balance,
    };
    if (event)
      return this.events.trial(
        state,
        { ...ctx, day: day ?? current?.day ?? 1 },
        todayId,
        current?.weather,
      );
    return {
      previous: previous
        ? {
            id: previous.weather.id,
            kind: previous.weather.kind,
            name: previous.weather.name,
          }
        : null,
      ...weatherOdds(pool, ctx),
    };
  }

  /** @param {GardenDay} result */
  save(result) {
    this.db
      .prepare("INSERT INTO garden_days VALUES(?,?,?,?,?)")
      .run(
        result.day,
        result.revision,
        JSON.stringify(result.weather),
        result.kindStreak,
        result.idStreak,
      );
    return result;
  }

  /** @param {State} state @param {boolean} [legacy] */
  initialize(state, legacy = false) {
    // Legacy gardens used neutral weather. Preserve their clock and accrued growth.
    const seed = randomUUID();
    this.db.prepare("INSERT INTO garden_weather_seed VALUES (1,?)").run(seed);
    const day = Math.floor(state.clock / DAY) + 1;
    const weather = legacy
      ? { ...defaultWeather.entries.cloud, id: "cloud" }
      : drawWeather(
          state.settings.weather,
          this.drawContext(state, null),
          seed,
          day,
        );
    if (!legacy)
      this.events.draw(
        state,
        this.drawContext(state, null),
        weather,
        seed,
        day,
      );
    this.save({
      day,
      weather,
      revision: state.settingsRevision,
      kindStreak: 1,
      idStreak: 1,
    });
  }

  /** @param {GardenDay} current @param {number} elapsed */
  conditions(current, elapsed) {
    const event = this.events.get(current.day);
    const boundary =
      event?.kind === "weather_flip"
        ? (current.day - 1) * DAY + event.effect.hour * HOUR
        : Infinity;
    const weather =
      event?.kind === "weather_flip" && elapsed >= boundary
        ? event.targetWeather
        : current.weather;
    const slow =
      event?.kind === "nuisance" &&
      event.effect.effect === "aphids" &&
      event.status === "open"
        ? (event.effect.growthRate ?? 0.5)
        : 1;
    return { boundary, weather, slow };
  }

  /** @param {State} state @param {GardenDay} current @param {number} elapsed */
  project(state, current, elapsed) {
    const { boundary, weather, slow } = this.conditions(current, elapsed);
    state.plots = state.plots.map((entry) => {
      const original = entry.plant;
      if (!original) return entry;
      const ref = gardenPlantRef(entry.id, original);
      /** @type {NonNullable<Parameters<typeof projectPlant>[5]>} */
      const recordGrowth = (before, after, clock, clockPerGrowth) =>
        this.journal.growth(
          ref,
          original,
          before,
          after,
          clock,
          clockPerGrowth,
        );
      const beforeFlip =
        elapsed >= boundary && original.settledAt < boundary
          ? projectPlant(
              original,
              boundary,
              current.weather,
              entry.sheltered,
              slow,
              recordGrowth,
            )
          : original;
      const plant = projectPlant(
        beforeFlip,
        elapsed,
        weather,
        entry.sheltered,
        slow,
        recordGrowth,
      );
      if (plant.status === "withered" && original.status !== "withered")
        this.journal.record({
          type: "withered",
          clock: plant.settledAt,
          plants: [ref],
          source: "growth",
          key: `${plant.id}:withered`,
        });
      if (plant !== original) this.journal.updatePlant(plant);
      return { ...entry, plant };
    });
    return weather;
  }

  /** @param {State} state @param {number} elapsed @param {number} now */
  advance(state, elapsed, now) {
    let current = this.latest();
    if (!current) throw Error("GARDEN_NOT_INITIALIZED");
    const day = Math.floor(elapsed / DAY) + 1;
    if (current.day < day) {
      const seed = String(
        this.db.prepare("SELECT seed FROM garden_weather_seed WHERE id=1").get()
          ?.seed,
      );
      while (current.day < day) {
        const { weather, day: priorDay } = current;
        const closingWeather = this.project(state, current, priorDay * DAY);
        this.neighbors.settle(state, priorDay, priorDay * DAY, this.journal);
        state.plots = state.plots.map((entry) => {
          if (!entry.plant) return entry;
          const plant = closePlantDay(
            entry.plant,
            closingWeather,
            entry.sheltered,
          );
          if (plant.status === "withered" && entry.plant.status !== "withered")
            this.journal.record({
              type: "withered",
              clock: priorDay * DAY,
              plants: [gardenPlantRef(entry.id, plant)],
              source: "weather",
              key: `${plant.id}:withered`,
            });
          if (plant !== entry.plant) this.journal.updatePlant(plant);
          return { ...entry, plant };
        });
        this.events.close(priorDay, state, now);
        const ctx = this.drawContext(state, current);
        const next = drawWeather(
          state.settings.weather,
          ctx,
          seed,
          priorDay + 1,
        );
        this.events.draw(state, ctx, next, seed, priorDay + 1);
        current = this.save({
          day: priorDay + 1,
          revision: state.settingsRevision,
          weather: next,
          kindStreak: next.kind === weather.kind ? current.kindStreak + 1 : 1,
          idStreak: next.id === weather.id ? current.idStreak + 1 : 1,
        });
      }
      this.db
        .prepare(
          "UPDATE garden_state SET plots=?,clock=MAX(clock,?),balance=? WHERE id=1",
        )
        .run(
          JSON.stringify(state.plots),
          (current.day - 1) * DAY,
          state.balance,
        );
    }
    const effectiveWeather = this.project(state, current, elapsed);
    this.neighbors.settle(state, current.day, elapsed, this.journal);
    state.clock = elapsed;
    return { ...current, effectiveWeather };
  }
}
