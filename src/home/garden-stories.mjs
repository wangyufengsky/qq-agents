// @ts-check
import { createHash } from "node:crypto";
import { teaCrops } from "./garden-event-rules.mjs";
import { DAY } from "./garden-rules.mjs";
import { GardenGifts } from "./garden-items.mjs";
import { unlockGardenRumor } from "./garden-companion.mjs";

const admin = /** @type {const} */ ({
  kind: "admin",
  id: "administrator",
  generation: "instance",
});
const catGifts = /** @type {const} */ ([
  "dried-fish",
  "yarn-ball",
  "pressed-bookmark",
]);

/** @typedef {import("./garden-service.mjs").State} State */
/** @typedef {import("./garden-items.mjs").Owner} Owner */
/** @typedef {import("./garden-events.mjs").GardenEvent} GardenEvent */

export class GardenStories {
  /** @param {import("node:sqlite").DatabaseSync} db @param {import("./garden-journal.mjs").GardenJournal} journal */
  constructor(db, journal) {
    this.db = db;
    this.journal = journal;
    this.gifts = new GardenGifts(db);
    /** @type {((owner:Owner, moment:{kind:string,title:string,body:string,key:string},now:number)=>void)|undefined} */
    this.recordObservation = undefined;
  }

  /** @param {Owner} owner */
  active(owner) {
    return (
      owner.kind === "admin" ||
      Boolean(
        this.db
          .prepare(
            "SELECT 1 FROM home_identities WHERE agent_id=? AND generation=? AND active=1",
          )
          .get(owner.id, owner.generation),
      )
    );
  }

