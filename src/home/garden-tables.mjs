import { DAY, perillaLeafPrint } from "./garden-rules.mjs";
import { GardenGifts, gardenOwnerKey } from "./garden-items.mjs";
import { gardenPlantRef } from "./garden-journal.mjs";
import { colorCrops, tableDescription } from "./garden-table-rules.mjs";
import {
  tableSceneActions,
  performTableScene,
} from "./garden-table-scenes.mjs";

const lampIds = ["pumpkin-lantern", "craft-pumpkin-lantern"];
const scenes = ["popcorn", "bench", "mint_ice", "menu"];
const perilla = (state) =>
  state.plots.filter(
    ({ plant }) => plant?.cropId === "perilla" && plant.status === "mature",
  );
const colors = {
  sunflower: "向日葵黄",
  moonflower: "夜来香淡白",
  mistbell: "星雾蓝紫",
  catnip: "猫薄荷绿",
  hydrangea: "绣球雾紫",
  chamomile: "洋甘菊淡黄",
  perilla: "紫苏叶背紫",
  "morning-glory": "牵牛花淡蓝",
  balsam: "凤仙粉红",
};
const variants = { rain_blue: "雨蓝", sun_pink: "晴粉", mist_lilac: "雾紫" };
const personName = (owner) =>
  owner.name ?? (owner.kind === "admin" ? "管理员" : owner.id);
const activePacket = (event) =>
  event?.kind === "table" &&
  event.status !== "resolved" &&
  event.game?.active === true;

export class GardenTables {
  constructor(db, journal) {
    this.db = db;
    this.journal = journal;
    this.gifts = new GardenGifts(db);
  }

  start(event) {
    event.game = {};
  }

  view(event) {
    const { game: _game, ...safe } = event;
    return { ...safe, description: tableDescription(event.effect.story) };
  }

  lots() {
    return this.db
      .prepare(
        "SELECT id,crop_id,quality,plant_id,harvest_meta,json_extract(harvest_meta,'$.harvestStage') AS harvest_stage FROM garden_harvests WHERE quantity>0 ORDER BY rowid",
      )
      .all();
  }

  context() {
    const tableItems = Object.fromEntries(
      this.db
        .prepare(
          `SELECT gift_id,count(*) AS n FROM garden_items AS item
      WHERE consumed=0 AND gift_id IN ('craft-strawberry-jam','pumpkin-lantern','craft-pumpkin-lantern')
        AND (gift_id<>'craft-strawberry-jam' OR json_extract(craft_meta,'$.recipeId')='craft-strawberry-jam')
        AND (item.owner=json_array('admin','administrator','instance') OR EXISTS (SELECT 1 FROM home_identities
          WHERE active=1 AND item.owner=json_array('agent',agent_id,generation)))
        AND NOT EXISTS (SELECT 1 FROM garden_table_loans WHERE item_id=item.id)
      GROUP BY gift_id`,
        )
        .all()
        .map(({ gift_id, n }) => [gift_id, n]),
    );
    const tableLots = this.db
      .prepare(
        `SELECT DISTINCT crop_id,json_extract(harvest_meta,'$.harvestStage') AS harvest_stage
      FROM garden_harvests WHERE quantity>0 AND crop_id IN ('sweet-corn','pocket-pumpkin')`,
      )
      .all();
    return { tableLots, tableItems };
  }

  owned(owner, ...giftIds) {
    if (!owner) return [];
    return this.db
      .prepare(
        `SELECT id,craft_meta FROM garden_items AS item
      WHERE item.owner=? AND gift_id IN (SELECT value FROM json_each(?)) AND consumed=0
        AND (gift_id<>'craft-strawberry-jam' OR json_extract(craft_meta,'$.recipeId')='craft-strawberry-jam')
        AND NOT EXISTS (SELECT 1 FROM garden_table_loans WHERE item_id=item.id) ORDER BY rowid`,
      )
      .all(gardenOwnerKey(owner), JSON.stringify(giftIds));
  }

