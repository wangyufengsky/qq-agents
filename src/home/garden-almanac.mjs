// @ts-check
import { DAY, gardenVariants } from "./garden-rules.mjs";

/** @typedef {import("./garden-service.mjs").State} State */
/** @typedef {import("./garden-rules.mjs").Quality} Quality */
/** @typedef {{cropId:string, plantedCount:number, harvestCount:number, bestQuality:Quality|null, variants:Set<string>, firstDiscoveredDay:number|null}} RecordOfCrop */

const qualityRank = { ordinary: 1, fine: 2, perfect: 3 };
/** @param {unknown} value @returns {value is Quality} */
const validQuality = (value) =>
  typeof value === "string" && Object.hasOwn(qualityRank, value);
/** @param {unknown} clock */
const knownDay = (clock) =>
  typeof clock === "number" ? Math.floor(clock / DAY) + 1 : null;
/** @param {string} id */
const variantName = (id) =>
  gardenVariants[/** @type {keyof typeof gardenVariants} */ (id)] ?? id;

export class GardenAlmanac {
  /** @param {import("node:sqlite").DatabaseSync} db @param {import("./garden-journal.mjs").GardenJournal} journal */
  constructor(db, journal) {
    this.db = db;
    this.journal = journal;
  }

  /** @param {State} state @param {number} now */
  initialize(state, now) {
    const inserted = this.db
      .prepare("INSERT OR IGNORE INTO garden_almanac_migration VALUES (1)")
      .run();
    if (!inserted.changes) return;
    /** @type {Map<string,RecordOfCrop>} */
    const crops = new Map();
    /** @param {unknown} id @param {unknown} [clock] */
    const rowFor = (id, clock) => {
      if (typeof id !== "string" || !Object.hasOwn(state.settings.crops, id))
        return;
      const current = crops.get(id) ?? {
        cropId: id,
        plantedCount: 0,
        harvestCount: 0,
        bestQuality: null,
        variants: new Set(),
        firstDiscoveredDay: null,
      };
      const day = knownDay(clock);
      if (
        day !== null &&
        (current.firstDiscoveredDay === null ||
          day < current.firstDiscoveredDay)
      )
        current.firstDiscoveredDay = day;
      crops.set(id, current);
      return current;
    };
    const uncertainDates = new Set();
    const archives = this.db
      .prepare(
        "SELECT plant_id,crop_id,planted_clock,status,snapshot FROM garden_plant_archive",
      )
      .all();
    for (const row of archives) {
      const record = rowFor(row.crop_id, row.planted_clock);
      if (!record) continue;
      record.plantedCount++;
      if (row.planted_clock === null) uncertainDates.add(record.cropId);
      const plant = row.snapshot && JSON.parse(String(row.snapshot));
      if (typeof plant?.variant === "string")
        record.variants.add(plant.variant);
    }
    for (const row of this.db
      .prepare(
        `
      SELECT clock,json_extract(detail,'$.cropId') AS cropId FROM garden_facts
      WHERE type='discovery' AND json_extract(detail,'$.phase')='seed'
    `,
      )
      .all()) {
      const record = rowFor(row.cropId, row.clock);
      if (record && row.clock === null) uncertainDates.add(record.cropId);
    }
    // Lots are retained after sale and contain the actual crop, including mutations.
    // Action receipts tie older lots to their plant without guessing a source.
    /** @type {Map<string,number>} */
    const countedByPlant = new Map();
    const receipts = this.db
      .prepare(
        `
      SELECT json_extract(result,'$.harvestId') AS harvestId,
             json_extract(result,'$.plantId') AS plantId,
             json_extract(result,'$.variant') AS variant
      FROM garden_actions WHERE action='harvest'
    `,
      )
      .all();
    const sources = new Map(receipts.map((row) => [row.harvestId, row]));
    const facts = this.db
      .prepare(
        `
      SELECT clock,detail,plants FROM garden_facts WHERE type='harvest' ORDER BY id
    `,
      )
      .all();
    /** @type {Map<string,{cropId:string,clock:unknown,variant?:string}[]>} */
    const factsByPlant = new Map();
    for (const fact of facts) {
      const [plant] = JSON.parse(String(fact.plants));
      if (!plant?.plantId) continue;
      const { cropId, variant } = JSON.parse(String(fact.detail));
      const id = cropId ?? plant.cropId;
      const events = factsByPlant.get(plant.plantId) ?? [];
      events.push({ cropId: id, clock: fact.clock, variant });
      factsByPlant.set(plant.plantId, events);
      const record = rowFor(id, fact.clock);
      if (record && typeof variant === "string") record.variants.add(variant);
    }
    const unlinkedCrops = new Set();
    for (const lot of this.db
      .prepare(
        "SELECT id,crop_id,quality,plant_id FROM garden_harvests ORDER BY rowid",
      )
      .all()) {
      const source = sources.get(lot.id);
      const plantId = lot.plant_id ?? source?.plantId;
      if (typeof plantId === "string")
        countedByPlant.set(plantId, (countedByPlant.get(plantId) ?? 0) + 1);
      const record = rowFor(lot.crop_id);
      if (!record) continue;
      if (typeof plantId !== "string") {
        unlinkedCrops.add(record.cropId);
        uncertainDates.add(record.cropId);
      } else if (
        !(factsByPlant.get(plantId) ?? []).some(
          ({ cropId, clock }) =>
            cropId === record.cropId && knownDay(clock) !== null,
        )
      ) {
        uncertainDates.add(record.cropId);
      }
      record.harvestCount++;
      if (
        validQuality(lot.quality) &&
        (!record.bestQuality ||
          qualityRank[lot.quality] > qualityRank[record.bestQuality])
      )
        record.bestQuality = lot.quality;
      if (typeof source?.variant === "string")
        record.variants.add(source.variant);
    }
    for (const row of archives) {
      const plant = row.snapshot && JSON.parse(String(row.snapshot));
      const id = String(row.plant_id);
      const evidence = factsByPlant.get(id) ?? [];
      const counted = countedByPlant.get(id) ?? 0;
      // Archive-only restores may lack lots entirely. Fill only confirmed harvests.
      // Unlinked lots can still account for those crops, so avoid double counting them.
      for (const fact of evidence.slice(counted)) {
        const record = rowFor(fact.cropId, fact.clock);
        if (record && !unlinkedCrops.has(fact.cropId)) record.harvestCount++;
      }
      const cropId = String(row.crop_id);
      const record = crops.get(cropId);
      if (!record || unlinkedCrops.has(cropId)) continue;
      const reported = Number(
        plant?.harvestCount ?? (row.status === "harvested" ? 1 : 0),
      );
      const fallback = Math.max(
        0,
        reported - Math.max(counted, evidence.length),
      );
      record.harvestCount += fallback;
      const quality = /** @type {unknown} */ (plant?.quality);
      if (
        !counted &&
        row.status === "harvested" &&
        evidence.every((fact) => fact.cropId === cropId) &&
        validQuality(quality) &&
        (!record.bestQuality ||
          qualityRank[quality] > qualityRank[record.bestQuality])
      )
        record.bestQuality = quality;
    }
    for (const record of crops.values()) {
      if (uncertainDates.has(record.cropId) && record.firstDiscoveredDay !== 1)
        record.firstDiscoveredDay = null;
      this.write(record, now);
    }
  }

