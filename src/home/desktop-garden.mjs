// @ts-check
import { z } from "zod";
import { adminGardenView, adminGardenWrite } from "./garden-console.mjs";
import { operatorGardenJournal } from "./garden-journal-console.mjs";
import { knownErrorCodes } from "../core/error-codes.mjs";

const inputSchema = z.strictObject({
  client: z.uuid(),
  roomEpoch: z.uuid(),
  action: z.unknown().optional(),
  journal: z.unknown().optional(),
});

/** @param {ReturnType<typeof adminGardenView>} garden */
function operatorView(garden) {
  if (!("plots" in garden)) return { initialized: false };
  return {
    initialized: true,
    plots: garden.plots,
    boardNotes: garden.boardNotes,
    priorities: garden.priorities,
    balance: garden.balance,
    pauseReason: garden.pauseReason,
    day: garden.day,
    dayRemaining: garden.dayRemaining,
    weather: { name: garden.weather.name, kind: garden.weather.kind },
    crops: garden.settings.crops,
    fertilizerPrice: garden.settings.fertilizerPrice,
    seeds: garden.seeds,
    fertilizer: garden.fertilizer,
    fertilizerCredits: garden.fertilizerCredits,
    personalGifts: garden.personalGifts,
    communityShelves: garden.communityShelves,
    craftRecipes: garden.craftRecipes,
    almanac: garden.almanac,
    almanacSummary: garden.almanacSummary,
    facilities: garden.facilities,
    tomorrowForecast: garden.tomorrowForecast,
    event: garden.event,
    mysterySeeds: garden.mysterySeeds,
    weatherForecast: garden.weatherForecast,
    speed: garden.settings.speed,
    nightScene: garden.nightScene,
    fullMoon: garden.fullMoon,
    pollenPairs: garden.pollenPairs,
    mistbellDiscovered: garden.mistbellDiscovered,
    eventHistory: garden.eventHistory,
    followups: garden.followups,
    gardenProjects: garden.gardenProjects,
    activity: garden.activity,
    ledger: garden.ledger,
    gifts: garden.gifts,
    eventActions: garden.eventActions,
    market: garden.market,
    roles: garden.roles,
  };
}

/** @param {any} runtime @param {unknown} input */
export function desktopGarden(runtime, input) {
  const { client, roomEpoch, action, journal } = inputSchema.parse(input);
  const host = runtime.desktopVisits;
  if (
    !host.connected() ||
    host.client?.id !== client ||
    host.live?.room.epoch !== roomEpoch
  )
    throw Error("DESKTOP_VISIT_UNAVAILABLE");
  if (journal !== undefined) {
    if (action !== undefined) throw Error("INVALID_REQUEST");
    return operatorGardenJournal(runtime, journal);
  }
  if (action === undefined)
    return { garden: operatorView(adminGardenView(runtime, true)) };
  try {
    const result = adminGardenWrite(runtime, "act", action);
    if (!("receipt" in result) || !result.garden)
      throw Error("INVALID_REQUEST");
    return { garden: operatorView(result.garden), receipt: result.receipt };
  } catch (error) {
    const code = error instanceof Error ? error.message : "";
    if (
      knownErrorCodes.has(code) &&
      (code.startsWith("GARDEN_") ||
        code === "INVALID_REQUEST" ||
        code === "UPDATE_IN_PROGRESS")
    )
      return { error: code };
    if (error instanceof z.ZodError) return { error: "INVALID_REQUEST" };
    throw error;
  }
}
