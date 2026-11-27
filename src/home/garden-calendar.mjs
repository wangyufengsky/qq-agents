// @ts-check
import { GARDEN_NIGHT_START, GardenNeighbors } from "./garden-neighbors.mjs";
import { gardenPlantRef } from "./garden-journal.mjs";
import { GardenEvents } from "./garden-events.mjs";
import { settleGardenRumors } from "./garden-companion.mjs";
import { hasGardenFacility } from "./garden-facilities.mjs";
import { randomUUID } from "node:crypto";
import {
  adjustPlantQuality,
  CHAMOMILE,
  closePlantDay,
  DAY,
  HOUR,
  neighborBuffs,
  projectPlant,
} from "./garden-rules.mjs";
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
    const livePlantIds = state.plots.flatMap(({ plant }) =>
      plant && plant.status !== "withered" ? [plant.id] : [],
    );
    const caretakers = Object.fromEntries(
      this.db
        .prepare(
          `SELECT json_extract(ref.value,'$.plantId') AS plantId,
        json_group_array(DISTINCT fact.actor_kind || ':' || fact.actor_id) AS people
       FROM garden_facts fact, json_each(fact.plants) ref
       WHERE fact.type IN ('planted','water','fertilize') AND fact.actor_id IS NOT NULL
       AND json_extract(ref.value,'$.plantId') IN (SELECT value FROM json_each(?))
       GROUP BY plantId`,
        )
        .all(JSON.stringify(livePlantIds))
        .map(({ plantId, people }) => [
          String(plantId),
          JSON.parse(String(people)),
        ]),
    );
    return {
      previous,
      balance: state.balance,
      fertilizer: state.fertilizer,
      seeds: state.seeds,
      harvests,
      caretakers,
      birdBath: hasGardenFacility(this.db, "bird_bath"),
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
    const pausedPlot =
      event?.kind === "choice" && event.status === "resolved"
        ? event.outcome?.pausedPlot
        : undefined;
    return { boundary, weather, slow, pausedPlot };
  }

  /** @param {State} state @param {GardenDay} current @param {number} elapsed */
  project(state, current, elapsed) {
    const { boundary, weather, slow, pausedPlot } = this.conditions(
      current,
      elapsed,
    );
    if (elapsed >= boundary)
      this.projectSegment(state, boundary, current.weather, slow);
    const nightfall = (current.day - 1) * DAY + GARDEN_NIGHT_START;
    if (elapsed >= nightfall && this.fullMoon(current.day)) {
      this.projectSegment(state, nightfall, weather, slow, pausedPlot);
      this.blessFullMoon(state, current.day, nightfall);
    }
    this.projectSegment(state, elapsed, weather, slow, pausedPlot);
    return weather;
  }

  /** @param {State} state @param {number} elapsed @param {import("./garden-weather.mjs").Weather} weather @param {number} slow @param {number} [pausedPlot] */
  projectSegment(state, elapsed, weather, slow, pausedPlot) {
    // Protection starts at the exact maturity crossing, even after a long offline jump.
    let until = elapsed;
    for (const { id, plant, sheltered } of state.plots) {
      if (
        id === pausedPlot ||
        plant?.cropId !== CHAMOMILE ||
        plant.status !== "growing" ||
        plant.settledAt >= until
      )
        continue;
      const preview = projectPlant(
        plant,
        until,
        weather,
        sheltered,
        slow,
        undefined,
        neighborBuffs(state, id).length > 0,
      );
      if (preview.maturedAt !== undefined && preview.status === "mature")
        until = Math.max(plant.settledAt + 0.001, preview.maturedAt);
    }
    until = Math.min(elapsed, until);
    state.plots = state.plots.map((entry) => {
      const original = entry.plant;
      if (!original || original.settledAt >= until) return entry;
      const ref = gardenPlantRef(entry.id, original);
      const plant =
        pausedPlot === entry.id && original.status === "growing"
          ? { ...original, settledAt: until }
          : projectPlant(
              original,
              until,
              weather,
              entry.sheltered,
              slow,
              (before, after, clock, clockPerGrowth, projected) =>
                this.journal.growth(
                  ref,
                  projected,
                  before,
                  after,
                  clock,
                  clockPerGrowth,
                ),
              neighborBuffs(state, entry.id).length > 0,
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
    if (until < elapsed)
      this.projectSegment(state, elapsed, weather, slow, pausedPlot);
  }

  /** @param {State} state @param {number} day @param {number} nightfall */
  blessFullMoon(state, day, nightfall) {
    for (const { plant } of state.plots) {
      if (
        plant?.status !== "growing" ||
        plant.crop.light !== "shade" ||
        plant.settledAt > nightfall ||
        plant.sownClock === nightfall ||
        plant.fullMoonDay === day
      )
        continue;
      adjustPlantQuality(plant, 15);
      // A clock-only checkpoint can replay from the original plot, while an
      // action can persist the blessing in its plot snapshot at nightfall.
      plant.fullMoonDay = day;
      this.journal.updatePlant(plant);
    }
  }

  /** @param {number} day */
  fullMoon(day) {
    const event = this.events.get(day);
    return event?.kind === "story" && event.effect.story === "full_moon";
  }

  /** @param {State} state @param {GardenDay} current @param {number} elapsed @param {number} now */
  settleNeighbors(state, current, elapsed, now) {
    const { weather, boundary } = this.conditions(current, elapsed);
    this.neighbors.settle(state, current.day, elapsed, this.journal, now, {
      before: current.weather.kind,
      after: weather.kind,
      boundary,
      fullMoon: this.fullMoon(current.day),
      previousFullMoon: this.fullMoon(current.day - 1),
    });
  }

  /** @param {State} state @param {GardenDay} current @param {number} now @param {boolean} [preview] */
  closeDay(state, current, now, preview = false) {
    const priorDay = current.day;
    const closingWeather = this.project(state, current, priorDay * DAY);
    this.settleNeighbors(state, current, priorDay * DAY, now);
    const { pausedPlot } = this.conditions(current, priorDay * DAY);
    state.plots = state.plots.map((entry) => {
      if (!entry.plant || entry.id === pausedPlot) return entry;
      const plant = closePlantDay(entry.plant, closingWeather, entry.sheltered);
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
    this.events.settleFollowups(priorDay + 1, state, now, !preview);
    const context = this.drawContext(state, current);
    return { context, next: this.drawNextWeather(state, current, context) };
  }

  /** @param {State} state @param {GardenDay} current @param {ReturnType<GardenCalendar["drawContext"]>} context */
  drawNextWeather(state, current, context) {
    return drawWeather(
      state.settings.weather,
      context,
      this.neighbors.seed(),
      current.day + 1,
    );
  }

  /** @param {State} state @param {GardenDay} current */
  forecast(state, current) {
    const usesTallies = Object.values(state.settings.weather.entries).some(
      ({ enabled, conditions }) =>
        enabled &&
        conditions.some(
          ({ field }) =>
            field === "balance" ||
            field === "fertilizer" ||
            field === "seed" ||
            field === "harvest",
        ),
    );
    if (!usesTallies)
      return this.drawNextWeather(
        state,
        current,
        this.drawContext(state, current),
      );

    // Only a mutable-condition pool needs to simulate the automatic rollover.
    // Roll back all preview writes and suppress the observer callback.
    this.db.exec("SAVEPOINT garden_weather_preview");
    try {
      return this.closeDay(structuredClone(state), current, 0, true).next;
    } finally {
      this.db.exec(
        "ROLLBACK TO garden_weather_preview; RELEASE garden_weather_preview",
      );
    }
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
        const { context, next } = this.closeDay(state, current, now);
        this.events.draw(state, context, next, seed, priorDay + 1);
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
    this.settleNeighbors(state, current, elapsed, now);
    state.clock = elapsed;
    settleGardenRumors(this.db, this.journal, current.day, now);
    return { ...current, effectiveWeather };
  }
}
