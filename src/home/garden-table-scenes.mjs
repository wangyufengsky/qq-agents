import { createHash } from "node:crypto";
import { DAY, HOUR } from "./garden-rules.mjs";

const identity = ({ kind, id, generation }) =>
  JSON.stringify([kind, id, generation]);
const hasVisited = (scene, owner) =>
  owner && scene.visitors?.includes(identity(owner));
const hourOf = (clock) => Math.floor((clock % DAY) / HOUR);
const fail = () => {
  throw Error("GARDEN_EVENT_CHOICE_INVALID");
};

function lots(db, state, story) {
  const rows = db
    .prepare(
      "SELECT id,crop_id,harvest_meta FROM garden_harvests WHERE quantity>0 ORDER BY rowid",
    )
    .all();
  return rows
    .filter(
      (row) =>
        story === "menu" ||
        (story === "mint_ice"
          ? row.crop_id === "mint"
          : row.crop_id === "sweet-corn" &&
            JSON.parse(row.harvest_meta ?? "{}")?.harvestStage === "dry"),
    )
    .map((row) => ({
      id: row.id,
      cropId: row.crop_id,
      name: state.settings.crops[row.crop_id]?.name ?? row.crop_id,
    }));
}

export function tableSceneActions(db, event, state, owner) {
  if (event.status !== "open") return [];
  const story = event.effect.story;
  const scene = event.game?.scene;
  const action = (choiceId, label, description, args = {}, textPrompt) => ({
    kind: "choose_event",
    label,
    description,
    args: { eventId: event.id, choiceId, ...args },
    ...(textPrompt && { textPrompt }),
  });
  if (!scene) {
    if (story === "bench")
      return [
        action("prop_wood", "用小木片垫稳长椅", "坐下来时，椅脚会稳稳贴地。"),
        action("prop_pot", "把空花盆倒扣在椅脚下", "试试陶盆应声的长椅。"),
      ];
    if (!["menu", "popcorn", "mint_ice"].includes(story)) return [];
    const [choice, label, description] = {
      menu: [
        "cook_dish",
        "做一道尝味小菜",
        "拨一份收成下锅，给这道菜留个猜名字的位置。",
      ],
      popcorn: [
        "pop_corn",
        "爆一锅干玉米",
        "取一份干熟的第二穗，等锅里第一声轻响。",
      ],
      mint_ice: [
        "freeze_mint",
        "冻三块薄荷冰",
        "从这批薄荷里取一份，冰格搁在园桌上。",
      ],
    }[story];
    return lots(db, state, story).map((lot) =>
      action(choice, label + " · " + lot.name, description, {
        harvestId: lot.id,
      }),
    );
  }
  if (story === "bench")
    return [
      action(
        "sit_bench",
        "坐一会儿",
        "挑一处园里的景物，看看椅子旁今天发生了什么。",
      ),
    ];
  if (story === "mint_ice")
    return scene.remaining > 0
      ? [
          action(
            "sip_mint",
            "尝一杯薄荷饮",
            "现在开杯，尝尝冰格里还剩多少凉意。",
          ),
        ]
      : [];
  if (story === "popcorn")
    return [
      ...(!scene.dishName
        ? [
            action(
              "name_pop",
              "给第一朵爆米花起名",
              "照着它爆开的模样起个小名。",
              {},
              "你觉得这朵爆米花叫什么？",
            ),
          ]
        : []),
      ...(!hasVisited(scene, owner)
        ? [action("taste_pop", "尝一粒爆米花", "从大家的小锅里捏一粒。")]
        : []),
    ];
  if (story === "menu")
    return [
      ...(!hasVisited(scene, owner)
        ? scene.candidates.map(({ cropId, name }) =>
            action(
              "guess_dish",
              "尝尝看，是" + name + "吗？",
              "尝一口，再揭开今天锅里的真实原料。",
              { cropId },
            ),
          )
        : []),
      ...(!scene.dishName
        ? [
            action(
              "name_dish",
              "给这桌菜起名",
              "写在这张桌牌上，本桌的伙伴都能读到。",
              {},
              "今天这道菜叫什么？",
            ),
          ]
        : []),
    ];
  return [];
}

function benchView(db, state, scene) {
  const day = Math.floor(state.clock / DAY) + 1;
  const row = db
    .prepare("SELECT weather FROM garden_days WHERE day=?")
    .get(day);
  const weather = row && JSON.parse(row.weather)?.name;
  const sights = [
    ...state.plots.filter((p) => p.plant),
    ...state.plots.filter((p) => !p.plant),
  ];
  const plot = sights[(scene.sittings - 1) % sights.length];
  const observation = plot.plant
    ? `${plot.id} 号地的${plot.plant.crop.name}还在眼前`
    : `${plot.id} 号地空着，土面一览无余`;
  return `${scene.prop === "wood" ? "椅脚稳稳当当" : "陶盆在脚边咚了一声"}。花园第 ${day} 日 ${hourOf(state.clock)} 时，${weather ? weather + "，" : ""}${observation}。`;
}

