// @ts-check
import { z } from "zod";
import { defaultGardenSettings, HOUR, moistureRate } from "./garden-rules.mjs";
import { floodRisk } from "./garden-risks.mjs";

/** @typedef {ReturnType<import("./garden-service.mjs").GardenService["read"]>} GardenState */
const instanceAdmin = {
  kind: /** @type {const} */ ("admin"),
  id: "administrator",
};
const settingsInput = z.strictObject({
  expectedRevision: z.number().int().min(0),
  settings: z.record(z.string(), z.unknown()),
  roleIds: z.array(z.string()).max(100),
});
const initializeInput = z.strictObject({
  initialBalance: z.number().int().min(0).max(1_000_000),
});

/** @param {number} remaining @param {number} lossRate */
function dryEstimate(remaining, lossRate) {
  return lossRate > 0 ? Math.max(0, remaining) / lossRate : null;
}

/** @param {GardenState} state */
export function gardenPriorities(state) {
  return state.plots
    .flatMap(({ id: plot, plant, sheltered }) => {
      if (!plant) return [];
      if (plant.status === "mature")
        return [
          { plot, plantId: plant.id, kind: "harvest", priority: 3, hours: 0 },
        ];
      if (plant.status === "withered")
        return [
          { plot, plantId: plant.id, kind: "clear", priority: 4, hours: 0 },
        ];
      const risk = floodRisk(plant, sheltered, state.weather);
      if (risk)
        return [
          {
            plot,
            plantId: plant.id,
            kind: "flood",
            risk,
            priority: risk === "critical" ? 0 : 2,
            hours: state.dayRemaining / HOUR,
          },
        ];
      const lossRate = -moistureRate(plant, state.weather, sheltered);
      if (plant.water === 0 && lossRate >= 0)
        return [
          {
            plot,
            plantId: plant.id,
            kind: "drought",
            priority: 0,
            hours: Math.max(0, plant.rules.dryHours - plant.dry),
          },
        ];
      if (plant.water < plant.rules.lowWater)
        return [
          {
            plot,
            plantId: plant.id,
            kind: "water",
            priority: 1,
            hours: dryEstimate(plant.water, lossRate),
          },
        ];
      const hours = dryEstimate(plant.water - plant.rules.lowWater, lossRate);
      return hours !== null && hours <= 24
        ? [
            {
              plot,
              plantId: plant.id,
              kind: "low_water_forecast",
              priority: 2,
              hours,
            },
          ]
        : [];
    })
    .sort(
      (a, b) =>
        a.priority - b.priority ||
        (a.hours ?? Infinity) - (b.hours ?? Infinity) ||
        a.plot - b.plot,
    )
    .map(({ priority: _priority, ...entry }) => entry);
}

/** @param {any} runtime */
export function gardenPauseReason(runtime) {
  if (runtime.config.globalPaused) return "GLOBAL_PAUSED";
  if (runtime.config.mode !== "live") return "ISOLATED_MODE";
  if (
    runtime.configChanging ||
    runtime.updateMaintenance ||
    runtime.maintenance.active
  )
    return "UPDATE_IN_PROGRESS";
  return null;
}

/** @param {any} runtime */
function recipients(runtime) {
  return [
    { ...instanceAdmin, name: "管理员" },
    ...runtime.config.agents.map(
      (/** @type {{id:string,name:string}} */ a) => ({
        kind: "agent",
        id: a.id,
        name: a.name,
      }),
    ),
  ];
}

/** @param {GardenState} state */
export function marketHarvests(state) {
  return state.harvests.map((harvest) => {
    const quality = String(harvest.quality);
    const multiplier =
      quality === "fine"
        ? state.settings.fineMultiplier
        : quality === "perfect"
          ? state.settings.perfectMultiplier
          : 1;
    return {
      id: String(harvest.id),
      cropId: String(harvest.crop_id),
      quality,
      quantity: Number(harvest.quantity),
      saleRate:
        state.settings.crops[String(harvest.crop_id)].salePrice * multiplier,
    };
  });
}

/** @param {any} runtime @param {import("./garden-service.mjs").Actor} actor @param {unknown} value */
export function performGardenAction(runtime, actor, value) {
  /** @type {import("./garden-service.mjs").GardenService} */
  const garden = runtime.home.garden;
  return garden.act(runtime.now(), actor, value, (action) => {
    // Live checks cover new writes; replaying a committed receipt leaves the garden untouched.
    if (gardenPauseReason(runtime)) throw Error("GARDEN_PAUSED");
    if (
      action.kind === "gift" &&
      !recipients(runtime).some(
        (entry) =>
          entry.kind === action.recipient.kind &&
          entry.id === action.recipient.id,
      )
    )
      throw Error("GARDEN_RECIPIENT_UNAVAILABLE");
  });
}

