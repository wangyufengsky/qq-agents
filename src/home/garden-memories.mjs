import { DAY, HOUR } from "./garden-rules.mjs";
import { GardenGifts, gardenOwnerKey } from "./garden-items.mjs";
import { gardenPlantRef } from "./garden-journal.mjs";
import { gardenPlantSnapshot } from "./garden-public.mjs";
import {
  gardenStageAt,
  gardenStageLabel,
} from "../../public/garden-art/stages.js";
import { gardenGifts } from "../../public/garden-art/gifts.js";
import {
  gateStyleIds,
  lampIds,
  memoryDescription,
  memorySceneIds,
  memorySeason,
} from "./garden-memory-rules.mjs";
import {
  memorySceneContext,
  memorySceneActions,
  performMemoryScene,
  startMemoryScene,
} from "./garden-memory-scenes.mjs";

const living = (state) =>
  state.plots.filter(({ plant }) => plant && plant.status !== "withered");
const rain = (weather) => ["drizzle", "storm"].includes(weather.kind);
const flowers = [
  "catnip",
  "sunflower",
  "moonflower",
  "morning-glory",
  "hydrangea",
  "chamomile",
  "mistbell",
  "balsam",
  "paper-moon",
  "echo-tuberose",
];
const cap = (plant) =>
  plant
    ? {
        plantId: plant.id,
        cropId: plant.cropId,
        name: plant.crop.name,
        status: plant.status,
        progress: Math.round(
          Math.min(1, plant.growth / plant.crop.hours) * 100,
        ),
      }
    : null;
const photoPlots = (plots) =>
  plots.map(({ id: plot, plant }) => ({
    plot,
    name: plant?.crop.name ?? null,
    stage: plant ? gardenStageLabel(plant.cropId, gardenStageAt(plant)) : null,
  }));
const ingredient = (plant) => ({
  ...cap(plant),
  cropName: plant.crop.name,
  quality: plant.quality,
  ...(plant.maturedAt !== undefined && {
    maturedDay: Math.floor(plant.maturedAt / DAY) + 1,
  }),
});

export class GardenMemories {
  constructor(db, journal) {
    this.db = db;
    this.journal = journal;
    this.gifts = new GardenGifts(db);
    const previous = db
      .prepare("SELECT clock FROM garden_state WHERE id=1")
      .get();
    const last = db.prepare("SELECT MAX(day) AS day FROM garden_days").get();
    db.prepare("INSERT OR IGNORE INTO garden_memory_coverage VALUES(1,?)").run(
      Math.max(
        Math.floor(Number(previous?.clock ?? 0) / DAY) + 1,
        Number(last?.day ?? 1),
      ),
    );
    this.firstDay = Number(
      db
        .prepare("SELECT first_day FROM garden_memory_coverage WHERE id=1")
        .get().first_day,
    );
  }

  context(state, day) {
    const memoryLots = this.db
      .prepare(
        `SELECT DISTINCT crop_id || ':' || json_extract(harvest_meta,'$.harvestStage') AS stage
      FROM garden_harvests WHERE quantity>0 AND crop_id IN ('drift-gourd','paper-moon')`,
      )
      .all()
      .map(({ stage }) => stage);
    const memoryItems = this.db
      .prepare(
        `SELECT DISTINCT gift_id FROM garden_items AS item
      WHERE consumed=0 AND (item.owner=json_array('admin','administrator','instance') OR EXISTS
        (SELECT 1 FROM home_identities WHERE active=1 AND item.owner=json_array('agent',agent_id,generation)))
      AND NOT EXISTS (SELECT 1 FROM garden_table_loans WHERE item_id=item.id)
      AND gift_id IN (SELECT value FROM json_each(?))`,
      )
      .all(
        JSON.stringify([...gateStyleIds, ...lampIds, "perilla-printed-cloth"]),
      )
      .map(({ gift_id }) => gift_id);
    return {
      ...memorySceneContext(this.db, state),
      memoryLots,
      memoryItems,
      memoryHasPhotos: Boolean(
        this.db
          .prepare("SELECT 1 FROM garden_memory_days WHERE day<? LIMIT 1")
          .get(day),
      ),
      memoryGateUsed: Boolean(
        this.db
          .prepare("SELECT 1 FROM garden_gate_history WHERE season=?")
          .get(memorySeason(day)),
      ),
    };
  }

