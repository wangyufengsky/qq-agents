import { windSources } from "./garden-memory-rules.mjs";
import { DAY } from "./garden-rules.mjs";
import { hasGardenFacility } from "./garden-facilities.mjs";
import { GardenGifts, gardenOwnerKey } from "./garden-items.mjs";

const dayOf = (clock) => Math.floor(clock / DAY) + 1;
const invalid = () => {
  throw Error("GARDEN_EVENT_CHOICE_INVALID");
};
// A dated sowing identifies the first known day only when no undated legacy sowing of that crop precedes it.
function firstSowings(db) {
  return db
    .prepare(
      `SELECT crop_id AS cropId, name,plot,planted_clock AS clock,plant_id AS plantId
    FROM (SELECT *, row_number() OVER(PARTITION BY crop_id ORDER BY planted_clock, rowid) AS pos
      FROM garden_plant_archive) WHERE pos=1 AND planted_clock IS NOT NULL ORDER BY crop_id`,
    )
    .all();
}

function oldPlots(db, plots) {
  const live = JSON.stringify(
    plots.map((p) => ({ plot: p.id, plantId: p.plant?.id ?? "" })),
  );
  return db
    .prepare(
      `SELECT plot,name,crop_id AS cropId,plant_id AS plantId,planted_clock AS clock
    FROM (SELECT a.*, row_number() OVER(PARTITION BY a.plot ORDER BY a.planted_clock DESC, a.rowid DESC) AS pos
    FROM garden_plant_archive a JOIN json_each(?) p ON a.plot=json_extract(p.value,'$.plot')
    WHERE a.plant_id <> json_extract(p.value,'$.plantId')) WHERE pos=1 ORDER BY plot`,
    )
    .all(live);
}

function careToday(db, day) {
  return db
    .prepare(
      `SELECT id,type,actor_kind AS kind,actor_id AS actor,plants FROM garden_facts
    WHERE type IN ('planted','water','fertilize') AND actor_id IS NOT NULL AND clock>=? AND clock<? ORDER BY id`,
    )
    .all((day - 1) * DAY, day * DAY);
}
function cloths(db, owner) {
  return db
    .prepare(
      `SELECT id,name FROM garden_items WHERE owner=? AND consumed=0
    AND gift_id IN ('perilla-half-cloth','perilla-printed-cloth') ORDER BY rowid`,
    )
    .all(gardenOwnerKey(owner));
}
export function memorySceneContext(db, state) {
  return {
    hasOldSign: Boolean(
      db
        .prepare(
          "SELECT 1 FROM garden_plant_archive WHERE plant_id NOT IN (SELECT value FROM json_each(?)) LIMIT 1",
        )
        .get(
          JSON.stringify(
            state.plots.flatMap((p) => (p.plant ? [p.plant.id] : [])),
          ),
        ),
    ),
    hasKnownSeed: Boolean(
      db
        .prepare(
          "SELECT 1 FROM garden_plant_archive GROUP BY crop_id HAVING COUNT(planted_clock)=COUNT(*) LIMIT 1",
        )
        .get(),
    ),
    hasWeatherChime: hasGardenFacility(db, "weather_chime"),
  };
}
export function startMemoryScene(_db, event, state, weather, day) {
  if (event.effect.story !== "poem") return;
  const plant = state.plots.find(
    (p) => p.plant && p.plant.status !== "withered",
  );
  const first = plant
    ? `${weather.name}，${plant.id} 号地的${plant.plant.crop.name}站在花园里。`
    : `${weather.name}，九块地在园门里摊开。`;
  (event.game ??= {}).lines = [first];
  event.game.startDay = day;
  event.outcome = { detail: first };
}