  actions(event, state, owner) {
    if (
      !owner ||
      event?.kind !== "table" ||
      (event.status !== "open" && !this.isActive(event, state))
    )
      return [];
    const { story } = event.effect;
    if (scenes.includes(story))
      return tableSceneActions(this.db, event, state, owner);
    const game = event.game ?? {};
    const day = Math.floor(state.clock / DAY) + 1;
    const a = (choiceId, label, description, args = {}) => ({
      kind: "choose_event",
      label,
      description,
      args: { eventId: event.id, choiceId, ...args },
    });
    switch (story) {
      case "perilla_cloth":
        return game.first
          ? perilla(state)
              .filter(
                ({ plant }) =>
                  day > game.firstDay && plant.id !== game.first.plantId,
              )
              .map(({ id }) =>
                a(
                  "finish-cloth",
                  "在另一半印叶",
                  "用另一株紫苏，两道叶印都留下来源与署名。",
                  { plot: id },
                ),
              )
          : perilla(state).flatMap(({ id }) => [
              a(
                "keep-half",
                "印半块收好",
                "把这株紫苏的半块叶印收进自己的物品栏。",
                { plot: id },
              ),
              a(
                "leave-half",
                "印半块留在桌上",
                "把另一半留给愿意接力的伙伴。",
                { plot: id },
              ),
            ]);
      case "pumpkin_face":
        if (game.first)
          return [
            ...((!game.mouth && [
              a("carve-mouth", "补刻嘴巴", "留下第二道手作署名。"),
            ]) ||
              []),
            a(
              "light-lamp",
              "点亮南瓜灯",
              "把已刻好的脸点亮，收进自己的物品栏。",
            ),
          ];
        return this.lots()
          .filter(
            (lot) =>
              lot.crop_id === "pocket-pumpkin" && lot.harvest_stage === "hard",
          )
          .map((lot) =>
            a("carve-eyes", "刻出眼睛", "用一份硬皮口袋瓜开始。", {
              harvestId: lot.id,
            }),
          );
      case "jam_spoon":
        return game.jam
          ? [a("taste-spoon", "抹在面包上", "吃掉之前留下的最后一勺。")]
          : this.owned(owner, "craft-strawberry-jam").flatMap(({ id }) => [
              a(
                "taste-spoon",
                "自己抹面包",
                "用掉自己这瓶真实草莓果酱的最后一勺。",
                { itemId: id },
              ),
              a(
                "leave-spoon",
                "留给后来者",
                "这瓶原有果酱会用掉，最后一勺留在桌上。",
                { itemId: id },
              ),
            ]);
      case "nest_edge":
        return this.lots()
          .filter(
            (lot) =>
              ["lambs-ear", "sweet-corn"].includes(lot.crop_id) &&
              !game.materials?.some(
                (material) => material.cropId === lot.crop_id,
              ),
          )
          .map((lot) =>
            a(
              "weave-edge",
              "加一种巢缘材料",
              "消耗一份真实收成，次日查看编织结果。",
              { harvestId: lot.id },
            ),
          );
      case "color_swap":
        return this.lots()
          .filter(
            (lot) =>
              colorCrops.includes(lot.crop_id) &&
              lot.crop_id !== game.first?.cropId,
          )
          .map((lot) =>
            a(
              "mix-color",
              game.first ? "补调第二道颜色" : "先调一道颜色",
              "拿一份现场花材或紫苏收成调色。",
              { harvestId: lot.id },
            ),
          );
      case "window_lamp":
        return this.owned(owner, ...lampIds).map(({ id }) =>
          a("lend-lamp", "把这盏留在窗边", "借出这一件原物过夜，次日归还。", {
            itemId: id,
          }),
        );
      default:
        return [];
    }
  }

  isActive(event) {
    return activePacket(event);
  }

