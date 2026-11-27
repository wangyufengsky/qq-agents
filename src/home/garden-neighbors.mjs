// @ts-check
import { GardenAlmanac } from "./garden-almanac.mjs";
import { createHash } from "node:crypto";
import { gardenPlantRef } from "./garden-journal.mjs";
import {
  adjacentPlots,
  CATNIP,
  DAY,
  HOUR,
  MISTBELL,
  SUNBERRY,
} from "./garden-rules.mjs";

/** @typedef {ReturnType<import("./garden-service.mjs").GardenService["requireState"]>} State */
/** @typedef {Omit<State["plots"][number], "plant"> & {plant: import("./garden-rules.mjs").Plant}} PlantedPlot */

export const GARDEN_NIGHT_START = 19 * HOUR;
const nightEnd = 6 * HOUR;
const minimumAge = 48 * HOUR;
const recipes = /** @type {const} */ ({
  [MISTBELL]: {
    parents: ["moonflower", CATNIP],
    hint: "蓝紫色花粉",
    source: "night",
  },
  [SUNBERRY]: {
    parents: ["sunflower", "strawberry"],
    hint: "金色花粉",
    source: "day",
  },
});

/** @param {State} state @param {(typeof recipes)[keyof typeof recipes]["parents"]} parents */
function neighborPairs(state, parents) {
  /** @type {Array<[PlantedPlot,PlantedPlot]>} */
  const pairs = [];
  for (const left of state.plots) {
    if (left.plant?.cropId !== parents[0] || left.plant.status !== "mature")
      continue;
    for (const right of state.plots) {
      if (right.plant?.cropId !== parents[1] || right.plant.status !== "mature")
        continue;
      if (!adjacentPlots(left.id, right.id)) continue;
      pairs.push([
        { ...left, plant: left.plant },
        { ...right, plant: right.plant },
      ]);
    }
  }
  return pairs;
}

/** @param {PlantedPlot[]} pair */
function pairId(pair) {
  return pair
    .map(({ plant }) => plant.id)
    .sort()
    .join(":");
}

/** @param {string} seed @param {string} lane @param {number} day @param {number} [chance] */
function trial(seed, lane, day, chance = 1 / 3) {
  return (
    createHash("sha256")
      .update(JSON.stringify([seed, lane, day]))
      .digest()
      .readUInt32BE() <
    0x100000000 * chance
  );
}

/** @param {import("./garden-rules.mjs").Plant} plant */
function eligibleSince(plant) {
  const mature = plant.maturedAt ?? plant.settledAt;
  // Older plants carry wall-clock plantedAt. New parents also store their garden clock.
  return Math.max(
    mature,
    plant.sownClock === undefined ? mature : plant.sownClock + minimumAge,
  );
}

export class GardenNeighbors {
  /** @param {import("node:sqlite").DatabaseSync} db */
  constructor(db) {
    this.db = db;
  }

  /** @param {string} id */
  status(id) {
    return this.db
      .prepare(
        "SELECT attempts,night,discovered FROM garden_neighbor_pairs WHERE pair=?",
      )
      .get(id);
  }

  seed() {
    return String(
      this.db.prepare("SELECT seed FROM garden_weather_seed WHERE id=1").get()
        ?.seed,
    );
  }

  /** @param {State} state @param {number} day @param {number} elapsed @param {import("./garden-journal.mjs").GardenJournal} journal @param {number} now
   * @param {{before:import("./garden-weather.mjs").Weather["kind"],after:import("./garden-weather.mjs").Weather["kind"],boundary:number,fullMoon?:boolean,previousFullMoon?:boolean}} weather */
  settle(state, day, elapsed, journal, now, weather) {
    const dawn = (day - 1) * DAY;
    const dayEnd = day * DAY;
    const daylightStart = dawn + nightEnd;
    const daylightEnd = dawn + 17 * HOUR;
    // A dawn window belongs to the night that began the previous day.
    const nightWindows = [
      {
        trialDay: day - 1,
        start: dawn,
        end: daylightStart,
        boosted: weather.previousFullMoon,
      },
      {
        trialDay: day,
        start: dawn + GARDEN_NIGHT_START,
        end: dayEnd,
        boosted: weather.fullMoon,
      },
    ];
    const sunWindows = [
      {
        kind: weather.before,
        start: daylightStart,
        end: Math.min(daylightEnd, weather.boundary),
      },
      {
        kind: weather.after,
        start: Math.max(daylightStart, weather.boundary),
        end: daylightEnd,
      },
    ]
      .filter(({ kind, start, end }) => kind === "sun" && start < end)
      .map(({ start, end }) => ({ trialDay: day, start, end }));
    for (const [cropId, recipe] of Object.entries(recipes)) {
      if (!state.settings.crops[cropId].enabled) continue;
      this.settleRecipe(
        state,
        elapsed,
        journal,
        now,
        cropId,
        recipe,
        cropId === MISTBELL ? nightWindows : sunWindows,
      );
    }
  }

