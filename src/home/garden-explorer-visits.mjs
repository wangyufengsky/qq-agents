// @ts-check
import { createHash } from "node:crypto";
import { DAY } from "./garden-rules.mjs";

/** @typedef {import("node:sqlite").DatabaseSync} Database */
/** @typedef {import("./garden-service.mjs").State} State */
/** @typedef {import("./garden-items.mjs").Owner} Owner */
/** @typedef {{plot:number, speed:number, weather:string, crop:string}} Sample */
/** @typedef {{id:string,kind:string,status:string,effect:{story:string},game?:{windmill?:{current:Sample,best:Sample},packet?:{giver:string,drawings:number,taken:boolean}},outcome?:{detail:string}}} Visit */
/** @typedef {{choiceId:string,plot?:number,harvestId?:string}} Choice */
/** @param {Owner} owner */
const participant = (owner) =>
  JSON.stringify([owner.kind, owner.id, owner.generation]);

/** @param {Visit} event */
export function visitIsActive(event) {
  return (
    event.kind === "explorer" &&
    event.effect.story === "door_peas" &&
    Boolean(event.game?.packet && !event.game.packet.taken)
  );
}

/** @param {Database} db @param {Visit} event @param {State} state @param {Owner} [owner] */
export function visitActions(db, event, state, owner) {
  /** @param {string} label @param {string} description @param {Choice} choice */
  const action = (label, description, choice) => ({
    kind: "choose_event",
    label,
    description,
    args: { eventId: event.id, ...choice },
  });
  if (event.status !== "open" && !visitIsActive(event)) return [];
  if (event.effect.story === "windmill") {
    const current = event.game?.windmill?.current;
    return state.plots
      .filter(({ id }) => id !== current?.plot)
      .map(({ id }) =>
        action(
          current ? `把风车挪到 ${id} 号地` : `插在 ${id} 号地旁`,
          "看看这里的风能把纸叶转多快。",
          { choiceId: "place_pinwheel", plot: id },
        ),
      );
  }
  if (event.effect.story !== "door_peas") return [];
  const packet = event.game?.packet;
  if (!packet) {
    return db
      .prepare(
        "SELECT id FROM garden_harvests WHERE crop_id='rattle-pea' AND quantity>0 ORDER BY rowid",
      )
      .all()
      .map((lot) =>
        action("包一把豆留在门口", "从这批响铃豌豆中取一份，折进公共纸包。", {
          choiceId: "leave_peas",
          harvestId: String(lot.id),
        }),
      );
  }
  if (packet.taken) return [];
  const actions = [
    action("在纸包上添画一粒豆", "把纸包留给下一位，让小画再长一粒。", {
      choiceId: "draw_pea",
    }),
  ];
  if (!owner || participant(owner) !== packet.giver)
    actions.push(
      action("收下纸包里的豆种", "拆开后公共种子袋里会多一粒响铃豌豆。", {
        choiceId: "take_peas",
      }),
    );
  return actions;
}

/** @param {Visit} event @param {State["plots"][number]} plot @param {{kind:string,name:string}} weather */
function sampleWind(event, plot, weather) {
  // The same spot in the same weather gives the same reading however often it is visited.
  const breeze =
    createHash("sha256")
      .update(JSON.stringify([event.id, plot.id, weather.kind]))
      .digest()[0] % 4;
  const base = { sun: 3, cloud: 5, drizzle: 6, storm: 9 }[weather.kind] ?? 3;
  const sample = {
    plot: plot.id,
    weather: weather.name,
    crop: plot.plant?.crop.name ?? "空地",
    speed: Math.max(1, base + breeze - (plot.sheltered ? 3 : 0)),
  };
  const best = event.game?.windmill?.best;
  const fastest = best && best.speed >= sample.speed ? best : sample;
  event.game = { ...event.game, windmill: { current: sample, best: fastest } };
  event.outcome = {
    detail: `小风车在 ${plot.id} 号地旁转了起来。转得最快的一回在 ${fastest.plot} 号地（${fastest.crop}），当时是${fastest.weather}，一息转了 ${fastest.speed} 圈。`,
  };
}

/** @param {Database} db @param {import("./garden-journal.mjs").GardenJournal} _journal @param {Visit} event @param {State} state @param {Choice} choice @param {Owner} owner */
export function performVisit(db, _journal, event, state, choice, owner) {
  if (choice.choiceId === "place_pinwheel") {
    const weather = db
      .prepare("SELECT weather FROM garden_days WHERE day=?")
      .get(Math.floor(state.clock / DAY) + 1);
    const plot = state.plots.find(({ id }) => id === choice.plot);
    if (!plot || !weather) throw Error("GARDEN_EVENT_CHOICE_INVALID");
    sampleWind(event, plot, JSON.parse(String(weather.weather)));
  } else if (choice.choiceId === "leave_peas") {
    const used = db
      .prepare(
        "UPDATE garden_harvests SET quantity=quantity-1,last_use='choose_event' WHERE id=? AND crop_id='rattle-pea' AND quantity>0",
      )
      .run(String(choice.harvestId));
    if (!used.changes) throw Error("GARDEN_EVENT_CHOICE_INVALID");
    event.game = {
      ...event.game,
      packet: { giver: participant(owner), drawings: 0, taken: false },
    };
    event.outcome = {
      detail:
        "门边放着一包响铃豌豆，纸角折得好好的。下一位路过的伙伴可以拆开，也可以给袋子添幅画。",
    };
  } else {
    const packet = event.game?.packet;
    if (!packet) throw Error("GARDEN_EVENT_CHOICE_INVALID");
    if (choice.choiceId === "draw_pea") {
      packet.drawings++;
      event.outcome = {
        detail: `纸包上画着 ${packet.drawings} 粒圆豆，里面那粒种子还在等人。`,
      };
    } else {
      packet.taken = true;
      state.seeds["rattle-pea"] = (state.seeds["rattle-pea"] ?? 0) + 1;
      event.status = "resolved";
      event.outcome = {
        detail: `门口的纸包拆开了，里面的响铃豌豆回到公共种子袋。纸包上留着 ${packet.drawings} 粒手画的豆子。`,
      };
    }
  }
  return event.outcome;
}

/** @param {Database} db @param {import("./garden-journal.mjs").GardenJournal} _journal @param {State} state @param {number} day @param {number} _now @param {{kind:string,name:string}} weather */
export function settleVisits(db, _journal, state, day, _now, weather) {
  const row = db
    .prepare("SELECT value FROM garden_events WHERE day=?")
    .get(day);
  if (!row?.value) return;
  const event = JSON.parse(String(row.value));
  if (
    event?.kind !== "explorer" ||
    event.effect.story !== "windmill" ||
    !event.game?.windmill ||
    event.status !== "open"
  )
    return;
  const plot = state.plots.find(
    ({ id }) => id === event.game.windmill.current.plot,
  );
  if (!plot || !weather) return;
  const prior = JSON.stringify(event);
  sampleWind(event, plot, weather);
  const updated = JSON.stringify(event);
  if (prior !== updated)
    db.prepare("UPDATE garden_events SET value=? WHERE day=?").run(
      updated,
      day,
    );
}