export function memorySceneActions(db, event, state, owner) {
  if (!owner || event.status === "resolved") return [];
  const story = event.effect.story;
  const act = (choiceId, label, description, args = {}, textPrompt) => ({
    kind: "choose_event",
    label,
    description,
    args: { eventId: event.id, choiceId, ...args },
    ...(textPrompt && { textPrompt }),
  });
  if (story === "old_sign")
    return oldPlots(db, state.plots).flatMap((p) => [
      act("old_name", `翻看 ${p.plot} 号地的旧牌`, "留住这里实际种过的名字。", {
        plot: p.plot,
      }),
      act(
        "then_and_now",
        `给 ${p.plot} 号地写两面`,
        "把旧名字与今天的地块并列记下。",
        { plot: p.plot },
      ),
    ]);
  if (story === "seed_memory")
    return firstSowings(db).map((p) =>
      act(
        "turn_seed",
        "翻开" + p.name + "的种子卡",
        "看看这粒种子在园里初次落土的日子和位置。",
        { cropId: p.cropId },
      ),
    );
  if (story === "wind_note")
    return hasGardenFacility(db, "weather_chime")
      ? windSources(state.plots).flatMap((p) => [
          act(
            "untangle",
            `理开 ${p.plot} 号地的${p.material}`,
            "听风铃回到原来的清音。",
            { plot: p.plot },
          ),
          act(
            "keep_tone",
            `留住 ${p.material}的声音`,
            "把两声合响记进园里的手帐。",
            { plot: p.plot },
          ),
        ])
      : [];
  if (story === "group_photo") {
    const care = careToday(db, dayOf(state.clock));
    const tools = [];
    if (care.some((f) => f.type === "water"))
      tools.push(
        act(
          "photo_can",
          "把今天用过的水壶摆进镜头",
          "今天实际照料过的人会留下署名。",
        ),
      );
    if (care.length)
      tools.push(
        act(
          "photo_garden",
          "给今天的花圃拍合影",
          "把今天被照料过的植物和实际来过的人记下来。",
        ),
      );
    return [
      ...tools,
      ...cloths(db, owner).map((item) =>
        act(
          "photo_cloth",
          "用自己的" + item.name + "作背景",
          "方巾留在自己手里，照片只收入选中的物品名称。",
          { itemId: item.id },
        ),
      ),
    ];
  }
  if (story === "poem" && event.game?.lines)
    return [
      ...(event.game.lines.length < 4
        ? [
            act(
              "add_line",
              "接写下一行",
              "把眼前的一句添到园里的这首诗。",
              {},
              "下一行写什么？",
            ),
          ]
        : []),
      act(
        "keep_poem",
        `收好这 ${event.game.lines.length} 行诗`,
        "可以把未写完的诗收进自己的花卡。",
      ),
    ];
  return [];
}
export function performMemoryScene(db, journal, event, state, choice, owner) {
  const story = event.effect.story,
    game = (event.game ??= {});
  const day = dayOf(state.clock);
  const gifts = new GardenGifts(db);
  let detail;
  const finish = (giftId, text, meta) => {
    gifts.grantEventItem(owner, giftId, text, {
      recipeId: giftId,
      ingredients: [],
      ...meta,
    });
    event.status = "resolved";
    game.active = false;
    return text;
  };
  if (story === "old_sign") {
    const old = oldPlots(db, state.plots).find((p) => p.plot === choice.plot);
    if (!old) invalid();
    const current = state.plots.find((p) => p.id === old.plot).plant;
    const past = `${old.plot} 号地的旧牌写着「${old.name}」`;
    const joined = choice.choiceId === "then_and_now";
    const now = current ? current.crop.name : "空地";
    detail = finish(
      "plot-history-sign",
      past + (joined ? `，翻面是今天的「${now}」。` : "。"),
      {
        gardenDay: day,
        plot: old.plot,
        previousPlantId: old.plantId,
        ...(joined && { today: now }),
      },
    );
  } else if (story === "seed_memory") {
    const first = firstSowings(db).find((p) => p.cropId === choice.cropId);
    if (!first) invalid();
    detail = finish(
      "remembered-seed-card",
      `认出来了，是${first.name}。第一次播在第 ${dayOf(first.clock)} 天的 ${first.plot} 号地。`,
      {
        firstDay: dayOf(first.clock),
        plot: first.plot,
        plantId: first.plantId,
        cropId: first.cropId,
      },
    );
  } else if (story === "wind_note") {
    const source = windSources(state.plots).find((p) => p.plot === choice.plot);
    if (!source) invalid();
    detail =
      choice.choiceId === "untangle"
        ? `理开 ${source.plot} 号地碰着铃的${source.material}，只剩一声清响。`
        : `${source.plot} 号地的${source.material}擦过风铃。一轻一重，两声一起留下了。`;
    event.status = "resolved";
    game.active = false;
  } else if (story === "group_photo") {
    const care = careToday(db, day);
    const people = [
      ...new Set(care.map((f) => (f.kind === "admin" ? "管理员" : f.actor))),
    ];
    const objects =
      choice.choiceId === "photo_can"
        ? ["今天用过的水壶"]
        : choice.choiceId === "photo_cloth"
          ? [cloths(db, owner).find((i) => i.id === choice.itemId)?.name]
          : [];
    const plants = [
      ...new Set(
        care
          .flatMap((f) => JSON.parse(f.plants))
          .map((ref) => ref.name)
          .filter(Boolean),
      ),
    ];
    const foreground = [...objects, ...plants].filter(Boolean).join("、");
    detail = finish(
      "garden-group-photo",
      `第 ${day} 天的镜头里有${foreground}。${people.length ? "相片背面记着今天的照料者：" + people.join("、") + "。" : "相片背面留了空白。"}`,
      {
        gardenDay: day,
        objects,
        carers: people,
        careFactIds: care.map((f) => f.id),
      },
    );
  } else if (story === "poem") {
    if (choice.choiceId === "add_line") {
      const line = choice.text?.trim().replace(/[\r\n\u2028\u2029]+/gu, " ");
      if (!line || [...line].length > 120 || game.lines.length >= 4) invalid();
      game.lines.push(line);
      game.active = true;
      detail = game.lines.join("\n");
    } else
      detail = finish("four-line-poem-card", game.lines.join("\n"), {
        gardenDay: game.startDay,
        lines: [...game.lines],
      });
  } else invalid();
  event.outcome = { detail };
  const step = (game.steps ?? 0) + 1;
  game.steps = step;
  journal.record({
    type: "event",
    clock: state.clock,
    source: "action",
    actor: owner,
    detail: { name: event.name, eventId: event.id, stage: detail },
    key: `memory:${event.id}:${step}`,
  });
  return event.outcome;
}
