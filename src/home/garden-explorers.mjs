import { createHash } from "node:crypto";
import { explorerDescription } from "./garden-explorer-rules.mjs";
import { gardenPlantRef } from "./garden-journal.mjs";
import { DAY, HOUR, rattlePeaCount } from "./garden-rules.mjs";
import {
  visitActions,
  performVisit,
  visitIsActive,
  settleVisits,
} from "./garden-explorer-visits.mjs";

const participant = ({ kind, id, generation }) =>
  JSON.stringify([kind, id, generation]);
const living = (state) =>
  state.plots.filter(({ plant }) => plant && plant.status !== "withered");
const mature = (state, cropId) =>
  state.plots.filter(
    ({ plant }) => plant?.cropId === cropId && plant.status === "mature",
  );
const measure = (plant) =>
  Math.round(Math.min(1, plant.growth / plant.crop.hours) * 100);
const ranked = (eventId, plots) =>
  [...plots].sort((left, right) => {
    const hash = ({ id, plant }) =>
      createHash("sha256")
        .update(JSON.stringify([eventId, id, plant?.id]))
        .digest()
        .readUInt32BE();
    return hash(left) - hash(right) || left.id - right.id;
  });
const leafTraits = {
  "morning-glory": "叶片像一颗细长的心，尖端朝下。",
  "rattle-pea": "一片叶由几枚小叶排成，梢头有细卷须。",
  balsam: "叶身细长，边缘有一排小锯齿。",
  "lambs-ear": "叶面覆着一层绒毛，摸起来像软布。",
  sunflower: "叶片宽大，摸起来有粗糙感。",
  mint: "叶缘像小锯齿，揉过会闻到清凉的气味。",
  strawberry: "三片小叶并排，边缘有整齐的齿。",
  hydrangea: "宽椭圆叶面上，侧脉从主脉两旁斜着铺开。",
};

function record(journal, event, state, stage, actor, key, plants = []) {
  journal.record({
    type: "event",
    clock: state.clock,
    source: "action",
    actor,
    plants,
    detail: { name: event.name, stage, eventId: event.id },
    key: `explorer:${event.id}:${key}`,
  });
}

export class GardenExplorers {
  constructor(db, journal) {
    this.db = db;
    this.journal = journal;
  }

  start(event, state) {
    const { story } = event.effect;
    const game = {};
    if (story === "pea_guess")
      game.target = ranked(event.id, mature(state, "rattle-pea"))[0]?.id;
    if (story === "balsam_game")
      game.target = ranked(
        event.id,
        mature(state, "balsam").filter(({ plant }) => !plant.podPopped),
      )[0]?.id;
    if (game.target) game.plantId = state.plots[game.target - 1].plant.id;
    if (story === "snail_map")
      game.route = ranked(event.id, living(state))
        .slice(0, 2)
        .map(({ id, plant }) => gardenPlantRef(id, plant));
    if (story === "leaf_identity") {
      const [first, ...others] = ranked(event.id, living(state));
      const second = others.find(
        ({ plant }) => plant.cropId !== first?.plant.cropId,
      );
      if (first && second) {
        game.leaves = [first, second]
          .sort((a, b) => a.id - b.id)
          .map(({ id, plant }) => ({
            ...gardenPlantRef(id, plant),
            light: plant.crop.light,
            water: plant.crop.dailyWater,
          }));
        game.answer = Number(game.leaves[1].plot === first.id);
      }
    }
    event.game = game;
    return event;
  }

  view(event, state) {
    const { game, ...safe } = event;
    const { story } = event.effect;
    let description = explorerDescription(story);
    if (story === "pea_guess" && game?.target)
      description += ` 目标是 ${game.target} 号地的响豆。`;
    if (story === "balsam_game" && game?.target)
      description += ` 目标是 ${game.target} 号地的凤仙。`;
    if (story === "snail_map" && game?.route?.length)
      description += ` 银线先从 ${game.route[0].plot} 号地的${game.route[0].name}旁露出来。`;
    if (story === "leaf_identity" && game?.leaves?.length) {
      const leaf = game.leaves[game.answer];
      description +=
        " " +
        (leafTraits[leaf.cropId] ??
          `这张叶来自${leaf.light === "sun" ? "一株喜阳" : leaf.light === "shade" ? "一株喜阴" : "一株对光照不挑"}的植物，日需水约 ${leaf.water}。`);
    }
    if (
      story === "boot_pond" &&
      game?.launchClock !== undefined &&
      state.clock >= game.launchClock + HOUR &&
      event.status === "open"
    )
      description += " 过了一个花园小时，叶舟已经转向靴尖。";
    return { ...safe, description };
  }

