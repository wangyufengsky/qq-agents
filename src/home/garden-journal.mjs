// @ts-check
import {
  gardenGrowthStages,
  gardenStageLabel,
} from "../../public/garden-art/stages.js";
import { DAY, gardenVariantDetail, HOUR } from "./garden-rules.mjs";

/** @typedef {import("./garden-rules.mjs").Plant} Plant */
/** @typedef {import("./garden-service.mjs").State} State */
/** @typedef {{kind:string,id:string,generation?:string}} Identity */
/** @typedef {{plantId:string,plot:number,cropId:string,name?:string}} PlantRef */
/** @typedef {{type:string,clock:number|null,actor?:Identity,plants?:PlantRef[],source:string,detail?:Record<string,unknown>,key?:string}} Fact */
/** @typedef {{fromDay?:number,toDay?:number,plot?:number,type?:string,actorId?:string,cropId?:string,plantId?:string,factId?:number,limit?:number,cursor?:string}} Query */

const factLabels = /** @type {Record<string,string>} */ ({
  opened: "花园开园",
  planted: "播种",
  water: "浇水",
  fertilize: "施肥",
  harvest: "收成",
  clear: "清理",
  withered: "枯萎",
  visitor: "访客来园",
  visitor_reward: "领取访客礼物",
  event: "花园事件",
  discovery: "邻株发现",
  rumor: "园艺传闻",
  variant: "收获惊喜",
  followup: "花园回响",
});

/** @param {number} plot @param {Plant} plant */
export function gardenPlantRef(plot, plant) {
  return {
    plantId: plant.id,
    plot,
    cropId: plant.cropId,
    name: plant.crop.name,
  };
}

/** @param {import("node:sqlite").SQLOutputValue} value */
function parse(value) {
  return JSON.parse(String(value));
}

/** @param {import("node:sqlite").SQLOutputValue} value */
function nullableNumber(value) {
  return value === null ? null : Number(value);
}

/** @param {Identity} actor */
function readerKey(actor) {
  return actor.kind === "admin"
    ? "admin"
    : JSON.stringify([actor.kind, actor.id, actor.generation ?? ""]);
}

/** @param {Fact} fact */
function factText(fact) {
  const plants = fact.plants
    ?.map(({ plot, name, cropId }) => `${plot} 号地的${name ?? cropId}`)
    .join("与");
  const label =
    fact.type === "discovery" && fact.detail?.phase === "pollen"
      ? `发现${typeof fact.detail.hint === "string" ? fact.detail.hint : "蓝紫色花粉"}，品种尚未揭晓`
      : (fact.detail?.stage ?? factLabels[fact.type] ?? fact.type);
  const event = fact.detail?.name;
  const variant = fact.detail?.variantName;
  return [
    plants,
    label,
    typeof variant === "string" ? variant : "",
    typeof event === "string" ? event : "",
  ]
    .filter(Boolean)
    .join(" · ");
}

/** @param {Plant} plant */
function publicPlantSnapshot(plant) {
  return {
    id: plant.id,
    cropId: plant.cropId,
    settledAt: plant.settledAt,
    status: plant.status,
    growth: plant.growth,
    quality: plant.quality,
    ...gardenVariantDetail(plant),
    harvestCount: plant.harvestCount ?? 0,
    fertilizer: plant.fertilizer,
    water: plant.water,
    dry: plant.dry,
    witheredReason: plant.witheredReason,
    crop: {
      hours: plant.crop.hours,
      name: plant.crop.name,
      maxHarvests: plant.crop.maxHarvests ?? 1,
    },
    rules: {
      careMode: plant.rules.careMode,
      lowWater: plant.rules.lowWater,
      dryHours: plant.rules.dryHours,
    },
  };
}

/** @param {Record<string,unknown>} detail */
function publicFactDetail(detail) {
  const { stage, name, eventId, cropId, phase, variant, variantName, hint } =
    detail;
  return {
    ...(typeof stage === "string" && { stage }),
    ...(typeof name === "string" && { name }),
    ...(typeof eventId === "string" && { eventId }),
    ...(typeof cropId === "string" && { cropId }),
    ...(typeof phase === "string" && { phase }),
    ...(typeof variant === "string" && { variant }),
    ...(typeof variantName === "string" && { variantName }),
    ...(typeof hint === "string" && { hint }),
  };
}

