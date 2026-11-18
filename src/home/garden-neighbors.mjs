// @ts-check
import { createHash } from "node:crypto";
import { gardenPlantRef } from "./garden-journal.mjs";
import { CATNIP, DAY, HOUR, MISTBELL } from "./garden-rules.mjs";

/** @typedef {ReturnType<import("./garden-service.mjs").GardenService["requireState"]>} State */
/** @typedef {Omit<State["plots"][number], "plant"> & {plant: import("./garden-rules.mjs").Plant}} PlantedPlot */

const nightStart = 19 * HOUR;
const nightEnd = 6 * HOUR;
const minimumAge = 48 * HOUR;

/** @param {State} state */
function neighborPairs(state) {
  /** @type {Array<[PlantedPlot,PlantedPlot]>} */
  const pairs = [];
  for (const left of state.plots) {
    if (left.plant?.cropId !== "moonflower" || left.plant.status !== "mature")
      continue;
    for (const right of state.plots) {
      if (right.plant?.cropId !== CATNIP || right.plant.status !== "mature")
        continue;
      const row =
        Math.floor((left.id - 1) / 3) - Math.floor((right.id - 1) / 3);
      const col = ((left.id - 1) % 3) - ((right.id - 1) % 3);
      if (Math.abs(row) + Math.abs(col) !== 1) continue;
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

/** @param {string} seed @param {string} lane @param {number} day */
function trial(seed, lane, day) {
  return (
    createHash("sha256")
      .update(JSON.stringify([seed, lane, day]))
      .digest()
      .readUInt32BE() <
    0x100000000 / 3
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

  /** @param {State} state @param {number} day @param {number} elapsed @param {import("./garden-journal.mjs").GardenJournal} journal */
  settle(state, day, elapsed, journal) {
    if (!state.settings.crops[MISTBELL].enabled) return;
    const pairs = neighborPairs(state);
    if (!pairs.length) return;
    const seed = this.seed();
    const dawn = (day - 1) * DAY;
    // A dawn window belongs to the night that began the previous day.
    const windows = [
      { night: day - 1, start: dawn, end: dawn + nightEnd },
      { night: day, start: dawn + nightStart, end: day * DAY },
    ];
    for (const pair of pairs) {
      const id = pairId(pair);
      const ready = Math.max(...pair.map(({ plant }) => eligibleSince(plant)));
      let status = this.status(id);
      for (const { night, start, end } of windows) {
        const at = Math.max(ready, start);
        if (
          !night ||
          at >= end ||
          at > elapsed ||
          status?.discovered ||
          Number(status?.night ?? 0) >= night
        )
          continue;
        const attempts = Number(status?.attempts ?? 0) + 1;
        const discovered = Number(attempts === 3 || trial(seed, id, night));
        this.db
          .prepare(
            `
          INSERT INTO garden_neighbor_pairs VALUES (?,?,?,?)
          ON CONFLICT(pair) DO UPDATE SET attempts=excluded.attempts,night=excluded.night,discovered=excluded.discovered
        `,
          )
          .run(id, attempts, night, discovered);
        status = { attempts, night, discovered };
        if (discovered) {
          state.revision++;
          state.seeds[MISTBELL] = (state.seeds[MISTBELL] ?? 0) + 1;
          this.db
            .prepare(
              "UPDATE garden_state SET seeds=?,clock=MAX(clock,?),revision=revision+1 WHERE id=1",
            )
            .run(JSON.stringify(state.seeds), at);
        }
        if (discovered || attempts === 1) {
          const phase = discovered ? "seed" : "pollen";
          journal.record({
            type: "discovery",
            clock: at,
            plants: pair.map(({ id, plant }) => gardenPlantRef(id, plant)),
            source: "night",
            detail: discovered
              ? {
                  cropId: MISTBELL,
                  name: state.settings.crops[MISTBELL].name,
                  phase,
                }
              : { phase },
            key: `neighbors:${id}:${phase}`,
          });
        }
      }
    }
  }

  /** @param {State} state @param {import("./garden-weather.mjs").Weather["kind"]} weather */
  view(state, weather) {
    const day = Math.floor(state.clock / DAY) + 1;
    const hour = state.clock % DAY;
    const period =
      hour >= nightStart || hour < nightEnd
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
          trial(seed, "butterflies", day),
        fireflies:
          period === "night" &&
          (weather === "sun" || weather === "cloud") &&
          trial(seed, "fireflies", hour < nightEnd ? day - 1 : day),
      },
      pollenPairs: neighborPairs(state).flatMap((pair) => {
        const status = this.status(pairId(pair));
        return status && !status.discovered
          ? [{ plots: pair.map(({ id }) => id) }]
          : [];
      }),
      mistbellDiscovered: Boolean(
        this.db
          .prepare(
            "SELECT 1 FROM garden_neighbor_pairs WHERE discovered=1 LIMIT 1",
          )
          .get(),
      ),
    };
  }
}