  /** @param {string} eventId @param {number} day @param {string} kind @param {Owner} owner @param {Record<string,unknown>} [payload] */
  schedule(eventId, day, kind, owner, payload = {}) {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO garden_event_followups
      (id,source_event_id,trigger_day,kind,actor_kind,actor_id,payload)
      VALUES(?,?,?,?,?,?,?)`,
      )
      .run(
        eventId,
        eventId,
        day,
        kind,
        owner.kind,
        owner.id,
        JSON.stringify({ ...payload, generation: owner.generation }),
      );
  }

  /** @param {string} id @param {number} now */
  cancel(id, now) {
    this.db
      .prepare(
        "UPDATE garden_event_followups SET status='cancelled',settled_at=? WHERE id=? AND status='pending'",
      )
      .run(now, id);
  }

  /** @param {number} day @param {State} state @param {number} now @param {boolean} [observe] */
  settle(day, state, now, observe = true) {
    const queue = this.db
      .prepare(
        "SELECT * FROM garden_event_followups WHERE trigger_day<=? AND status='pending' ORDER BY trigger_day,id",
      )
      .all(day);
    const seed = String(
      this.db.prepare("SELECT seed FROM garden_weather_seed WHERE id=1").get()
        ?.seed,
    );
    for (const row of queue) {
      const payload = JSON.parse(String(row.payload));
      const owner = /** @type {Owner} */ ({
        kind: row.actor_kind,
        id: row.actor_id,
        generation: payload.generation,
      });
      const id = String(row.id);
      const draw = createHash("sha256")
        .update(JSON.stringify([seed, row.source_event_id, row.kind]))
        .digest()
        .readUInt32BE();
      let title, text, cropId;
      if (row.kind === "cat_gift") {
        title = "借棚小猫的回信";
        text = "借棚过夜的小猫离开前，在棚下留下了谢意。";
        if (this.active(owner))
          this.gifts.grantEventItem(owner, catGifts[draw % catGifts.length]);
      } else if (row.kind === "hedgehog_seed") {
        title = "草莓刺猬的回礼";
        const crops = Object.entries(state.settings.crops)
          .filter(([, crop]) => crop.enabled && crop.market)
          .sort(
            ([a, left], [b, right]) =>
              right.seedPrice - left.seedPrice || a.localeCompare(b),
          )
          .slice(0, 3);
        if (crops.length) {
          const [id, crop] = crops[draw % crops.length];
          cropId = id;
          state.seeds[id] = (state.seeds[id] ?? 0) + 1;
          text = `得到草莓的刺猬给花园背回了一粒${crop.name}种子。`;
        } else {
          state.fertilizer++;
          text = "得到草莓的刺猬给花园背回了一份肥料。";
        }
      } else {
        title = "候鸟离园的纪念";
        text = `昨天在 ${payload.plot} 号地${payload.cropName}旁歇脚的候鸟平安飞走，给花园留下了纪念。`;
        this.gifts.grantEventItem(admin, "migratory-feather");
      }
      state.revision++;
      this.db
        .prepare(
          "UPDATE garden_state SET seeds=?,fertilizer=?,revision=revision+1 WHERE id=1",
        )
        .run(JSON.stringify(state.seeds), state.fertilizer);
      this.journal.record({
        type: "followup",
        clock: (Number(row.trigger_day) - 1) * DAY,
        source: "action",
        detail: {
          stage: text,
          name: title,
          eventId: String(row.source_event_id),
          cropId,
        },
        key: `followup:${id}`,
      });
      this.db
        .prepare(
          "UPDATE garden_event_followups SET status='settled',settled_at=?,payload=? WHERE id=?",
        )
        .run(now, JSON.stringify({ ...payload, title, text }), id);
      if (observe && owner.kind === "agent" && this.active(owner)) {
        this.recordObservation?.(
          owner,
          {
            kind: "followup",
            key: `followup:${id}`,
            title,
            body: `你先前在花园作出的选择有了回响。${text}`,
          },
          now,
        );
      }
    }
  }

  /** @param {number} day */
  view(day) {
    return this.db
      .prepare(
        `SELECT id,trigger_day,payload FROM garden_event_followups
      WHERE trigger_day<=? AND status='settled' ORDER BY trigger_day DESC,id LIMIT 5`,
      )
      .all(day)
      .map((row) => {
        const { title, text } = JSON.parse(String(row.payload));
        return {
          id: String(row.id),
          type: "followup",
          day: Number(row.trigger_day),
          title,
          text,
        };
      });
  }

  /** @param {number} day @param {number} plot @param {string} plantId */
  wasHarvested(day, plot, plantId) {
    return Boolean(
      this.db
        .prepare(
          `SELECT 1 FROM garden_facts AS fact,json_each(fact.plants) AS plant
      WHERE fact.type='harvest' AND fact.clock>=? AND fact.clock<?
        AND json_extract(plant.value,'$.plantId')=? AND json_extract(plant.value,'$.plot')=? LIMIT 1`,
        )
        .get((day - 1) * DAY, day * DAY, plantId, plot),
    );
  }

  /** @param {string} plantId */
  carers(plantId) {
    return this.db
      .prepare(
        `SELECT DISTINCT actor_kind AS kind,actor_id AS id,
        json_extract(detail,'$.actorGeneration') AS generation FROM garden_facts AS fact,json_each(fact.plants) AS plant
      WHERE fact.type IN ('planted','water','fertilize') AND actor_id IS NOT NULL
        AND json_extract(plant.value,'$.plantId')=?`,
      )
      .all(plantId);
  }

  /** @param {GardenEvent} event @param {State} state @param {Record<string,import("node:sqlite").SQLOutputValue>[]} [stock] */
  actions(event, state, stock) {
    if (event.kind !== "choice" || event.status !== "open") return [];
    const lots =
      stock ??
      this.db
        .prepare(
          "SELECT id,crop_id FROM garden_harvests WHERE quantity>0 ORDER BY rowid",
        )
        .all();
    return event.effect.options.flatMap((/** @type {any} */ option) => {
      const { id: choiceId, label, description, cost } = option;
      const base = { eventId: event.id, choiceId };
      const action = (
        /** @type {typeof base & {plot?:number,harvestId?:string}} */ args,
        /** @type {string} */ suffix = "",
      ) => ({ label: label + suffix, description, kind: "choose_event", args });
      if (cost?.kind === "shelter")
        return state.plots
          .filter(({ sheltered }) => sheltered)
          .map(({ id: plot }) => action({ ...base, plot }, ` · ${plot} 号地`));
      if (cost?.kind === "harvest") {
        const crops =
          cost.cropIds ??
          (event.effect.story === "hedgehog"
            ? ["strawberry"]
            : event.effect.story === "tea"
              ? teaCrops
              : undefined);
        return lots.flatMap((/** @type {any} */ row) =>
          crops && !crops.includes(row.crop_id)
            ? []
            : [
                action(
                  { ...base, harvestId: String(row.id) },
                  ` · ${state.settings.crops[row.crop_id]?.name ?? row.crop_id}`,
                ),
              ],
        );
      }
      return [
        action(base, cost?.kind === "coins" ? ` · ${cost.amount} 元` : ""),
      ];
    });
  }

  /** @param {GardenEvent} entry @param {State} state @param {number} now @param {number} day
   * @param {{choiceId:string,harvestId?:string,plot?:number}} choice @param {Owner} owner @param {(coins:number)=>void} pay
   * @param {()=>void} grantMystery */
  choose(entry, state, now, day, choice, owner, pay, grantMystery) {
    if (entry.kind !== "choice") throw Error("GARDEN_EVENT_CHOICE_INVALID");
    const allowed = this.actions(entry, state).find(
      (
        /** @type {{args:{choiceId:string,plot?:number,harvestId?:string}}} */ {
          args,
        },
      ) =>
        args.choiceId === choice.choiceId &&
        args.plot === choice.plot &&
        args.harvestId === choice.harvestId,
    );
    if (!allowed) throw Error("GARDEN_EVENT_CHOICE_INVALID");
    const option = entry.effect.options.find(
      (/** @type {{id:string}} */ { id }) => id === choice.choiceId,
    );
    if (choice.harvestId)
      this.db
        .prepare(
          "UPDATE garden_harvests SET quantity=quantity-1,last_use='choose_event' WHERE id=? AND quantity>0",
        )
        .run(choice.harvestId);
    if (option?.cost?.kind === "coins") pay(-option.cost.amount);
    const reward = option?.immediateReward;
    const coins = reward?.kind === "coins" ? reward.amount : 0;
    if (coins) pay(coins);
    if (reward?.kind === "seed") {
      if (!state.settings.crops[reward.cropId]?.enabled)
        throw Error("GARDEN_SEED_UNAVAILABLE");
      state.seeds[reward.cropId] =
        (state.seeds[reward.cropId] ?? 0) + reward.quantity;
    }
    if (reward?.kind === "fertilizer") state.fertilizer += reward.quantity;
    if (reward?.kind === "gift")
      this.gifts.grantEventItem(owner, reward.giftId);
    let detail = option?.description ?? allowed.description;
    if (entry.effect.story === "tea")
      detail = "花园里泡起了茶，今天来的伙伴都能一起喝。";
    if (entry.effect.story === "sketch" && choice.choiceId === "commission") {
      const names = state.plots.flatMap(({ plant }) =>
        plant?.status === "mature" ? [plant.crop.name] : [],
      );
      detail = `速写师画下了${[...new Set(names.length ? names : (entry.outcome?.matureNames ?? []))].join("、")}。`;
      this.gifts.grantEventItem(owner, "garden-sketch-card", detail);
    }
    if (entry.effect.story === "trader") {
      grantMystery();
      if (!unlockGardenRumor(this.db, this.journal, "trader", day, now))
        state.fertilizer++;
      detail = "交换客留下了一袋神秘种子。";
    }
    const followup = option?.scheduleFollowup;
    if (followup)
      this.schedule(entry.id, day + followup.delayDays, followup.kind, owner, {
        plot: choice.plot,
      });
    const outcome = {
      choiceId: choice.choiceId,
      label: option?.label ?? allowed.label,
      detail,
      ...(choice.plot && { pausedPlot: choice.plot }),
      ...(coins && { coins }),
    };
    this.journal.record({
      type: "event",
      clock: state.clock,
      actor: owner,
      source: "action",
      detail: { name: entry.name, stage: outcome.label, eventId: entry.id },
      key: `choice:${entry.id}`,
    });
    return { eventId: entry.id, outcome };
  }
}