  actions(event, state, owner) {
    if (!owner || event?.kind !== "explorer") return [];
    const { story } = event.effect;
    if (story === "windmill" || story === "door_peas")
      return visitActions(this.db, event, state, owner);
    if (event.status !== "open") return [];
    const game = event.game ?? {};
    const act = (choiceId, label, description, plot) => ({
      label,
      description,
      kind: "choose_event",
      args: {
        eventId: event.id,
        choiceId,
        ...(plot !== undefined && { plot }),
      },
    });
    switch (story) {
      case "pea_guess": {
        const target = state.plots[game.target - 1]?.plant;
        if (target?.id !== game.plantId) return [];
        return [
          ...((!game.heard && [
            act("listen", "轻轻听一下", "听豆子碰到壳的声音。"),
          ]) ||
            []),
          ...(!game.guesses?.[participant(owner)]
            ? [2, 3, 4, 5].map((n) =>
                act(`guess-${n}`, `猜 ${n} 颗`, "先留一票，开荚时再看结果。"),
              )
            : []),
          act("open-pod", "打开豆荚", "以这株实际豆荚的豆数揭晓。"),
        ];
      }
      case "snail_map":
        return game.route?.length === 2
          ? [
              act("follow-trail", "跟到叶背", "顺着银线看看第二块地。"),
              act("draw-map", "画下银地图", "把两块地和走过的方向记在手帐。"),
            ]
          : [];
      case "bamboo_rain":
        return [
          ...state.plots
            .filter(
              ({ plant }) => plant?.status === "growing" && plant.water < 100,
            )
            .map(({ id }) =>
              act("divert-water", "引水到地里", "给这株补至多 25 点水分。", id),
            ),
          act("rain-drum", "摆一个空罐", "只听雨，不取花园物资。"),
        ];
      case "sparrow_bath":
        return [
          ...state.plots
            .filter(({ plant }) => !plant)
            .map(({ id }) =>
              act(
                "leave-print",
                "留出沙浴脚印",
                "沙印是手帐风景，这块地仍可正常种植。",
                id,
              ),
            ),
          act("move-soil", "把软沙挪到过道", "给麻雀另留一个不占地的位置。"),
        ];
      case "balsam_game": {
        const target = state.plots[game.target - 1]?.plant;
        return target?.id === game.plantId && !target.podPopped
          ? ["左边", "中间", "右边"].map((label, index) =>
              act(
                `dish-${["left", "center", "right"][index]}`,
                `接到${label}的碟子`,
                "同一株只会弹籽一次，种袋进公共仓。",
              ),
            )
          : [];
      }
      case "shadow_measure":
        return state.plots
          .filter(({ plant }) => plant?.status === "growing")
          .map(({ id }) =>
            act(
              "measure",
              "记录株影",
              "次日同刻对照，提早收割也保留收割时的数据。",
              id,
            ),
          );
      case "boot_pond": {
        if (game.launchClock !== undefined)
          return state.clock >= game.launchClock + HOUR ||
            game.launcher !== participant(owner)
            ? [act("watch-boat", "来看叶舟", "把现在的船头方向记在手帐。")]
            : [];
        const driest = state.plots
          .filter(
            ({ plant }) => plant?.status === "growing" && plant.water < 100,
          )
          .sort((a, b) => a.plant.water - b.plant.water || a.id - b.id)[0];
        return [
          ...(driest
            ? [
                act(
                  "water-dry",
                  "浇给最干的地",
                  "补至多 25 点水分。",
                  driest.id,
                ),
              ]
            : []),
          act("launch-boat", "放一只叶舟", "稍后来园的人可以看它有没有转向。"),
        ];
      }
      case "leaf_identity":
        return (game.leaves ?? []).map((leaf, i) =>
          act(
            i ? "leaf-b" : "leaf-a",
            `猜是${leaf.name}`,
            "选择后公布答案和自家植物的出处。",
          ),
        );
      default:
        return [];
    }
  }