  start(event, state, weather, day) {
    event.game = {};
    if (memorySceneIds.includes(event.effect.story))
      startMemoryScene(this.db, event, state, weather, day);
  }

  view(event, state) {
    const { game, ...safe } = event;
    const description = memoryDescription(event.effect.story);
    if (event.effect.story === "old_photo") {
      const day = Math.floor(state.clock / DAY) + 1;
      safe.photos = this.photos(day).map(({ day, plots }) => ({
        day,
        plots: photoPlots(JSON.parse(plots)),
      }));
      safe.today = photoPlots(state.plots);
    }
    if (
      event.effect.story === "future_jar" &&
      game?.jar &&
      event.status !== "resolved"
    ) {
      const { facts, required } = this.jarEvidence(game.jar, state);
      safe.outcome = {
        detail: `罐子在等${game.jar.kind === "rain" ? "真实雨日" : "实际花开"}，目前 ${facts.length}/${required}。`,
      };
    }
    return { ...safe, description };
  }

  owned(owner, ids) {
    return this.db
      .prepare(
        `SELECT id,gift_id FROM garden_items AS item WHERE owner=? AND consumed=0
      AND gift_id IN (SELECT value FROM json_each(?))
      AND NOT EXISTS (SELECT 1 FROM garden_table_loans WHERE item_id=item.id) ORDER BY rowid`,
      )
      .all(gardenOwnerKey(owner), JSON.stringify(ids));
  }

  lots(cropId, stage) {
    return this.db
      .prepare(
        `SELECT id FROM garden_harvests
      WHERE crop_id=? AND quantity>0 AND json_extract(harvest_meta,'$.harvestStage')=? ORDER BY rowid`,
      )
      .all(cropId, stage);
  }

  useLot(id, state) {
    const lot = this.db
      .prepare(
        `SELECT id,crop_id,quality,plant_id,json_extract(harvest_meta,'$.harvestStage') AS stage
      FROM garden_harvests WHERE id=? AND quantity>0`,
      )
      .get(id);
    if (
      !lot ||
      !this.db
        .prepare(
          "UPDATE garden_harvests SET quantity=quantity-1,last_use='choose_event' WHERE id=? AND quantity>0",
        )
        .run(id).changes
    )
      throw Error("GARDEN_EVENT_CHOICE_INVALID");
    const fact = this.db
      .prepare(
        `SELECT detail FROM garden_facts WHERE type='harvest' AND json_extract(detail,'$.harvestId')=?`,
      )
      .get(id);
    const recorded = fact?.detail ? JSON.parse(fact.detail) : {};
    return {
      cropId: lot.crop_id,
      cropName: recorded.cropName ?? state.settings.crops[lot.crop_id].name,
      quality: lot.quality,
      harvestStage: lot.stage,
      ...(lot.plant_id && { plantId: lot.plant_id }),
      ...(Number.isInteger(recorded.maturedDay) && {
        maturedDay: recorded.maturedDay,
      }),
    };
  }