/** @param {string} cursor */
function cursorData(cursor) {
  try {
    const page = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (typeof page.filter !== "string") throw Error("INVALID_REQUEST");
    return page;
  } catch {
    throw Error("INVALID_REQUEST");
  }
}

/** @param {Record<string, import("node:sqlite").SQLOutputValue>} row @param {boolean} publicView */
function factView(row, publicView) {
  const clock = nullableNumber(row.clock);
  const minute =
    clock === null ? null : Math.floor((clock % DAY) / (HOUR / 60));
  const time =
    minute === null
      ? null
      : [Math.floor(minute / 60), minute % 60]
          .map((part) => String(part).padStart(2, "0"))
          .join(":");
  const fact = /** @type {Fact} */ ({
    type: String(row.type),
    clock,
    plants: /** @type {PlantRef[]} */ (parse(row.plants)).map(
      ({ plantId, plot, cropId, name }) => ({ plantId, plot, cropId, name }),
    ),
    source: String(row.source),
    detail: publicView
      ? publicFactDetail(parse(row.detail))
      : Object.fromEntries(
          Object.entries(parse(row.detail)).filter(
            ([key]) => key !== "actorGeneration",
          ),
        ),
    ...(!publicView &&
      row.actor_kind && {
        actor: { kind: String(row.actor_kind), id: String(row.actor_id) },
      }),
  });
  return {
    id: Number(row.id),
    ...fact,
    day: clock === null ? null : Math.floor(clock / DAY) + 1,
    minute,
    time,
    text: factText(fact),
  };
}

/** @param {Record<string,import("node:sqlite").SQLOutputValue>} row @param {boolean} publicView */
function digestFact(row, publicView) {
  if (row.type !== "private_gift") return factView(row, publicView);
  return {
    id: Number(row.id),
    type: "gift",
    text: "你收到了新的花园礼物，可查看自己的礼物栏。",
    day: Math.floor(Number(row.clock) / DAY) + 1,
    plants: [],
  };
}

export class GardenJournal {
  /** @param {import("node:sqlite").DatabaseSync} db */
  constructor(db) {
    this.db = db;
  }

  /** @param {Fact} fact */
  record({ type, clock, plants = [], actor, source, detail = {}, key }) {
    // An old clock-only save can replay growth without retained evidence of the exact crossing.
    this.db
      .prepare(
        `INSERT INTO garden_facts(type,clock,plants,actor_kind,actor_id,source,detail,unique_key)
        SELECT :type, CASE WHEN replay THEN NULL ELSE :clock END, :plants, :actorKind, :actorId,
          CASE WHEN replay THEN 'legacy' ELSE :source END, :detail, :key
        FROM (SELECT EXISTS (
          SELECT 1 FROM garden_history_start
          WHERE legacy=1 AND :source NOT IN ('legacy','system','action') AND :clock < clock
        ) AS replay)
        WHERE 1
        ON CONFLICT(unique_key) DO NOTHING`,
      )
      .run({
        ":type": type,
        ":clock": clock,
        ":plants": JSON.stringify(plants),
        ":actorKind": actor?.kind ?? null,
        ":actorId": actor?.id ?? null,
        ":source": source,
        ":detail": JSON.stringify(detail),
        ":key": key ?? null,
      });
  }

  /** @param {PlantRef} ref @param {Plant|null} plant @param {number|null} clock @param {Identity} [actor] */
  addPlant(ref, plant, clock, actor) {
    this.db
      .prepare(
        `INSERT INTO garden_plant_archive(plant_id,plot,crop_id,name,planted_clock,actor_kind,actor_id,status,snapshot)
      VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(plant_id) DO NOTHING`,
      )
      .run(
        ref.plantId,
        ref.plot,
        ref.cropId,
        ref.name ?? ref.cropId,
        clock,
        actor?.kind ?? null,
        actor?.id ?? null,
        plant?.status ?? "unknown",
        plant ? JSON.stringify(plant) : null,
      );
  }

