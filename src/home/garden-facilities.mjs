// @ts-check
import { z } from "zod";

export const gardenFacilityId = z.enum([
  "weather_chime",
  "bird_bath",
  "drying_rack",
]);

const catalog = {
  weather_chime: {
    name: "晴雨风铃",
    description: "听风铃猜明日天色。",
    price: 280,
  },
  bird_bath: {
    name: "小鸟浴盆",
    description: "吸引更多友善访客，也让园艺传闻传得更快。",
    price: 360,
  },
  drying_rack: {
    name: "干花晾晒架",
    description: "研究进阶手作，所有手作工本费减半。",
    price: 420,
  },
};

/** @param {import("node:sqlite").DatabaseSync} db @param {z.infer<typeof gardenFacilityId>} id */
export function hasGardenFacility(db, id) {
  return Boolean(
    db.prepare("SELECT 1 FROM garden_facilities WHERE id=?").get(id),
  );
}

/** @param {import("node:sqlite").DatabaseSync} db */
export function viewGardenFacilities(db) {
  const built = new Map(
    db
      .prepare("SELECT id,built_day FROM garden_facilities")
      .all()
      .map(({ id, built_day }) => [id, Number(built_day)]),
  );
  return gardenFacilityId.options.map((id) => ({
    id,
    ...catalog[id],
    built: built.has(id),
    builtDay: built.get(id) ?? null,
  }));
}

/** @param {import("node:sqlite").DatabaseSync} db @param {z.infer<typeof gardenFacilityId>} id @param {number} price
 * @param {number} day @param {number} now @param {import("./garden-service.mjs").Actor} actor @param {(delta:number)=>void} pay */
export function buildGardenFacility(db, id, price, day, now, actor, pay) {
  if (hasGardenFacility(db, id)) throw Error("GARDEN_FACILITY_ALREADY_BUILT");
  const facility = catalog[id];
  if (price !== facility.price) throw Error("GARDEN_PRICE_CHANGED");
  pay(-price);
  db.prepare("INSERT INTO garden_facilities VALUES (?,?,?,?,?)").run(
    id,
    day,
    now,
    actor.kind,
    actor.id,
  );
  return { facilityId: id, name: facility.name, price, builtDay: day };
}

/** @param {import("./garden-weather.mjs").Weather} weather */
export function gardenForecastHint(weather) {
  if (weather.kind === "sun")
    return { direction: "sun", hint: "风铃清亮，明天大概会放晴。" };
  if (weather.kind === "cloud")
    return { direction: "cloud", hint: "风铃声音柔和，明天大概云多。" };
  return {
    direction: "rain",
    hint: "风铃发闷，明天像是有雨，怕涝的花可以提前备棚。",
  };
}