  record(event, state, actor, detail, key, plants = []) {
    this.journal.record({
      type: "event",
      clock: state.clock,
      source: "action",
      actor,
      plants,
      detail: { stage: detail, name: event.name, eventId: event.id },
      key: `table:${event.id}:${key}`,
    });
  }

  consumeLot(id, state) {
    const lot = this.lots().find((row) => row.id === id);
    if (
      !lot ||
      !this.db
        .prepare(
          `UPDATE garden_harvests SET quantity=quantity-1,last_use='choose_event'
      WHERE id=? AND quantity>0`,
        )
        .run(id).changes
    )
      throw Error("GARDEN_EVENT_CHOICE_INVALID");
    const fact = this.db
      .prepare(
        `SELECT detail FROM garden_facts WHERE type='harvest' AND json_extract(detail,'$.harvestId')=?`,
      )
      .get(id);
    const atHarvest = fact?.detail ? JSON.parse(fact.detail) : {};
    const meta = lot.harvest_meta ? JSON.parse(lot.harvest_meta) : {};
    const cropId = lot.crop_id;
    return {
      cropId,
      cropName:
        atHarvest.cropName ?? state.settings.crops[cropId]?.name ?? cropId,
      quality: lot.quality,
      ...(lot.plant_id && { plantId: lot.plant_id }),
      ...(lot.harvest_stage && { harvestStage: lot.harvest_stage }),
      ...(Number.isInteger(atHarvest.maturedDay) && {
        maturedDay: atHarvest.maturedDay,
      }),
      ...(atHarvest.variant && { variant: atHarvest.variant }),
      ...(meta.leafFront && { leafFront: meta.leafFront }),
      ...(meta.leafBack && { leafBack: meta.leafBack }),
    };
  }

  item(
    owner,
    giftId,
    event,
    entries,
    detail,
    makers = entries.map(({ makerRef }) => makerRef),
  ) {
    const makerRefs = [
      ...new Map(
        makers.map((person) => [
          JSON.stringify([person.kind, person.id]),
          person,
        ]),
      ).values(),
    ];
    this.gifts.grantEventItem(owner, giftId, detail, {
      recipeId: giftId,
      ingredients: entries,
      makers: makerRefs.map(({ name }) => name),
      makerRefs,
    });
    event.game.active = false;
  }