  /** @param {RecordOfCrop} record @param {number} now */
  write(record, now) {
    this.db
      .prepare(
        `
      INSERT INTO garden_almanac VALUES (?,?,?,?,?,?,?)
      ON CONFLICT(crop_id) DO UPDATE SET planted_count=excluded.planted_count,
        harvest_count=excluded.harvest_count,best_quality=excluded.best_quality,
        variants=excluded.variants,first_day=excluded.first_day,updated_at=excluded.updated_at
    `,
      )
      .run(
        record.cropId,
        record.plantedCount,
        record.harvestCount,
        record.bestQuality,
        JSON.stringify([...record.variants]),
        record.firstDiscoveredDay,
        now,
      );
  }

  /** @param {State} state @param {number} now @param {string} cropId @param {ReturnType<typeof import("./garden-journal.mjs").gardenPlantRef>[]} plants
   * @param {{kind:"plant"}|{kind:"harvest",quality:Quality,variant?:string}|{kind:"discover"}} change */
  record(state, now, cropId, plants, change) {
    const harvest = change.kind === "harvest" ? change : undefined;
    const existing = this.db
      .prepare("SELECT * FROM garden_almanac WHERE crop_id=?")
      .get(cropId);
    const best = validQuality(existing?.best_quality)
      ? existing.best_quality
      : null;
    /** @type {Set<string>} */
    const variants = new Set(
      existing ? JSON.parse(String(existing.variants)) : [],
    );
    const newVariant =
      harvest?.variant && !variants.has(harvest.variant)
        ? harvest.variant
        : undefined;
    if (newVariant) variants.add(newVariant);
    this.write(
      {
        cropId,
        plantedCount:
          Number(existing?.planted_count ?? 0) +
          Number(change.kind === "plant"),
        harvestCount:
          Number(existing?.harvest_count ?? 0) + Number(Boolean(harvest)),
        bestQuality:
          harvest && (!best || qualityRank[harvest.quality] > qualityRank[best])
            ? harvest.quality
            : best,
        variants,
        firstDiscoveredDay: existing
          ? existing.first_day === null
            ? null
            : Number(existing.first_day)
          : knownDay(state.clock),
      },
      now,
    );
    if (existing && !newVariant) return;
    const name = state.settings.crops[cropId].name;
    const title = `图鉴点亮：${newVariant ? variantName(newVariant) : name}`;
    const detail = newVariant
      ? `花园第一次收录了${variantName(newVariant)}。`
      : `花园第一次收录了${name}。`;
    const key = JSON.stringify(["almanac", cropId, newVariant ?? null]);
    this.journal.record({
      clock: state.clock,
      type: "almanac",
      source: "action",
      plants,
      key,
      detail: {
        cropId,
        name,
        stage: title,
        description: detail,
        ...(newVariant && {
          variant: newVariant,
          variantName: variantName(newVariant),
        }),
      },
    });
    const factId = Number(
      this.db.prepare("SELECT id FROM garden_facts WHERE unique_key=?").get(key)
        ?.id,
    );
    return { kind: "almanac_unlock", title, detail, firstTime: true, factId };
  }