  perform(event, state, choice, actor, owner, now, popPod) {
    const allowed = this.actions(event, state, owner).find(
      ({ args }) =>
        args.choiceId === choice.choiceId &&
        args.plot === choice.plot &&
        args.harvestId === choice.harvestId,
    );
    if (!allowed)
      throw Error(
        event.status === "resolved"
          ? "GARDEN_EVENT_ALREADY_RESOLVED"
          : "GARDEN_EVENT_CHOICE_INVALID",
      );
    const { story } = event.effect;
    if (story === "windmill" || story === "door_peas") {
      const outcome = performVisit(
        this.db,
        this.journal,
        event,
        state,
        choice,
        owner,
        now,
      );
      const count = (event.game.actionsRecorded ?? 0) + 1;
      event.game.actionsRecorded = count;
      record(
        this.journal,
        event,
        state,
        outcome.detail,
        actor,
        `visit-${count}`,
        choice.plot && state.plots[choice.plot - 1]?.plant
          ? [gardenPlantRef(choice.plot, state.plots[choice.plot - 1].plant)]
          : [],
      );
      return outcome;
    }
    const game = event.game;
    const { choiceId, plot } = choice;
    let detail;
    let open = false;
    let plants = [];
    let plots = plot ? [plot] : [];
    const target = state.plots[game.target - 1];
    if (story === "pea_guess") {
      const actual = rattlePeaCount(target.plant);
      const ref = gardenPlantRef(target.id, target.plant);
      if (choiceId === "listen") {
        game.heard = true;
        detail = `贴近 ${target.id} 号地的豆荚，听见了${"嗒".repeat(actual)}。`;
        open = true;
      } else if (choiceId.startsWith("guess-")) {
        (game.guesses ??= {})[participant(owner)] = Number(choiceId.slice(6));
        return { detail: "这次猜数记下了，等开荚再揭晓。" };
      } else {
        const guesses = Object.values(game.guesses ?? {});
        const right = guesses.filter((guess) => guess === actual).length;
        detail = `${target.id} 号地的${ref.name}豆荚揭晓，共 ${actual} 颗豆。共有 ${guesses.length} 份猜数，${right} 份猜中。`;
        if (guesses.length) {
          const low = Math.min(...guesses);
          const high = Math.max(...guesses);
          detail +=
            low === high
              ? `大家猜了 ${low} 颗。`
              : `猜数从 ${low} 到 ${high} 颗。`;
        }
      }
      plots = [target.id];
      plants = [ref];
    } else if (story === "snail_map") {
      const [from, to] = game.route;
      detail =
        choiceId === "draw-map"
          ? `画下了从 ${from.plot} 号地${from.name}通往 ${to.plot} 号地${to.name}的银线。`
          : `沿 ${from.plot} 号地的银线走到 ${to.plot} 号地，在${to.name}的叶背找到了蜗牛。`;
      plots = [from.plot, to.plot];
      plants = game.route;
    } else if (choiceId === "divert-water" || choiceId === "water-dry") {
      const plant = state.plots[plot - 1].plant;
      const before = plant.water;
      plant.water = Math.min(100, before + 25);
      plant.dry = 0;
      const added = Math.round((plant.water - before) * 10) / 10;
      detail = `${plot} 号地的${plant.crop.name}补了 ${added} 点水分。`;
      plants = [gardenPlantRef(plot, plant)];
      this.journal.updatePlant(plant);
    } else if (story === "bamboo_rain") {
      detail = "空罐接住了竹筒滴下的雨水，敲出轻轻的鼓点。";
    } else if (story === "sparrow_bath") {
      detail = plot
        ? `${plot} 号空地留下了麻雀沙浴的脚印，仍可以正常播种。`
        : "把软沙挪到了过道，麻雀留下的小脚印没有占用花圃。";
    } else if (story === "balsam_game") {
      if (!popPod(state, target, actor))
        throw Error("GARDEN_EVENT_CHOICE_INVALID");
      plants = [gardenPlantRef(target.id, target.plant)];
      plots = [target.id];
      const dishes = ["dish-left", "dish-center", "dish-right"];
      const labels = ["左边", "中间", "右边"];
      const chosen = dishes.indexOf(choiceId);
      const landing =
        createHash("sha256")
          .update(JSON.stringify(["balsam-dish", target.plant.id]))
          .digest()[0] % 4;
      const destination =
        landing === 3 ? "碟子外面" : `${labels[landing]}的碟子里`;
      detail = `${target.id} 号地的凤仙把花籽弹到了${destination}。${
        chosen === landing
          ? "正好接住，公共仓收好了一袋种子。"
          : `挑的是${labels[chosen]}的碟子，捡回花籽后公共仓收好了一袋种子。`
      }`;
    } else if (story === "shadow_measure") {
      const plant = state.plots[plot - 1].plant;
      const ref = gardenPlantRef(plot, plant);
      const start = measure(plant);
      const due = state.clock + DAY;
      this.db
        .prepare("INSERT INTO garden_explorer_comparisons VALUES (?,?,?,NULL)")
        .run(
          event.id,
          due,
          JSON.stringify({ ref, start, afterFact: this.journal.latestId() }),
        );
      detail = `${plot} 号地${ref.name}的影子标在 ${start} 格，明日此时回来对照。`;
      plants = [ref];
    } else if (story === "boot_pond") {
      if (choiceId === "launch-boat") {
        game.launchClock = state.clock;
        game.launcher = participant(owner);
        detail = "叶舟放进了雨靴，船头暂时朝靴口。";
        open = true;
      } else {
        const turned = state.clock >= game.launchClock + HOUR;
        detail = turned
          ? "后来者来看叶舟，船头已从靴口转向靴尖。"
          : "后来者来看叶舟，船头暂时仍朝着靴口。";
        open = !turned;
      }
    } else if (story === "leaf_identity") {
      const leaf = game.leaves[game.answer];
      const correct = (choiceId === "leaf-b" ? 1 : 0) === game.answer;
      const other = game.leaves[1 - game.answer];
      detail = `${correct ? "认出来了" : "看清了答案"}，这张叶子来自 ${leaf.plot} 号地的${leaf.name}，另一张来自 ${other.plot} 号地的${other.name}。`;
      plots = [leaf.plot];
      plants = game.leaves;
    }
    event.status = open ? "open" : "resolved";
    event.outcome = { detail, ...(plots.length && { plots }) };
    record(
      this.journal,
      event,
      state,
      detail,
      actor,
      choiceId === "watch-boat" && open ? "watch-early" : choiceId,
      plants,
    );
    return event.outcome;
  }