  perform(event, state, choice, owner, now) {
    const allowed = this.actions(event, state, owner).find(
      ({ args }) =>
        args.choiceId === choice.choiceId &&
        args.plot === choice.plot &&
        args.harvestId === choice.harvestId &&
        args.itemId === choice.itemId &&
        args.cropId === choice.cropId,
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
    if (scenes.includes(story))
      return performTableScene(
        this.db,
        this.journal,
        event,
        state,
        choice,
        owner,
        now,
      );
    const game = event.game;
    const who = personName(owner);
    const makerRef = { kind: owner.kind, id: owner.id, name: who };
    const day = Math.floor(state.clock / DAY) + 1;
    let detail,
      plants = [];
    if (story === "perilla_cloth") {
      const { plant } = state.plots[choice.plot - 1];
      const ref = gardenPlantRef(choice.plot, plant);
      plants = [ref];
      const current = {
        cropId: ref.cropId,
        cropName: ref.name,
        plantId: ref.plantId,
        quality: plant.quality,
        ...(plant.maturedAt !== undefined && {
          maturedDay: Math.floor(plant.maturedAt / DAY) + 1,
        }),
        ...perillaLeafPrint(plant),
        maker: who,
        makerRef,
      };
      if (game.first) {
        detail =
          "一张方巾印好了。两道叶印来自不同株紫苏，成品保留了各自的署名。";
        this.item(
          owner,
          "perilla-printed-cloth",
          event,
          [game.first, current],
          detail,
        );
      } else if (choice.choiceId === "keep-half") {
        detail = `${choice.plot} 号地紫苏印出的半块方巾收好了。`;
        this.item(owner, "perilla-half-cloth", event, [current], detail);
      } else {
        game.first = current;
        game.firstDay = day;
        game.active = true;
        detail = `用 ${choice.plot} 号地的紫苏印了半块方巾，另半边留给后来者。`;
      }
    } else if (story === "pumpkin_face") {
      if (choice.choiceId === "carve-eyes") {
        game.first = {
          ...this.consumeLot(choice.harvestId, state),
          maker: who,
          makerRef,
        };
        game.active = true;
        detail = "硬皮口袋瓜刻好了眼睛，可以直接点灯，也可以接着刻嘴巴。";
      } else if (choice.choiceId === "carve-mouth") {
        game.mouth = makerRef;
        detail = "口袋瓜的嘴巴也刻好了，可以点灯。";
      } else {
        const makers = [
          game.first.makerRef,
          ...(game.mouth ? [game.mouth] : []),
          makerRef,
        ];
        detail = game.mouth
          ? "一盏有眼睛和嘴巴的南瓜灯点亮了。"
          : "独刻眼睛的南瓜灯点亮了。";
        this.item(
          owner,
          "pumpkin-lantern",
          event,
          [game.first],
          detail,
          makers,
        );
      }
    } else if (story === "jam_spoon") {
      if (!game.jam) {
        const jar = this.owned(owner, "craft-strawberry-jam").find(
          ({ id }) => id === choice.itemId,
        );
        if (
          !jar ||
          !this.db
            .prepare(
              `UPDATE garden_items SET consumed=1,slot=NULL,description='',public_note=''
          WHERE id=? AND owner=? AND consumed=0`,
            )
            .run(jar.id, gardenOwnerKey(owner)).changes
        )
          throw Error("GARDEN_EVENT_CHOICE_INVALID");
        const { ingredients } = JSON.parse(jar.craft_meta);
        const [ingredient] = ingredients ?? [];
        game.jam = {
          cropName: ingredient?.cropName ?? "草莓",
          maturedDay: ingredient?.maturedDay,
        };
      }
      const batch =
        game.jam.maturedDay === undefined
          ? `这勺来自用${game.jam.cropName}做成的果酱。`
          : `这勺来自第 ${game.jam.maturedDay} 天成熟的${game.jam.cropName}。`;
      game.active = choice.choiceId === "leave-spoon";
      detail =
        (game.active
          ? "把瓶底最后一勺留在桌上。"
          : "最后一勺果酱抹到了面包上。") + batch;
    } else if (story === "nest_edge") {
      const material = this.consumeLot(choice.harvestId, state);
      (game.materials ??= []).push(material);
      if (game.materials.length === 1) {
        game.active = true;
        this.schedule(event, day + 1, "nest_edge");
      }
      detail = `巢缘添上了${material.cropId === "sweet-corn" ? "玉米衣" : material.cropName}，次日就能看编好的边。`;
    } else if (story === "color_swap") {
      const sample = {
        ...this.consumeLot(choice.harvestId, state),
        maker: who,
        makerRef,
      };
      sample.color =
        variants[sample.variant] ?? sample.leafBack ?? colors[sample.cropId];
      if (!game.first) {
        game.first = sample;
        game.active = true;
        detail = `第一道调出了${sample.color}，可以用另一种花材补色。`;
      } else {
        detail = `色样卡上并排留着${game.first.color}和${sample.color}，两道各自带原料与署名。`;
        this.item(
          owner,
          "mixed-color-swatches",
          event,
          [game.first, sample],
          detail,
        );
      }
    } else if (story === "window_lamp") {
      this.db
        .prepare("INSERT INTO garden_table_loans VALUES(?,?,?)")
        .run(choice.itemId, event.id, gardenOwnerKey(owner));
      this.schedule(event, day + 1, "window_lamp");
      detail = "窗边留亮了一盏南瓜灯。明早会把原灯归还给物主。";
    }
    if (!game.active) event.status = "resolved";
    else if (event.status !== "open" && game.materials?.length !== 2)
      event.status = "expired";
    event.outcome = { detail, ...(choice.plot && { plots: [choice.plot] }) };
    const step = (game.steps ?? 0) + 1;
    game.steps = step;
    this.record(event, state, owner, detail, step, plants);
    return event.outcome;
  }

  schedule(event, day, kind) {
    this.db
      .prepare("INSERT INTO garden_table_followups VALUES(?,?,?,NULL)")
      .run(event.id, day, kind);
  }

  projects(day, state, owner) {
    return this.db
      .prepare(
        `SELECT value FROM garden_events WHERE day<?
      AND json_extract(value,'$.kind')='table' AND json_extract(value,'$.game.active')=1 ORDER BY day DESC`,
      )
      .all(day)
      .map(({ value }) => {
        const event = JSON.parse(value);
        return {
          id: event.id,
          name: event.name,
          detail: event.outcome?.detail,
          actions: this.actions(event, state, owner),
        };
      });
  }

  settle(day) {
    const due = this.db
      .prepare(
        "SELECT * FROM garden_table_followups WHERE trigger_day<=? AND result IS NULL ORDER BY trigger_day",
      )
      .all(day);
    for (const row of due) {
      const sourceDay = Number(row.id.split(":")[0]);
      const event = JSON.parse(
        this.db
          .prepare("SELECT value FROM garden_events WHERE day=?")
          .get(sourceDay).value,
      );
      let title, text;
      if (row.kind === "nest_edge") {
        title = "织巢的边编好了";
        const materials = event.game.materials;
        text =
          materials
            .map(({ cropId }) =>
              cropId === "sweet-corn"
                ? "玉米衣绕出结实的金边"
                : "绒耳叶衬出柔软的银边",
            )
            .join("，") + "。";
        event.game.active = false;
        event.status = "resolved";
        event.outcome = { detail: text };
        this.db
          .prepare("UPDATE garden_events SET value=? WHERE day=?")
          .run(JSON.stringify(event), sourceDay);
      } else {
        title = "窗边的原灯归还";
        text = "南瓜灯照了一夜，原灯已归还，边缘留着淡淡的蛾灰印。";
        const mark = "窗边过夜时留下了一道蛾灰印。";
        this.db
          .prepare(
            `UPDATE garden_items SET
          event_note=CASE WHEN event_note='' THEN :mark WHEN instr(event_note,:mark)>0 THEN event_note ELSE event_note || ' ' || :mark END,
          craft_meta=CASE WHEN craft_meta IS NOT NULL THEN json_set(craft_meta,'$.mothMark',json('true')) ELSE NULL END
          WHERE EXISTS(SELECT 1 FROM garden_table_loans WHERE event_id=:eventId AND item_id=garden_items.id AND owner=garden_items.owner)`,
          )
          .run({ ":mark": mark, ":eventId": row.id });
        this.db
          .prepare("DELETE FROM garden_table_loans WHERE event_id=?")
          .run(row.id);
      }
      this.db
        .prepare("UPDATE garden_table_followups SET result=? WHERE id=?")
        .run(JSON.stringify({ title, text }), row.id);
      this.journal.record({
        type: "followup",
        clock: (row.trigger_day - 1) * DAY,
        source: "action",
        detail: { name: title, stage: text, eventId: row.id },
        key: `garden-table-followup:${row.id}`,
      });
    }
  }

  followups(day) {
    return this.db
      .prepare(
        `SELECT id,trigger_day,result FROM garden_table_followups
      WHERE trigger_day<=? AND result IS NOT NULL ORDER BY trigger_day DESC LIMIT 5`,
      )
      .all(day)
      .map(({ id, trigger_day, result }) => ({
        id,
        type: "followup",
        day: trigger_day,
        ...JSON.parse(result),
      }));
  }
}