/** @param {any} runtime */
export function adminGardenView(runtime) {
  /** @type {import("./garden-service.mjs").GardenService} */
  const garden = runtime.home.garden;
  const roles = recipients(runtime);
  if (!garden.initialized()) return { initialized: false, roles };
  const state = garden.read(runtime.now());
  const pauseReason =
    gardenPauseReason(runtime) ||
    (!state.settings.enabled
      ? "GARDEN_DISABLED"
      : !state.running
        ? "DESKTOP_NOT_CONNECTED"
        : null);
  const { roles: _grants, ...settings } = state.settings;
  const roleIds = roles
    .filter(
      (role) =>
        role.kind === "agent" &&
        garden.allowsRole(role.id, runtime.home.generation(role.id)),
    )
    .map((role) => role.id);
  return {
    initialized: true,
    ...state,
    settings,
    roles,
    roleIds,
    pauseReason,
    priorities: gardenPriorities(state),
    market: marketHarvests(state),
  };
}

/** @param {any} runtime @param {"initialize"|"settings"|"act"|"weather-trial"} operation @param {unknown} value */
export function adminGardenWrite(runtime, operation, value) {
  if (
    runtime.updateMaintenance ||
    runtime.maintenance.active ||
    runtime.configChanging
  )
    throw Error("UPDATE_IN_PROGRESS");
  /** @type {import("./garden-service.mjs").GardenService} */
  const garden = runtime.home.garden;
  const now = runtime.now();
  if (operation === "weather-trial")
    return garden.calendar.trial(garden.requireState(), value);
  if (operation === "initialize") {
    const { initialBalance } = initializeInput.parse(value);
    garden.initialize(now, { ...defaultGardenSettings(), initialBalance });
    return adminGardenView(runtime);
  }
  if (operation === "settings") {
    const { settings, expectedRevision, roleIds } = settingsInput.parse(value);
    const eligible = new Set(
      recipients(runtime)
        .filter((entry) => entry.kind === "agent")
        .map((entry) => entry.id),
    );
    if (roleIds.some((id) => !eligible.has(id)))
      throw Error("GARDEN_ROLE_UNAVAILABLE");
    if (Object.hasOwn(settings, "roles")) throw Error("INVALID_REQUEST");
    garden.configure(now, expectedRevision, {
      ...settings,
      initialBalance: garden.requireState().settings.initialBalance,
      roles: Object.fromEntries(
        roleIds.map((id) => [id, runtime.home.generation(id)]),
      ),
    });
    return adminGardenView(runtime);
  }
  return {
    receipt: performGardenAction(runtime, instanceAdmin, value),
    garden: adminGardenView(runtime),
  };
}

/** @param {any} runtime @param {string} roleId @param {string} turnId */
export function subjectGardenView(runtime, roleId, turnId) {
  /** @type {import("./garden-service.mjs").GardenService} */
  const garden = runtime.home.garden;
  const state = garden.read(runtime.now());
  return {
    balance: state.balance,
    clock: state.clock,
    day: state.day,
    dayRemaining: state.dayRemaining,
    weather: {
      id: state.weather.id,
      name: state.weather.name,
      kind: state.weather.kind,
    },
    speed: state.settings.speed,
    running: state.running,
    turnRemaining: Math.max(
      0,
      state.settings.turnLimit - garden.turnUsed(roleId, turnId),
    ),
    plots: state.plots.map(({ id, plant, sheltered }) => ({
      id,
      sheltered,
      shelterAction: {
        kind: sheltered ? "unshelter" : "shelter",
        args: { plot: id },
      },
      plant: plant && {
        id: plant.id,
        cropId: plant.cropId,
        name: plant.crop.name,
        status: plant.status,
        water: plant.water,
        lowWater: plant.rules.lowWater,
        progress: plant.growth / plant.crop.hours,
        quality: plant.quality,
        fertilizer: plant.fertilizer,
        fertilizerRequired: plant.crop.fertilizer,
        witheredReason: plant.witheredReason,
        floodDays: plant.floodDays ?? 0,
      },
    })),
    priorities: gardenPriorities(state),
    inventory: {
      seeds: state.seeds,
      fertilizer: state.fertilizer,
      harvests: marketHarvests(state),
    },
    market: {
      fertilizerPrice: state.settings.fertilizerPrice,
      crops: Object.entries(state.settings.crops)
        .filter(([, crop]) => crop.enabled)
        .map(([id, crop]) => ({
          id,
          name: crop.name,
          market: crop.market,
          seedPrice: crop.seedPrice,
        })),
    },
    recipients: recipients(runtime),
  };
}