  /** @param {Plant} plant @param {string} [status] */
  updatePlant(plant, status = plant.status) {
    // Calendar projection also runs on views. Closed plants are immutable archives.
    this.db
      .prepare(
        `UPDATE garden_plant_archive SET snapshot=:snapshot,status=:status WHERE plant_id=:id
        AND status NOT IN ('harvested','cleared')
        AND (status IS NOT :status OR snapshot IS NOT :snapshot)
        AND (snapshot IS NULL OR json_extract(snapshot,'$.settledAt')<=:settledAt)`,
      )
      .run({
        ":snapshot": JSON.stringify(plant),
        ":status": status,
        ":id": plant.id,
        ":settledAt": plant.settledAt,
      });
  }

  /** @param {PlantRef} ref @param {Plant} plant @param {number} before @param {number} after
   * @param {number} clock @param {number} clockPerGrowth @param {{id:string,name:string}} [event] */
  growth(ref, plant, before, after, clock, clockPerGrowth, event) {
    gardenGrowthStages.forEach(({ ratio, type }) => {
      const threshold = plant.crop.hours * ratio;
      if (before < threshold && threshold <= after)
        this.record({
          key: `${plant.id}:${type}${plant.harvestCount ? `:${plant.harvestCount}` : ""}`,
          type,
          clock: clock + (threshold - before) * clockPerGrowth,
          plants: [ref],
          source: event ? "event" : "growth",
          detail: {
            stage: gardenStageLabel(ref.cropId, type),
            ...(type === "mature" && gardenVariantDetail(plant)),
            ...(event && { eventId: event.id, name: event.name }),
          },
        });
    });
  }

  /** @param {State} state @param {boolean} legacy */
  initialize(state, legacy) {
    if (this.db.prepare("SELECT 1 FROM garden_history_start WHERE id=1").get())
      return;
    this.db
      .prepare("INSERT INTO garden_history_start VALUES(1,?,?)")
      .run(state.clock, Number(legacy));
    this.record({
      type: "opened",
      clock: 0,
      source: legacy ? "legacy" : "system",
      key: "opened",
    });
    if (!legacy) return;

    /** @type {Map<string,PlantRef>} */
    const refs = new Map();
    for (const { id, plant } of state.plots) {
      if (!plant) continue;
      const ref = gardenPlantRef(id, plant);
      refs.set(plant.id, ref);
      this.addPlant(ref, plant, null);
      for (const { ratio, type } of gardenGrowthStages) {
        if (plant.growth < plant.crop.hours * ratio) continue;
        this.record({
          type,
          clock: null,
          plants: [ref],
          source: "legacy",
          key: `${plant.id}:${type}`,
          detail: { stage: gardenStageLabel(plant.cropId, type) },
        });
      }
      if (plant.status === "withered")
        this.record({
          type: "withered",
          clock: null,
          plants: [ref],
          source: "legacy",
          key: `${plant.id}:withered`,
        });
    }
    const actions = this.db
      .prepare(
        `SELECT actor_kind,actor_id,action,result FROM garden_actions
      WHERE action IN ('plant','plant_mystery_seed','water','fertilize','harvest','clear') ORDER BY seq`,
      )
      .all();
    /** @type {Map<string,string>} */
    const harvestedCrops = new Map();
    for (const row of actions) {
      if (row.action !== "harvest") continue;
      const { plantId, harvestId } = parse(row.result);
      const harvest = this.db
        .prepare("SELECT crop_id FROM garden_harvests WHERE id=?")
        .get(harvestId);
      if (harvest) harvestedCrops.set(plantId, String(harvest.crop_id));
    }
    for (const row of actions) {
      const { plantId, plot, cropId } = parse(row.result);
      if (typeof plantId !== "string" || typeof plot !== "number") continue;
      const knownCrop =
        cropId ?? refs.get(plantId)?.cropId ?? harvestedCrops.get(plantId);
      const ref = refs.get(plantId) ?? {
        plantId,
        plot,
        cropId: knownCrop ?? "unknown",
        name: state.settings.crops[knownCrop]?.name ?? "旧植株",
      };
      refs.set(plantId, ref);
      const actor = { kind: String(row.actor_kind), id: String(row.actor_id) };
      const type = ["plant", "plant_mystery_seed"].includes(String(row.action))
        ? "planted"
        : String(row.action);
      this.addPlant(ref, null, null, type === "planted" ? actor : undefined);
      if (type === "planted")
        this.db
          .prepare(
            "UPDATE garden_plant_archive SET actor_kind=?,actor_id=? WHERE plant_id=?",
          )
          .run(actor.kind, actor.id, plantId);
      if (type === "harvest" || type === "clear") {
        const stage = type === "harvest" ? "mature" : "withered";
        this.record({
          type: stage,
          clock: null,
          plants: [ref],
          source: "legacy",
          key: `${plantId}:${stage}`,
          detail: { stage: gardenStageLabel(ref.cropId, stage) },
        });
        this.db
          .prepare("UPDATE garden_plant_archive SET status=? WHERE plant_id=?")
          .run(type === "harvest" ? "harvested" : "cleared", plantId);
      }
      this.record({
        type,
        clock: null,
        plants: [ref],
        actor,
        source: "legacy",
      });
    }
    for (const { day, value } of this.db
      .prepare(
        "SELECT day,value FROM garden_events WHERE value IS NOT NULL ORDER BY day",
      )
      .all()) {
      const event = parse(value);
      if (!event) continue;
      this.record({
        type: event.kind === "visitor" ? "visitor" : "event",
        clock: (Number(day) - 1) * DAY,
        source: "legacy",
        detail: { name: event.name },
        key: `event:${day}`,
      });
      if (event.kind === "visitor" && event.actor)
        this.record({
          type: "visitor_reward",
          clock: null,
          actor: event.actor,
          source: "legacy",
          detail: { name: event.name },
          key: `visitor_reward:${day}`,
        });
    }
  }