  actions(event, state, owner) {
    if (
      !owner ||
      event?.kind !== "memory" ||
      (event.status !== "open" && !this.isActive(event))
    )
      return [];
    const { story } = event.effect;
    if (memorySceneIds.includes(story))
      return memorySceneActions(this.db, event, state, owner);
    const day = Math.floor(state.clock / DAY) + 1;
    const game = event.game ?? {};
    const a = (choiceId, label, description, args = {}) => ({
      kind: "choose_event",
      label,
      description,
      args: { eventId: event.id, choiceId, ...args },
    });
    switch (story) {
      case "drift_gourd":
        return game.route
          ? [
              a(
                "cut-dipper",
                "切成一柄水瓢",
                "留下实际航程，把这只葫芦制成水瓢。",
              ),
              a(
                "keep-gourd",
                "收好整只葫芦",
                "原样留下这只葫芦，之后可主动陈列。",
              ),
            ]
          : game.release
            ? []
            : this.lots("drift-gourd", "floating").map(({ id }) =>
                a(
                  "release-gourd",
                  "放走一只浮熟葫芦",
                  "用一份真实浮熟收成，第三天以后看它返回。",
                  { harvestId: id },
                ),
              );
      case "old_photo":
        return this.photos(day).flatMap(({ day: referenceDay, plots }) =>
          JSON.parse(plots)
            .filter(
              ({ id, plant }) =>
                plant || state.plots.find((plot) => plot.id === id)?.plant,
            )
            .map(({ id: plot }) =>
              a(
                "compare-plot",
                "对照这格旧照片",
                "翻开照片和今天的园子，保存该格花卡。",
                { referenceDay, plot },
              ),
            ),
        );
      case "future_jar":
        return game.jar
          ? this.jarReady(game.jar, state)
            ? [a("open-jar", "开罐看看", "照着真实事件记录打开这只罐子。")]
            : []
          : living(state).flatMap(({ id: plot }) => [
              a(
                "bury-blooms",
                "留叶等两次花开",
                "从实际园中一株叶片做记号，等种植记录里的两次花开。",
                { plot },
              ),
              a(
                "bury-rain",
                "留叶等三场雨",
                "从实际园中一株叶片做记号，等三个确实落雨的花园日。",
                { plot },
              ),
            ]);
      case "paper_shadow": {
        const hour = (state.clock % DAY) / HOUR;
        if (hour >= 6 && hour < 19) return [];
        return this.owned(owner, lampIds).flatMap((item) =>
          this.lots("paper-moon", "silver").flatMap((lot) =>
            living(state).map(({ id: plot }) =>
              a(
                "make-shadow-card",
                "拓好一张纸月夜景",
                "用银荚、自己的南瓜灯与这一株真实植物取影。",
                { itemId: item.id, harvestId: lot.id, plot },
              ),
            ),
          ),
        );
      }
      case "gate_display":
        return this.db
          .prepare("SELECT 1 FROM garden_gate_history WHERE season=?")
          .get(memorySeason(day))
          ? []
          : this.owned(owner, gateStyleIds).map(({ id, gift_id }) =>
              a(
                "hang-keepsake",
                "用这件物品的样式挂园门",
                `本季园门记下${gardenGifts[gift_id].name}的样式，原物和赠言仍由自己保留。`,
                { itemId: id },
              ),
            );
      default:
        return [];
    }
  }

  isActive(event) {
    return (
      event?.kind === "memory" &&
      event.status !== "resolved" &&
      event.game?.active === true
    );
  }

  saveDay(state, current, effectiveWeather, boundary, now) {
    const day = current.day;
    if (day < this.firstDay) return;
    const start = (day - 1) * DAY;
    const forecast = current.weather;
    const end = day * DAY;
    const changes =
      effectiveWeather.id !== forecast.id && boundary > start && boundary < end;
    const weatherMarks = changes
      ? [
          {
            name: forecast.name,
            from: start,
            to: boundary,
            rain: rain(forecast),
          },
          {
            name: effectiveWeather.name,
            from: boundary,
            to: end,
            rain: rain(effectiveWeather),
          },
        ]
      : [
          {
            name: effectiveWeather.name,
            from: start,
            to: end,
            rain: rain(effectiveWeather),
          },
        ];
    const rainClock = weatherMarks.find((mark) => mark.rain)?.from ?? null;
    this.db
      .prepare(
        "INSERT OR IGNORE INTO garden_memory_days VALUES(?,?,?,?,?,?,?,?)",
      )
      .run(
        day,
        now,
        state.revision,
        JSON.stringify(state.plots),
        state.plots.filter(({ plant }) => plant).length,
        JSON.stringify(effectiveWeather),
        JSON.stringify(weatherMarks),
        rainClock,
      );
  }