export function performTableScene(db, journal, event, state, choice, owner) {
  const story = event.effect.story;
  const game = (event.game ??= {});
  const key = identity(owner);
  let scene = game.scene;
  let detail;
  if (!scene) {
    if (story === "bench") {
      const prop = choice.choiceId === "prop_wood" ? "wood" : "pot";
      game.scene = { prop, sittings: 0 };
      detail =
        prop === "wood"
          ? "小木片塞进了短腿下面，长椅稳稳落地。"
          : "倒扣的花盆托起椅脚，轻轻一按，咚。";
    } else {
      const lot = lots(db, state, story).find(
        (row) => row.id === choice.harvestId,
      );
      if (
        !lot ||
        !db
          .prepare(
            "UPDATE garden_harvests SET quantity=quantity-1,last_use='choose_event' WHERE id=? AND quantity>0",
          )
          .run(lot.id).changes
      )
        fail();
      scene = game.scene = { lot, visitors: [] };
      if (story === "popcorn") {
        const shapes = [
          "一只侧着耳朵的小兔",
          "一朵歪着帽檐的蘑菇",
          "一条翘尾巴的鱼",
          "一颗开了花的牙齿",
        ];
        scene.shape =
          shapes[
            createHash("sha256").update(lot.id).digest()[0] % shapes.length
          ];
        detail = `锅盖跳了一下。第一粒爆成了${scene.shape}，其余的还热着。`;
      } else if (story === "mint_ice") {
        scene.remaining = 3;
        detail = "三块薄荷冰落进玻璃杯，杯壁起了一层白雾。";
      } else {
        const candidates = Object.entries(state.settings.crops)
          .filter(
            ([id, crop]) => id !== lot.cropId && crop.enabled && crop.market,
          )
          .slice(0, 2)
          .map(([cropId, crop]) => ({ cropId, name: crop.name }));
        scene.candidates = [
          ...candidates,
          { cropId: lot.cropId, name: lot.name },
        ].sort((a, b) => a.cropId.localeCompare(b.cropId));
        detail = "桌上多了一碟现做的小菜。木牌上的旧菜名已经擦花，先尝尝？";
      }
    }
  } else if (
    choice.choiceId === "name_pop" ||
    choice.choiceId === "name_dish"
  ) {
    const name = choice.text?.trim();
    if (!name || Array.from(name).length > 120) fail();
    scene.dishName = name;
    detail =
      story === "popcorn"
        ? `第一朵像${scene.shape}。小碟上添了名字「${name}」。`
        : `这张桌牌翻过来了，今天叫「${name}」。原料仍记在这道菜的收成批次上。`;
  } else if (story === "bench") {
    scene.sittings = (scene.sittings ?? scene.visitors?.length ?? 0) + 1;
    detail = benchView(db, state, scene);
  } else if (story === "mint_ice") {
    if (!scene.remaining) fail();
    scene.remaining--;
    const hour = hourOf(state.clock);
    const texture =
      hour < 16 ? "杯底的碎冰轻轻作响" : "冰角已化成一杯清凉薄荷水";
    detail = `${texture}。桌上还留着 ${scene.remaining} 杯。`;
    if (!scene.remaining) event.status = "resolved";
  } else {
    if (scene.visitors.includes(key)) fail();
    scene.visitors.push(key);
    if (story === "menu")
      detail = `${choice.cropId === scene.lot.cropId ? "尝出来了" : "翻开菜牌看看"}，今天用的是${scene.lot.name}。${scene.dishName ? "这桌叫它「" + scene.dishName + "」。" : ""}`;
    else
      detail = `捏起一粒热爆米花。第一朵像${scene.shape}${scene.dishName ? "，名叫「" + scene.dishName + "」" : ""}，还在碟子中央。`;
  }
  const publicLot =
    game.scene?.lot && (story !== "menu" || game.scene.visitors.length > 0);
  event.outcome = {
    detail,
    ...(publicLot && { harvestId: game.scene.lot.id }),
    ...(story === "menu" &&
      game.scene.dishName && { dishName: game.scene.dishName }),
  };
  const step = (game.steps ?? 0) + 1;
  game.steps = step;
  journal.record({
    type: "event",
    clock: state.clock,
    source: "action",
    actor: owner,
    detail: {
      name: event.name,
      eventId: event.id,
      stage: detail,
      ...(publicLot && { harvestId: game.scene.lot.id }),
    },
    key: `table:${event.id}:${step}`,
  });
  return event.outcome;
}