  /** @param {State["settings"]} settings */
  view(settings) {
    const entries = this.db
      .prepare("SELECT * FROM garden_almanac ORDER BY crop_id")
      .all()
      .flatMap((row) => {
        const cropId = String(row.crop_id);
        if (!Object.hasOwn(settings.crops, cropId)) return [];
        return [
          {
            cropId,
            name: settings.crops[cropId].name,
            plantedCount: Number(row.planted_count),
            harvestCount: Number(row.harvest_count),
            bestQuality: validQuality(row.best_quality)
              ? row.best_quality
              : null,
            variants: /** @type {string[]} */ (
              JSON.parse(String(row.variants))
            ).map((id) => ({ id, name: variantName(id) })),
            firstDiscoveredDay:
              row.first_day === null ? null : Number(row.first_day),
          },
        ];
      });
    const newlyUnlocked = this.db
      .prepare(
        "SELECT clock,detail FROM garden_facts WHERE type='almanac' ORDER BY id DESC LIMIT 4",
      )
      .all()
      .map(({ clock, detail }) => {
        const { cropId, name, variant, variantName } = JSON.parse(
          String(detail),
        );
        return {
          cropId,
          name,
          ...(variant && { variant, variantName }),
          day: knownDay(clock),
        };
      });
    return {
      entries,
      unlocked: entries.length,
      total: Object.entries(settings.crops).filter(
        ([id, crop]) =>
          crop.enabled || entries.some(({ cropId }) => cropId === id),
      ).length,
      newlyUnlocked,
    };
  }
}