  due(clock) {
    return this.db
      .prepare(
        `SELECT id,trigger_clock,payload FROM garden_explorer_comparisons
      WHERE trigger_clock<=? AND result IS NULL ORDER BY trigger_clock,id`,
      )
      .all(clock);
  }

  settleComparison(row, state) {
    const { ref, start, afterFact = 0 } = JSON.parse(row.payload);
    const current = state.plots[ref.plot - 1]?.plant;
    const harvested = this.db
      .prepare(
        `SELECT 1 FROM garden_facts AS fact,json_each(fact.plants) AS plant
      WHERE fact.type='harvest' AND fact.id>? AND fact.clock>=? AND fact.clock<=? AND json_extract(plant.value,'$.plantId')=? LIMIT 1`,
      )
      .get(afterFact, row.trigger_clock - DAY, row.trigger_clock, ref.plantId);
    const archive =
      !harvested &&
      current?.id !== ref.plantId &&
      this.db
        .prepare("SELECT snapshot FROM garden_plant_archive WHERE plant_id=?")
        .get(ref.plantId);
    const last =
      current?.id === ref.plantId
        ? current
        : archive?.snapshot && JSON.parse(archive.snapshot);
    const end = harvested ? 100 : last ? measure(last) : null;
    const text = `${ref.plot} 号地的${ref.name}，昨天是 ${start} 格，${harvested || current?.id !== ref.plantId ? "留下的末次标记" : "今天同刻"}${end === null ? "无可核对的刻度" : `是 ${end} 格`}。`;
    const title = "影子尺的次日对照";
    this.db
      .prepare("UPDATE garden_explorer_comparisons SET result=? WHERE id=?")
      .run(JSON.stringify({ title, text }), row.id);
    this.journal.record({
      type: "followup",
      source: "action",
      clock: row.trigger_clock,
      plants: [ref],
      detail: { stage: text, name: title, eventId: row.id },
      key: `explorer-shadow:${row.id}`,
    });
  }

  followups(clock) {
    return this.db
      .prepare(
        `SELECT id,trigger_clock,result FROM garden_explorer_comparisons
      WHERE trigger_clock<=? AND result IS NOT NULL ORDER BY trigger_clock DESC LIMIT 5`,
      )
      .all(clock)
      .map(({ id, trigger_clock, result }) => ({
        id,
        type: "followup",
        day: Math.floor(trigger_clock / DAY) + 1,
        ...JSON.parse(result),
      }));
  }

  isActive(event) {
    return visitIsActive(event);
  }

  projects(day, state, owner) {
    return this.db
      .prepare(
        `SELECT value FROM garden_events WHERE day<? AND
      json_extract(value,'$.effect.story')='door_peas' AND
      json_extract(value,'$.game.packet.taken')=0 ORDER BY day DESC`,
      )
      .all(day)
      .flatMap(({ value }) => {
        const event = JSON.parse(value);
        if (!visitIsActive(event)) return [];
        return [
          {
            id: event.id,
            name: event.name,
            detail: event.outcome?.detail,
            actions: this.actions(event, state, owner),
          },
        ];
      });
  }

  settleVisits(state, day, now, weather) {
    settleVisits(this.db, this.journal, state, day, now, weather);
  }
}