  jarEvidence(jar, state) {
    if (jar.kind === "rain") {
      const facts = this.db
        .prepare(
          `SELECT day,weather_marks FROM garden_memory_days
        WHERE rain_clock>? AND rain_clock<=? ORDER BY rain_clock LIMIT 3`,
        )
        .all(jar.clock, state.clock)
        .map(({ day, weather_marks }) => ({
          day,
          weather: JSON.parse(weather_marks)
            .filter((mark) => mark.rain)
            .map(({ name }) => name)
            .join("、"),
        }));
      return { facts, required: 3 };
    }
    const facts = this.db
      .prepare(
        `SELECT fact.id,fact.clock,fact.plants FROM garden_facts AS fact
      WHERE type='mature' AND fact.id>? AND clock>=? AND clock<=? AND EXISTS (
        SELECT 1 FROM json_each(fact.plants) AS ref WHERE json_extract(ref.value,'$.cropId') IN (SELECT value FROM json_each(?))
          AND fact.unique_key=json_extract(ref.value,'$.plantId') || ':mature')
      ORDER BY clock,id LIMIT 2`,
      )
      .all(jar.after, jar.clock, state.clock, JSON.stringify(flowers))
      .map(({ id, clock, plants }) => ({
        factId: id,
        day: Math.floor(clock / DAY) + 1,
        plant: JSON.parse(plants)[0]?.name,
      }));
    return { facts, required: 2 };
  }

  jarReady(jar, state) {
    const { facts, required } = this.jarEvidence(jar, state);
    return facts.length >= required;
  }