  /** @param {Plant} plant */
  settledPlant(plant) {
    const row = this.db
      .prepare("SELECT snapshot FROM garden_plant_archive WHERE plant_id=?")
      .get(plant.id);
    const snapshot = /** @type {Plant|null} */ (
      row ? parse(row.snapshot) : null
    );
    return snapshot && snapshot.settledAt >= plant.settledAt ? snapshot : plant;
  }

  coverage() {
    const row = this.db
      .prepare("SELECT clock,legacy FROM garden_history_start WHERE id=1")
      .get();
    return {
      fromClock: Number(row?.clock ?? 0),
      fromDay: Math.floor(Number(row?.clock ?? 0) / DAY) + 1,
      partial: Boolean(row?.legacy),
    };
  }

  latestId() {
    return Number(
      this.db.prepare("SELECT MAX(id) AS latest FROM garden_facts").get()
        ?.latest ?? 0,
    );
  }

  /** @param {Query} query @param {boolean} publicView @param {boolean} [descending] */
  query(
    {
      fromDay,
      toDay,
      plot,
      type,
      actorId,
      cropId,
      plantId,
      factId,
      limit = 30,
      cursor,
    },
    publicView,
    descending = false,
  ) {
    const size = Math.min(100, Math.max(1, limit));
    const filter = JSON.stringify({
      fromDay,
      toDay,
      plot,
      type,
      actorId: publicView ? undefined : actorId,
      cropId,
      plantId,
      factId,
      descending,
      publicView,
    });
    let through = this.latestId();
    let offset = 0;
    if (cursor) {
      const page = cursorData(cursor);
      if (
        page.filter !== filter ||
        !Number.isSafeInteger(page.offset) ||
        page.offset < 0 ||
        !Number.isSafeInteger(page.through) ||
        page.through < 0 ||
        page.through > through
      )
        throw Error("INVALID_REQUEST");
      ({ through, offset } = page);
    }
    const rows = this.db
      .prepare(
        `SELECT * FROM garden_facts AS fact
      WHERE id<=:through AND type!='private_gift'
        AND (:factId IS NULL OR id=:factId)
        AND (:startClock IS NULL OR clock>=:startClock)
        AND (:endClock IS NULL OR clock<:endClock)
        AND (:type IS NULL OR type=:type)
        AND (:actor IS NULL OR actor_id=:actor)
        AND (
          (:plot IS NULL AND :plantId IS NULL AND
            (:cropId IS NULL OR json_extract(detail,'$.cropId')=:cropId))
          OR EXISTS (
            SELECT 1 FROM json_each(fact.plants) AS ref
            WHERE (:plot IS NULL OR json_extract(ref.value,'$.plot')=:plot)
              AND (:plantId IS NULL OR json_extract(ref.value,'$.plantId')=:plantId)
              AND (:cropId IS NULL OR json_extract(ref.value,'$.cropId')=:cropId
                OR json_extract(detail,'$.cropId')=:cropId)
          )
        )
      ORDER BY clock IS NULL, ${descending ? "clock DESC,id DESC" : `CAST(clock / ${DAY} AS INTEGER) DESC,clock,id`}
      LIMIT :limit OFFSET :offset`,
      )
      .all({
        ":through": through,
        ":factId": factId ?? null,
        ":startClock": fromDay === undefined ? null : (fromDay - 1) * DAY,
        ":endClock": toDay === undefined ? null : toDay * DAY,
        ":type": type ?? null,
        ":actor": publicView ? null : (actorId ?? null),
        ":plot": plot ?? null,
        ":plantId": plantId ?? null,
        ":cropId": cropId ?? null,
        ":limit": size + 1,
        ":offset": offset,
      });
    return {
      entries: rows.slice(0, size).map((row) => factView(row, publicView)),
      nextCursor:
        rows.length <= size
          ? null
          : Buffer.from(
              JSON.stringify({ filter, through, offset: offset + size }),
            ).toString("base64url"),
      coverage: this.coverage(),
    };
  }

