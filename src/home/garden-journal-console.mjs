// @ts-check
import { z } from "zod";
import { gardenPauseReason } from "./garden-console.mjs";
import {
  gardenPlantSnapshot,
  renderGardenPlantSnapshot,
} from "./garden-public.mjs";

const id = z.string().min(1).max(200);
const day = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const page = {
  cursor: z.string().min(1).max(2048).optional(),
  limit: z.number().int().min(1).max(100).optional(),
};
const request = z.discriminatedUnion("view", [
  z.strictObject({
    view: z.literal("timeline"),
    fromDay: day.optional(),
    toDay: day.optional(),
    type: id.optional(),
    actorId: id.optional(),
    cropId: id.optional(),
    plot: z.number().int().min(1).max(9).optional(),
    ...page,
  }),
  z.strictObject({ view: z.literal("plant_history"), plantId: id, ...page }),
  z.strictObject({ view: z.literal("plant_image"), plantId: id }),
  z.strictObject({ view: z.literal("digest") }),
  z.strictObject({
    view: z.literal("ack"),
    through: z.number().int().nonnegative(),
  }),
]);
const admin = { kind: "admin", id: "administrator", generation: "instance" };

/** @param {any} runtime @param {unknown} input */
export async function operatorGardenJournal(runtime, input) {
  const { view, ...query } = request.parse(input);
  const garden = runtime.home.garden;
  if (!garden.initialized()) throw Error("GARDEN_NOT_INITIALIZED");
  if (view === "timeline") return garden.timeline(query);
  if (view === "plant_history") return garden.plantHistory(query);
  if (view === "digest") return garden.digest(admin);
  if (view === "ack" && "through" in query)
    return garden.ackDigest(admin, query.through);
  const now = runtime.now();
  const state = garden.observe(now);
  const detail = garden.plantHistory(query, { publicView: true });
  const snapshot = gardenPlantSnapshot(state, detail, {
    running: state.running && !gardenPauseReason(runtime),
    now,
  });
  const image = await renderGardenPlantSnapshot(snapshot, {
    signal: AbortSignal.timeout(20000),
  });
  return { text: snapshot.text, png: image.toString("base64") };
}