  perform(event, state, choice, owner, now) {
    const allowed = this.actions(event, state, owner).find(({ args }) =>
      [
        "choiceId",
        "plot",
        "harvestId",
        "itemId",
        "cropId",
        "referenceDay",
      ].every((key) => args[key] === choice[key]),
    );
    if (
      !allowed ||
      (choice.text !== undefined && !allowed.textPrompt) ||
      (allowed.textPrompt && !choice.text)
    )
      throw Error(
        event.status === "resolved"
          ? "GARDEN_EVENT_ALREADY_RESOLVED"
          : "GARDEN_EVENT_CHOICE_INVALID",
      );
    const { story } = event.effect;
    if (memorySceneIds.includes(story))
      return performMemoryScene(
        this.db,
        this.journal,
        event,
        state,
        choice,
        owner,
        now,
      );
    const game = event.game;
    const day = Math.floor(state.clock / DAY) + 1;
    let detail,
      extra = {},
      plants = [];
    if (story === "drift_gourd") {
      if (!game.release) {
        game.release = {
          startedAt: state.clock,
          dueDay: day + 3,
          ingredient: this.useLot(choice.harvestId, state),
        };
        game.active = true;
        this.db
          .prepare("INSERT INTO garden_memory_returns VALUES(?,?)")
          .run(event.id, game.release.dueDay);
        detail = `放走了一只真的浮熟葫芦。预计第 ${game.release.dueDay} 天回来。`;
      } else {
        const giftId =
          choice.choiceId === "cut-dipper" ? "gourd-dipper" : "drift-gourd";
        detail = `${giftId === "gourd-dipper" ? "把返回的葫芦切成了水瓢" : "把返回的葫芦原样收好"}。${this.routeText(game.route)}`;
        this.gifts.grantEventItem(owner, giftId, detail, {
          recipeId: giftId,
          ingredients: [game.release.ingredient],
          weatherRoute: game.route,
        });
        game.active = false;
      }
    } else if (story === "old_photo") {
      const { referenceDay, plot } = choice;
      const row = this.day(referenceDay);
      const oldPlot = JSON.parse(row.plots).find(({ id }) => id === plot);
      const current = state.plots.find(({ id }) => id === plot);
      const before = cap(oldPlot.plant),
        after = cap(current.plant);
      const then = before
        ? `是${before.name}（进度 ${before.progress}%）`
        : "是空地";
      const today = after
        ? `是${after.name}（进度 ${after.progress}%）`
        : "是空地";
      detail = `第 ${referenceDay} 天的 ${plot} 号地${then}；今天${today}。`;
      const imageRequest = before
        ? { view: "plant_image", referenceDay, plot }
        : { view: "plant_image", plantId: after.plantId };
      extra = {
        plantCard: { referenceDay, plot, before, after, imageRequest },
      };
      plants = [gardenPlantRef(plot, oldPlot.plant ?? current.plant)];
    } else if (story === "future_jar") {
      if (!game.jar) {
        const target = state.plots.find(({ id }) => id === choice.plot);
        const leaf = gardenPlantRef(target.id, target.plant);
        game.jar = {
          leaf,
          clock: state.clock,
          after: this.journal.latestId(),
          kind: choice.choiceId === "bury-rain" ? "rain" : "blooms",
        };
        game.active = true;
        detail = `在 ${target.id} 号地取了${leaf.name}的一片叶子记进罐里，等${game.jar.kind === "rain" ? "三个雨日" : "两次花开"}。`;
        plants = [leaf];
      } else {
        const { facts } = this.jarEvidence(game.jar, state);
        detail = `打开留有${game.jar.leaf.name}叶片的罐子。等到的记录是${facts.map((row) => `第 ${row.day} 天${row.weather ?? row.plant}`).join("、")}。`;
        extra = { evidence: facts };
        game.active = false;
      }
    } else if (story === "paper_shadow") {
      const plant = state.plots.find(({ id }) => id === choice.plot).plant;
      const silver = this.useLot(choice.harvestId, state);
      plants = [gardenPlantRef(choice.plot, plant)];
      detail = `把南瓜灯挪到 ${choice.plot} 号地旁，用银荚给${plant.crop.name}留下了一张真实夜景拓影。`;
      this.gifts.grantEventItem(owner, "paper-moon-night-card", detail, {
        recipeId: "paper-moon-night-card",
        ingredients: [silver, ingredient(plant)],
        scene: { day, plot: choice.plot, period: "night" },
      });
    } else if (story === "gate_display") {
      const item = this.owned(owner, gateStyleIds).find(
        ({ id }) => id === choice.itemId,
      );
      const season = memorySeason(day);
      const display = {
        style: item.gift_id,
        name: gardenGifts[item.gift_id].name,
      };
      this.db
        .prepare("INSERT INTO garden_gate_history VALUES(?,?,?)")
        .run(season, day, JSON.stringify(display));
      detail = `第 ${season} 季门口挂起了${display.name}的样式，原物仍由物主收好。`;
      extra = { season, display };
    }
    if (!game.active) event.status = "resolved";
    event.outcome = {
      detail,
      ...extra,
      ...(choice.plot && { plots: [choice.plot] }),
    };
    game.steps = (game.steps ?? 0) + 1;
    this.journal.record({
      type: "event",
      clock: state.clock,
      source: "action",
      actor: owner,
      plants,
      detail: { name: event.name, stage: detail, eventId: event.id },
      key: `garden-memory:${event.id}:${game.steps}`,
    });
    return event.outcome;
  }

  day(day) {
    return this.db
      .prepare("SELECT * FROM garden_memory_days WHERE day=?")
      .get(day);
  }

  photos(day) {
    return this.db
      .prepare(
        "SELECT day,plots FROM garden_memory_days WHERE day<? ORDER BY day DESC LIMIT 8",
      )
      .all(day);
  }

