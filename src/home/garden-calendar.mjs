// @ts-check
import { randomUUID } from "node:crypto";
import { closePlantDay, DAY, projectPlant } from "./garden-rules.mjs";
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
  /** @param {import("node:sqlite").DatabaseSync} db */
  constructor(db) {
    this.db = db;
  }

  /** @returns {GardenDay|null} */
  latest() {
    const row = this.db
      .prepare("SELECT * FROM garden_days ORDER BY day DESC LIMIT 1")
      .get();
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
    };
  }

  /** @param {State} state @param {unknown} input */
  trial(state, input) {
    const params = weatherTrialInput.parse(input);
    const pool = state.settings.weather;
    let previous = this.latest();
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
    const ctx = this.drawContext(state, previous);
    return {
      previous: previous
        ? {
            id: previous.weather.id,
            kind: previous.weather.kind,
            name: previous.weather.name,
          }
        : null,
      ...weatherOdds(pool, { ...ctx, balance: params.balance ?? ctx.balance }),
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
    this.save({
      day,
      weather,
      revision: state.settingsRevision,
      kindStreak: 1,
      idStreak: 1,
    });
  }

  /** @param {State} state @param {number} elapsed */
  advance(state, elapsed) {
    let current = this.latest();
    if (!current) throw Error("GARDEN_NOT_INITIALIZED");
    const day = Math.floor(elapsed / DAY) + 1;
    if (current.day < day) {
      const seed = String(
        this.db.prepare("SELECT seed FROM garden_weather_seed WHERE id=1").get()
          ?.seed,
      );
      const ctx = this.drawContext(state, current);
      while (current.day < day) {
        const { weather, day: priorDay } = current;
        state.plots = state.plots.map((entry) => ({
          ...entry,
          plant:
            entry.plant &&
            closePlantDay(
              projectPlant(
                entry.plant,
                priorDay * DAY,
                weather,
                entry.sheltered,
              ),
              weather,
              entry.sheltered,
            ),
        }));
        // Later events can change day-opening inventory before this next draw.
        ctx.previous = current;
        const next = drawWeather(
          state.settings.weather,
          ctx,
          seed,
          priorDay + 1,
        );
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
          "UPDATE garden_state SET plots=?,clock=MAX(clock,?) WHERE id=1",
        )
        .run(JSON.stringify(state.plots), (current.day - 1) * DAY);
    }
    state.plots = state.plots.map((entry) => ({
      ...entry,
      plant:
        entry.plant &&
        projectPlant(entry.plant, elapsed, current.weather, entry.sheltered),
    }));
    state.clock = elapsed;
    return current;
  }
}