  /** @param {State} state @param {number} elapsed @param {import("./garden-journal.mjs").GardenJournal} journal @param {number} now
   * @param {string} cropId @param {(typeof recipes)[keyof typeof recipes]} recipe
   * @param {{trialDay:number,start:number,end:number,boosted?:boolean}[]} windows */
  settleRecipe(state, elapsed, journal, now, cropId, recipe, windows) {
    const pairs = neighborPairs(state, recipe.parents);
    if (!pairs.length || !windows.length) return;
    const seed = this.seed();
    for (const pair of pairs) {
      const id =
        cropId === MISTBELL ? pairId(pair) : `${cropId}:${pairId(pair)}`;
      const ready = Math.max(...pair.map(({ plant }) => eligibleSince(plant)));
      let status = this.status(id);
      for (const { trialDay, start, end, boosted } of windows) {
        const at = Math.max(ready, start);
        if (
          !trialDay ||
          at >= end ||
          at > elapsed ||
          status?.discovered ||
          Number(status?.night ?? 0) >= trialDay
        )
          continue;
        const attempts = Number(status?.attempts ?? 0) + 1;
        const discovered = Number(
          attempts === 3 || trial(seed, id, trialDay, boosted ? 2 / 3 : 1 / 3),
        );
        this.db
          .prepare(
            `
          INSERT INTO garden_neighbor_pairs VALUES (?,?,?,?)
          ON CONFLICT(pair) DO UPDATE SET attempts=excluded.attempts,night=excluded.night,discovered=excluded.discovered
        `,
          )
          .run(id, attempts, trialDay, discovered);
        status = { attempts, night: trialDay, discovered };
        if (discovered) {
          state.revision++;
          state.seeds[cropId] = (state.seeds[cropId] ?? 0) + 1;
          this.db
            .prepare(
              "UPDATE garden_state SET seeds=?,clock=MAX(clock,?),revision=revision+1 WHERE id=1",
            )
            .run(JSON.stringify(state.seeds), at);
        }
        if (discovered || attempts === 1) {
          const phase = discovered ? "seed" : "pollen";
          const plants = pair.map(({ id, plant }) => gardenPlantRef(id, plant));
          journal.record({
            type: "discovery",
            clock: at,
            plants,
            source: recipe.source,
            detail: discovered
              ? {
                  cropId,
                  name: state.settings.crops[cropId].name,
                  phase,
                }
              : { phase, hint: recipe.hint },
            key: `neighbors:${id}:${phase}`,
          });
          if (discovered)
            new GardenAlmanac(this.db, journal).record(
              { ...state, clock: at },
              now,
              cropId,
              plants,
              { kind: "discover" },
            );
        }
      }
    }
  }

  /** @param {State} state @param {import("./garden-weather.mjs").Weather["kind"]} weather @param {boolean} [birdBath] */
  view(state, weather, birdBath = false) {
    const day = Math.floor(state.clock / DAY) + 1;
    const hour = state.clock % DAY;
    const period =
      hour >= GARDEN_NIGHT_START || hour < nightEnd
        ? "night"
        : hour >= 17 * HOUR
          ? "dusk"
          : "day";
    const seed = this.seed();
    return {
      nightScene: {
        period,
        stars:
          period === "night"
            ? weather === "sun"
              ? "clear"
              : weather === "cloud"
                ? "sparse"
                : "none"
            : "none",
        butterflies:
          period === "dusk" &&
          (weather === "sun" || weather === "cloud") &&
          state.plots.some(
            ({ plant }) =>
              plant?.cropId === CATNIP && plant.status === "mature",
          ) &&
          trial(seed, "butterflies", day, birdBath ? 0.5 : 1 / 3),
        fireflies:
          period === "night" &&
          (weather === "sun" || weather === "cloud") &&
          trial(seed, "fireflies", hour < nightEnd ? day - 1 : day),
      },
      pollenPairs: Object.entries(recipes).flatMap(([cropId, recipe]) =>
        neighborPairs(state, recipe.parents).flatMap((pair) => {
          const id =
            cropId === MISTBELL ? pairId(pair) : `${cropId}:${pairId(pair)}`;
          const status = this.status(id);
          return status && !status.discovered
            ? [{ plots: pair.map(({ id }) => id), hint: recipe.hint }]
            : [];
        }),
      ),
      sunberryDiscovered: Boolean(
        this.db
          .prepare(
            "SELECT 1 FROM garden_neighbor_pairs WHERE discovered=1 AND pair LIKE 'sunberry:%' LIMIT 1",
          )
          .get(),
      ),
      mistbellDiscovered: Boolean(
        this.db
          .prepare(
            "SELECT 1 FROM garden_neighbor_pairs WHERE discovered=1 AND pair NOT LIKE 'sunberry:%' LIMIT 1",
          )
          .get(),
      ),
    };
  }
}