  historicalCard(referenceDay, plot, state, now) {
    const row = this.day(referenceDay);
    if (!row) throw Error("INVALID_REQUEST");
    const plots = JSON.parse(row.plots);
    const plant = plots.find(({ id }) => id === plot)?.plant;
    if (!plant) throw Error("INVALID_REQUEST");
    const frozen = {
      ...state,
      plots,
      weather: JSON.parse(row.weather),
      clock: referenceDay * DAY - 1,
      revision: row.revision,
    };
    const history = this.journal.query(
      { plantId: plant.id, toDay: referenceDay, limit: 20 },
      true,
      true,
    );
    const detail = {
      ...history,
      plant: {
        ...gardenPlantRef(plot, plant),
        status: plant.status,
        plantedClock: plant.sownClock ?? null,
        snapshot: plant,
      },
      choices: [],
    };
    return {
      ...gardenPlantSnapshot(frozen, detail, { running: true, now, plot }),
      referenceDay,
      recordedAt: new Date(row.captured_at).toISOString(),
    };
  }

  routeText(route) {
    return route.length
      ? `路上经过${route.map(({ day, weather }) => `第 ${day} 天的${weather.join("、")}`).join("，")}。`
      : "没有可核对的沿途天气。";
  }

  settle(day) {
    for (const due of this.db
      .prepare(
        "SELECT id,due_day FROM garden_memory_returns WHERE due_day<=? ORDER BY due_day",
      )
      .all(day)) {
      const from = Number(due.id.split(":")[0]);
      const event = JSON.parse(
        this.db.prepare("SELECT value FROM garden_events WHERE day=?").get(from)
          .value,
      );
      const route = this.db
        .prepare(
          "SELECT day,weather_marks FROM garden_memory_days WHERE day>=? AND day<? ORDER BY day",
        )
        .all(from, due.due_day)
        .map(({ day, weather_marks }) => ({
          day,
          weather: JSON.parse(weather_marks)
            .filter((mark) => mark.to > event.game.release.startedAt)
            .map(({ name }) => name),
        }))
        .filter(({ weather }) => weather.length);
      event.game.route = route;
      const title = "漂流葫芦回到了岸边";
      const text = title + "。" + this.routeText(route);
      event.outcome = { detail: text };
      this.db
        .prepare("UPDATE garden_events SET value=? WHERE day=?")
        .run(JSON.stringify(event), from);
      this.db
        .prepare("DELETE FROM garden_memory_returns WHERE id=?")
        .run(due.id);
      this.db
        .prepare("INSERT INTO garden_memory_followups VALUES(?,?,?,?)")
        .run(due.id, due.due_day, title, text);
      this.journal.record({
        type: "followup",
        clock: (due.due_day - 1) * DAY,
        source: "action",
        detail: { name: title, stage: text, eventId: event.id },
        key: `garden-memory-return:${event.id}`,
      });
    }
  }

  followups(day) {
    return this.db
      .prepare(
        "SELECT id,day,title,text FROM garden_memory_followups WHERE day<=? ORDER BY day DESC LIMIT 5",
      )
      .all(day)
      .map((row) => ({ ...row, type: "followup" }));
  }

  projects(day, state, owner) {
    return this.db
      .prepare(
        `SELECT value FROM garden_events WHERE day<?
      AND json_extract(value,'$.kind')='memory' AND json_extract(value,'$.game.active')=1 ORDER BY day DESC`,
      )
      .all(day)
      .map(({ value }) => JSON.parse(value))
      .filter((event) => this.isActive(event))
      .map((event) => ({
        id: event.id,
        name: event.name,
        detail: this.view(event, state).outcome?.detail,
        actions: this.actions(event, state, owner),
      }));
  }

  gateHistory() {
    return this.db
      .prepare(
        "SELECT season,day,display FROM garden_gate_history ORDER BY season DESC",
      )
      .all()
      .map(({ season, day, display }) => ({
        season,
        day,
        display: JSON.parse(display),
      }));
  }
}