  /** @param {Query} query @param {boolean} publicView */
  plantHistory(query, publicView) {
    const { plantId, plot, cropId, cursor } = query;
    let selectedId = plantId;
    if (!selectedId && cursor) {
      try {
        const filter = JSON.parse(cursorData(cursor).filter);
        if (
          typeof filter.plantId !== "string" ||
          !filter.descending ||
          (plot === undefined && cropId === undefined)
        )
          throw Error("INVALID_REQUEST");
        selectedId = filter.plantId;
      } catch {
        throw Error("INVALID_REQUEST");
      }
    }
    const rows = this.db
      .prepare(
        `SELECT * FROM garden_plant_archive
      WHERE (? IS NOT NULL AND plant_id=?) OR (? IS NULL
        AND (? IS NOT NULL OR ? IS NOT NULL)
        AND (? IS NULL OR plot=?)
        AND (? IS NULL OR crop_id=?)
        AND status NOT IN ('harvested','cleared','unknown'))
      ORDER BY plot,plant_id`,
      )
      .all(
        selectedId ?? null,
        selectedId ?? null,
        selectedId ?? null,
        plot ?? null,
        cropId ?? null,
        plot ?? null,
        plot ?? null,
        cropId ?? null,
        cropId ?? null,
      );
    if (
      cursor &&
      (rows.length !== 1 ||
        (!plantId &&
          ((plot !== undefined && rows[0].plot !== plot) ||
            (cropId !== undefined && rows[0].crop_id !== cropId))))
    )
      throw Error("INVALID_REQUEST");
    const choices = rows.map((row) => ({
      id: String(row.plant_id),
      plantId: String(row.plant_id),
      plot: Number(row.plot),
      cropId: String(row.crop_id),
      name: String(row.name),
      plantedClock: nullableNumber(row.planted_clock),
      plantedDay:
        row.planted_clock === null
          ? null
          : Math.floor(Number(row.planted_clock) / DAY) + 1,
      status: String(row.status),
    }));
    if (choices.length !== 1)
      return {
        plant: null,
        choices,
        entries: [],
        nextCursor: null,
        coverage: this.coverage(),
      };
    const row = rows[0];
    const snapshot = parse(row.snapshot);
    const plant = {
      ...choices[0],
      snapshot:
        publicView && snapshot ? publicPlantSnapshot(snapshot) : snapshot,
      ...(!publicView &&
        row.actor_kind && {
          actor: { kind: String(row.actor_kind), id: String(row.actor_id) },
        }),
    };
    return {
      plant,
      choices: [],
      ...this.query(
        { ...query, plot: undefined, cropId: undefined, plantId: plant.id },
        publicView,
        true,
      ),
    };
  }

  /** @param {Identity} actor */
  readerKey(actor) {
    return readerKey(actor);
  }

  /** @param {Identity} actor */
  highlights(actor) {
    const key = readerKey(actor);
    const rows = this.db
      .prepare(
        `SELECT * FROM garden_facts
      WHERE id > COALESCE((SELECT through_id FROM garden_journal_reads WHERE reader=?),0)
      AND clock IS NOT NULL
      AND (type IN ('discovery','event','variant','followup','rumor','visitor','visitor_reward')
        OR (type='private_gift' AND json_extract(detail,'$.reader')=?))
      ORDER BY id DESC LIMIT 5`,
      )
      .all(key, key);
    return rows.map((row) => {
      const { id, type, text, day, plants } = digestFact(row, true);
      if (type === "gift") return { id, type, text };
      const plots = (plants ?? []).map(({ plot }) => plot);
      const detail = publicFactDetail(parse(row.detail));
      return {
        id,
        type,
        day,
        text,
        ...(plots.length && { plots }),
        ...(detail?.phase === "seed" &&
          typeof detail.name === "string" && {
            surprise: {
              kind: "neighbor_seed",
              title: `邻株结种：${detail.name}`,
              detail: `花园手帐记录了${plots.map((plot) => `${plot} 号地`).join("与")}的邻株结种。`,
              factId: id,
            },
          }),
        ...(type === "followup" &&
          detail.name &&
          detail.stage && {
            surprise: {
              kind: "followup",
              title: detail.name,
              detail: detail.stage,
              factId: id,
            },
          }),
      };
    });
  }

  /** @param {Identity} actor @param {boolean} publicView */
  digest(actor, publicView) {
    const row = this.db
      .prepare("SELECT through_id FROM garden_journal_reads WHERE reader=?")
      .get(readerKey(actor));
    const through = this.latestId();
    const rows = this.db
      .prepare(
        `SELECT * FROM garden_facts
      WHERE id>? AND id<=? AND clock IS NOT NULL
      AND (type IN ('mature','discovery','visitor','visitor_reward','harvest','water','fertilize','planted','withered','event','variant','followup','rumor')
        OR (type='private_gift' AND json_extract(detail,'$.reader')=?))
      ORDER BY CASE type WHEN 'discovery' THEN 0 WHEN 'private_gift' THEN 0 WHEN 'mature' THEN 1
        WHEN 'visitor' THEN 2 WHEN 'visitor_reward' THEN 2 WHEN 'harvest' THEN 3
        WHEN 'water' THEN 4 WHEN 'fertilize' THEN 4 ELSE 5 END, id DESC LIMIT 3`,
      )
      .all(
        Number(row?.through_id ?? 0),
        through,
        publicView ? null : readerKey(actor),
      );
    const overview = !row
      ? this.db
          .prepare(
            `SELECT (SELECT clock FROM garden_state WHERE id=1) AS clock,
          COUNT(*) AS occupied, COUNT(*) FILTER (WHERE status='mature') AS mature,
          COUNT(*) FILTER (WHERE status='withered') AS withered
          FROM garden_plant_archive WHERE status IN ('growing','mature','withered')`,
          )
          .get()
      : undefined;
    return {
      entries: rows.map((item) => digestFact(item, publicView)),
      initial: !row,
      ...(overview && {
        overview: {
          day: Math.floor(Number(overview.clock) / DAY) + 1,
          occupied: Number(overview.occupied),
          mature: Number(overview.mature),
          withered: Number(overview.withered),
        },
      }),
      through,
      coverage: this.coverage(),
    };
  }

  /** @param {Identity} actor @param {number} through */
  ackDigest(actor, through) {
    if (
      !Number.isSafeInteger(through) ||
      through < 0 ||
      through > this.latestId()
    )
      throw Error("INVALID_REQUEST");
    this.db
      .prepare(
        `INSERT INTO garden_journal_reads VALUES (?,?)
      ON CONFLICT(reader) DO UPDATE SET through_id=MAX(through_id,excluded.through_id)`,
      )
      .run(readerKey(actor), through);
    return {
      through: Number(
        this.db
          .prepare("SELECT through_id FROM garden_journal_reads WHERE reader=?")
          .get(readerKey(actor))?.through_id,
      ),
    };
  }
}
