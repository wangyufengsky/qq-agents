// @ts-check
import { z } from "zod";
import {
  careScope,
  defaultGardenSettings,
  HOUR,
  gardenCropTraits,
  neighborBuffs,
  moistureRate,
} from "./garden-rules.mjs";
import {
  gardenGiftSources,
  recordGardenGift,
  recordGardenItemGift,
} from "./garden-gift-sources.mjs";
import { defaultEvents, validEventReferences } from "./garden-event-rules.mjs";
import { giftShelfCapacity } from "../../public/garden-art/gifts.js";
import { giftBudgetLimits } from "./garden-items.mjs";
import { floodRisk } from "./garden-risks.mjs";

/** @typedef {ReturnType<import("./garden-service.mjs").GardenService["read"]>} GardenState */
const instanceAdmin = {
  kind: /** @type {const} */ ("admin"),
  id: "administrator",
};
const settingsInput = z.strictObject({
  expectedRevision: z.number().int().min(0),
  settings: z.record(z.string(), z.unknown()),
  roleIds: z.array(z.string()).max(100),
  careScope: careScope.default("future"),
});
const initializeInput = z.strictObject({
  initialBalance: z.number().int().min(0).max(1_000_000),
});

/** @param {number} remaining @param {number} lossRate */
function dryEstimate(remaining, lossRate) {
  return lossRate > 0 ? Math.max(0, remaining) / lossRate : null;
}

/** @param {GardenState} state */
export function gardenPriorities(state) {
  return state.plots
    .flatMap(({ id: plot, plant, sheltered, note }) => {
      if (!plant) return [];
      if (plant.status === "mature")
        return [
          {
            plot,
            plantId: plant.id,
            kind: "harvest",
            priority: 3,
            hours: 0,
            ...(note && { hasNote: true }),
          },
        ];
      if (plant.status === "withered")
        return [
          { plot, plantId: plant.id, kind: "clear", priority: 4, hours: 0 },
        ];
      const risk = floodRisk(
        plant,
        sheltered,
        state.weather,
        state.event?.kind === "weather_flip"
          ? state.event.targetWeather
          : state.weather,
      );
      if (risk)
        return [
          {
            plot,
            plantId: plant.id,
            kind: "flood",
            risk,
            priority: risk === "critical" ? 0 : 2,
            hours: state.dayRemaining / HOUR,
          },
        ];
      const lossRate = -moistureRate(plant, state.weather, sheltered);
      if (plant.water === 0 && lossRate >= 0)
        return [
          {
            plot,
            plantId: plant.id,
            kind: plant.rules.careMode === "gentle" ? "dormant" : "drought",
            priority: plant.rules.careMode === "gentle" ? 1 : 0,
            hours:
              plant.rules.careMode === "gentle"
                ? null
                : Math.max(0, plant.rules.dryHours - plant.dry),
          },
        ];
      if (plant.water < plant.rules.lowWater)
        return [
          {
            plot,
            plantId: plant.id,
            kind: "water",
            priority: 1,
            hours: dryEstimate(plant.water, lossRate),
          },
        ];
      const hours = dryEstimate(plant.water - plant.rules.lowWater, lossRate);
      return hours !== null && hours <= 24
        ? [
            {
              plot,
              plantId: plant.id,
              kind: "low_water_forecast",
              priority: 2,
              hours,
            },
          ]
        : [];
    })
    .sort(
      (a, b) =>
        a.priority - b.priority ||
        (a.hours ?? Infinity) - (b.hours ?? Infinity) ||
        a.plot - b.plot,
    )
    .map(({ priority: _priority, ...entry }) => entry);
}

/** @param {any} runtime */
export function gardenPauseReason(runtime) {
  if (runtime.config.globalPaused) return "GLOBAL_PAUSED";
  if (runtime.config.mode !== "live") return "ISOLATED_MODE";
  if (
    runtime.configChanging ||
    runtime.updateMaintenance ||
    runtime.maintenance.active
  )
    return "UPDATE_IN_PROGRESS";
  return null;
}

/** @param {any} runtime */
function recipients(runtime) {
  return [
    { ...instanceAdmin, name: "管理员" },
    ...runtime.config.agents.map(
      (/** @type {{id:string,name:string}} */ a) => ({
        kind: "agent",
        id: a.id,
        name: a.name,
      }),
    ),
  ];
}

/** @param {any} runtime @param {{kind:string,id:string}} person */
function giftPerson(runtime, person) {
  const entry = recipients(runtime).find(
    (row) => row.kind === person.kind && row.id === person.id,
  );
  if (!entry) return undefined;
  return {
    ...entry,
    kind: /** @type {"admin"|"agent"} */ (entry.kind),
    generation:
      entry.kind === "admin" ? "instance" : runtime.home.generation(entry.id),
  };
}

/** @param {any} runtime @param {string} roleId @param {GardenState} state */
function roleGifts(runtime, roleId, state) {
  const owner = giftPerson(runtime, { kind: "agent", id: roleId });
  if (!owner) throw Error("GARDEN_ROLE_UNAVAILABLE");
  return runtime.home.garden.gifts.view(owner, state.day, state);
}

/** @param {any} runtime @param {string} roleId */
export function subjectGardenGifts(runtime, roleId) {
  const state = runtime.home.garden.snapshot(runtime.now(), false);
  const { budget: _budget, ...personalGifts } = roleGifts(
    runtime,
    roleId,
    state,
  );
  return { items: gardenGiftSources(runtime, roleId), personalGifts };
}

/** @param {GardenState} state */
export function marketHarvests(state) {
  return state.harvests.map((harvest) => {
    const quality = String(harvest.quality);
    const multiplier =
      quality === "fine"
        ? state.settings.fineMultiplier
        : quality === "perfect"
          ? state.settings.perfectMultiplier
          : 1;
    return {
      id: String(harvest.id),
      cropId: String(harvest.crop_id),
      quality,
      quantity: Number(harvest.quantity),
      saleRate:
        state.settings.crops[String(harvest.crop_id)].salePrice * multiplier,
    };
  });
}

/** @param {any} runtime @param {import("./garden-service.mjs").Actor} actor @param {unknown} value */
export function performGardenAction(runtime, actor, value) {
  /** @type {import("./garden-service.mjs").GardenService} */
  const garden = runtime.home.garden;
  const owner = giftPerson(runtime, actor);
  if (!owner) throw Error("GARDEN_ROLE_UNAVAILABLE");
  return garden.act(
    runtime.now(),
    actor,
    value,
    (action) => {
      // Live checks cover new writes; replaying a committed receipt leaves the garden untouched.
      if (gardenPauseReason(runtime)) throw Error("GARDEN_PAUSED");
      if (
        action.kind === "gift" &&
        !recipients(runtime).some(
          (entry) =>
            entry.kind === action.recipient.kind &&
            entry.id === action.recipient.id,
        )
      )
        throw Error("GARDEN_RECIPIENT_UNAVAILABLE");
    },
    (recipient, gift) => recordGardenGift(runtime, actor, recipient, gift),
    { owner, recipient: (person) => giftPerson(runtime, person) },
    (transfer) => recordGardenItemGift(runtime, transfer),
    actor.kind === "agent"
      ? (surprise) =>
          recordGardenObservation(
            runtime,
            actor.id,
            {
              kind: surprise.kind,
              title: surprise.title,
              body: surprise.detail,
              key: `surprise:${surprise.factId}`,
            },
            runtime.now(),
          ).evidenceId
      : undefined,
  );
}

/** @param {any} runtime @param {boolean} [collectVisitor] */
export function adminGardenView(runtime, collectVisitor = false) {
  /** @type {import("./garden-service.mjs").GardenService} */
  const garden = runtime.home.garden;
  const roles = recipients(runtime);
  if (!garden.initialized()) return { initialized: false, roles };
  const state = garden.read(
    runtime.now(),
    collectVisitor && !gardenPauseReason(runtime) ? instanceAdmin : undefined,
  );
  const pauseReason =
    gardenPauseReason(runtime) ||
    (!state.settings.enabled
      ? "GARDEN_DISABLED"
      : !state.running
        ? "GARDEN_PAUSED"
        : null);
  const { roles: _grants, giftBudgetGenerations, ...settings } = state.settings;
  settings.giftBudgets = {
    ...settings.giftBudgets,
    roles: Object.fromEntries(
      roles
        .filter(
          (role) =>
            role.kind === "agent" &&
            giftBudgetGenerations[role.id] ===
              runtime.home.generation(role.id) &&
            Object.hasOwn(settings.giftBudgets.roles, role.id),
        )
        .map((role) => [role.id, settings.giftBudgets.roles[role.id]]),
    ),
  };
  const roleIds = roles
    .filter(
      (role) =>
        role.kind === "agent" &&
        garden.allowsRole(role.id, runtime.home.generation(role.id)),
    )
    .map((role) => role.id);
  return {
    initialized: true,
    ...state,
    plots: state.plots.map((plot) => ({
      ...plot,
      plant: plot.plant && {
        ...plot.plant,
        neighborBuffs: neighborBuffs(state, plot.id),
      },
    })),
    settings,
    personalGifts: garden.gifts.view(
      { ...instanceAdmin, generation: "instance" },
      state.day,
      state,
    ),
    roles,
    roleIds,
    pauseReason,
    priorities: gardenPriorities(state),
    market: marketHarvests(state),
    eventActions: eventActions(state),
    eventHistory: garden.calendar.events.history(),
    eventPresets: Object.entries(defaultEvents.entries).map(([id, entry]) => ({
      id,
      entry,
      available: validEventReferences({
        ...state.settings,
        events: { entries: { [id]: entry } },
      }),
    })),
  };
}

/** @param {any} runtime @param {"initialize"|"settings"|"act"|"weather-trial"|"event-trial"} operation @param {unknown} value */
export function adminGardenWrite(runtime, operation, value) {
  if (
    runtime.updateMaintenance ||
    runtime.maintenance.active ||
    runtime.configChanging
  )
    throw Error("UPDATE_IN_PROGRESS");
  /** @type {import("./garden-service.mjs").GardenService} */
  const garden = runtime.home.garden;
  const now = runtime.now();
  if (operation === "weather-trial" || operation === "event-trial")
    return garden.calendar.trial(
      garden.requireState(),
      value,
      operation === "event-trial",
    );
  if (operation === "initialize") {
    const { initialBalance } = initializeInput.parse(value);
    garden.initialize(now, { ...defaultGardenSettings(), initialBalance });
    return adminGardenView(runtime);
  }
  if (operation === "settings") {
    const { settings, expectedRevision, roleIds, careScope } =
      settingsInput.parse(value);
    const eligible = new Set(
      recipients(runtime)
        .filter((entry) => entry.kind === "agent")
        .map((entry) => entry.id),
    );
    if (roleIds.some((id) => !eligible.has(id)))
      throw Error("GARDEN_ROLE_UNAVAILABLE");
    if (
      Object.hasOwn(settings, "roles") ||
      Object.hasOwn(settings, "giftBudgetGenerations")
    )
      throw Error("INVALID_REQUEST");
    const current = garden.requireState().settings;
    const giftBudgets = Object.hasOwn(settings, "giftBudgets")
      ? giftBudgetLimits.parse(settings.giftBudgets)
      : current.giftBudgets;
    if (
      Object.hasOwn(settings, "giftBudgets") &&
      Object.keys(giftBudgets.roles).some((id) => !eligible.has(id))
    )
      throw Error("GARDEN_ROLE_UNAVAILABLE");
    const giftBudgetGenerations = Object.hasOwn(settings, "giftBudgets")
      ? Object.fromEntries(
          Object.keys(giftBudgets.roles).map((id) => [
            id,
            runtime.home.generation(id),
          ]),
        )
      : current.giftBudgetGenerations;
    garden.configure(
      now,
      expectedRevision,
      {
        ...settings,
        initialBalance: current.initialBalance,
        giftBudgets,
        giftBudgetGenerations,
        roles: Object.fromEntries(
          roleIds.map((id) => [id, runtime.home.generation(id)]),
        ),
      },
      careScope,
    );
    return adminGardenView(runtime);
  }
  return {
    receipt: performGardenAction(runtime, instanceAdmin, value),
    garden: adminGardenView(runtime),
  };
}

/** @param {any} runtime @param {string} roleId @param {string} turnId */
export function subjectGardenView(
  runtime,
  roleId,
  turnId,
  collectVisitor = true,
) {
  /** @type {import("./garden-service.mjs").GardenService} */
  const garden = runtime.home.garden;
  const now = runtime.now();
  const active = collectVisitor && !gardenPauseReason(runtime);
  const state = garden.read(
    now,
    active ? { kind: "agent", id: roleId, turnId } : undefined,
  );
  const event = state.event;
  const observations =
    active && state.running
      ? gardenObservations(runtime, roleId, state, now)
      : [];
  const observation = observations.find(({ kind }) => kind === "firefly");
  const identity = {
    kind: "agent",
    id: roleId,
    generation: runtime.home.generation(roleId),
  };
  const knownHiddenCrops = new Set([
    ...Object.entries(state.seeds)
      .filter(([, count]) => count > 0)
      .map(([id]) => id),
    ...state.plots.flatMap(({ plant }) => (plant ? [plant.cropId] : [])),
    ...state.harvests.map(({ crop_id }) => String(crop_id)),
    ...(state.mistbellDiscovered ? ["mistbell"] : []),
  ]);
  const actions = eventActions(state);
  return {
    balance: state.balance,
    scene: {
      ...state.nightScene,
      pollenPairs: state.pollenPairs,
    },
    observations,
    highlights: garden.journal.highlights(identity),
    boardNotes: state.boardNotes,
    rumors: state.rumors,
    event: event
      ? { ...event, actions, ...(observation && { observation }) }
      : null,
    mysterySeeds: state.mysterySeeds,
    mysteryPlantActions: state.mysterySeeds.count
      ? state.plots.flatMap(({ id, plant }) =>
          plant ? [] : [{ kind: "plant_mystery_seed", args: { plot: id } }],
        )
      : [],
    gifts: gardenGiftSources(runtime, roleId),
    personalGifts: roleGifts(runtime, roleId, state),
    giftActions: {
      buy_gift: {
        eventId: "当前商人事件 ID",
        giftId: "礼物货品 ID",
        price: "成交价",
        recipient: "可选 {kind,id}，省略为收好",
        note: "直送时可选纸条",
      },
      send_gift: {
        itemId: "自己的单份物品 ID",
        recipient: "{kind,id}",
        note: "可选纸条",
      },
      use_gift: { itemId: "自己的可食用物品 ID" },
      display_gift: {
        itemId: "自己的单份物品 ID",
        slot: `1–${giftShelfCapacity}`,
        description: "可选公开说明",
        publishNote: "默认为 false",
      },
      withdraw_gift: { slot: `1–${giftShelfCapacity}` },
    },
    clock: state.clock,
    day: state.day,
    dayRemaining: state.dayRemaining,
    weather: {
      id: state.weather.id,
      name: state.weather.name,
      kind: state.weather.kind,
    },
    speed: state.settings.speed,
    running: state.running,
    turnRemaining: Math.max(
      0,
      state.settings.turnLimit - garden.turnUsed(roleId, turnId),
    ),
    plots: state.plots.map(({ id, plant, sheltered, note }) => ({
      note,
      ...(note && { hasNote: true }),
      id,
      sheltered,
      shelterAction: {
        kind: sheltered ? "unshelter" : "shelter",
        args: { plot: id },
      },
      plant: plant && {
        id: plant.id,
        cropId: plant.cropId,
        name: plant.crop.name,
        status: plant.status,
        water: plant.water,
        lowWater: plant.rules.lowWater,
        progress: plant.growth / plant.crop.hours,
        quality: plant.quality,
        fertilizer: plant.fertilizer,
        fertilizerRequired: plant.crop.fertilizer,
        freeFertilizer:
          plant.status === "growing" && plant.earthwormDay !== undefined,
        witheredReason: plant.witheredReason,
        floodDays: plant.floodDays ?? 0,
        variant: plant.variant,
        variantName: plant.variantName,
        harvestCount: plant.harvestCount ?? 0,
        maxHarvests: plant.crop.maxHarvests ?? 1,
        neighborBuffs: neighborBuffs(state, id),
      },
    })),
    priorities: gardenPriorities(state),
    inventory: {
      seeds: state.seeds,
      fertilizer: state.fertilizer,
      fertilizerCredits: state.fertilizerCredits,
      harvests: marketHarvests(state),
    },
    market: {
      fertilizerPrice: state.settings.fertilizerPrice,
      crops: Object.entries(state.settings.crops)
        .filter(
          ([id, crop]) =>
            crop.enabled &&
            (crop.market ||
              !["mistbell", "sunberry", "four_leaf_clover"].includes(id) ||
              knownHiddenCrops.has(id)),
        )
        .map(([id, crop]) => ({
          id,
          name: crop.name,
          market: crop.market,
          seedPrice: crop.seedPrice,
          description: crop.description,
          light: crop.light,
          hours: crop.hours,
          dailyWater: crop.dailyWater,
          rainSensitive: crop.rainSensitive ?? id === "strawberry",
          fertilizer: crop.fertilizer,
          maxHarvests: crop.maxHarvests ?? 1,
          traits: gardenCropTraits(id, crop),
        })),
    },
    recipients: recipients(runtime),
  };
}

/** @param {any} runtime @param {string} roleId @param {GardenState} state @param {number} now */
function gardenObservations(runtime, roleId, state, now) {
  const { event, day, nightScene, pollenPairs } = state;
  const moments = [];
  if (
    nightScene.period === "night" &&
    event?.kind === "blessing" &&
    event.effect.effect === "firefly"
  )
    moments.push({
      kind: "firefly",
      title: "萤火虫音乐会",
      key: event.id,
      eventId: event.id,
    });
  if (
    nightScene.period === "night" &&
    event?.kind === "blessing" &&
    event.effect.effect === "meteor"
  )
    moments.push({
      kind: "meteor",
      title: "流星雨许愿夜",
      key: event.id,
      eventId: event.id,
    });
  if (nightScene.butterflies)
    moments.push({
      kind: "butterflies",
      title: "傍晚猫薄荷旁的蝴蝶",
      key: `butterflies:${day}`,
    });
  if (pollenPairs.length)
    moments.push({
      kind: "pollen",
      title: "邻株间飘起神秘花粉",
      key: `pollen:${day}`,
    });
  return moments.map((moment) => {
    const detail = `你在小窝花园观察了${moment.title}。`;
    const observation = recordGardenObservation(
      runtime,
      roleId,
      { ...moment, body: detail },
      now,
    );
    return { ...observation, surprise: { ...observation, detail } };
  });
}

/** @param {any} runtime @param {string} roleId
 * @param {{kind:string,title:string,key:string,eventId?:string,body?:string}} moment @param {number} now */
function recordGardenObservation(runtime, roleId, moment, now) {
  const generation = runtime.home.generation(roleId);
  const memory = runtime.memory.bind(roleId);
  const dedupe = `garden-observation:${generation}:${moment.key}`;
  const timestamp = new Date(now).toISOString();
  const record = memory.append({
    dedupe,
    kind: "garden.observation",
    direction: "internal",
    origin: "garden",
    conversation: "@garden",
    connectionId: runtime.agent(roleId).connectionId,
    occurredAt: timestamp,
    observedAt: timestamp,
    body: moment.body ?? `你在小窝花园观察了${moment.title}。`,
    payload: {
      eventId: moment.eventId,
      observationKind: moment.kind,
      generation,
    },
  });
  return { kind: moment.kind, title: moment.title, evidenceId: record.id };
}

/** @param {GardenState} state */
export function eventActions(state) {
  const { event } = state;
  if (!event || event.status !== "open") return [];
  const args = { eventId: event.id };
  if (event.kind === "thief")
    return [{ label: "驱赶小偷", kind: "chase_thief", args }];
  if (event.kind === "nuisance")
    return [
      {
        label:
          event.effect.effect === "cat"
            ? "哄走野猫"
            : `除虫 · ${event.effect.cost ?? 10} 元`,
        kind: "resolve_event",
        args,
      },
    ];
  if (
    event.kind === "harvest_bonus" &&
    event.effect.effect === "sketch" &&
    event.progress &&
    event.progress.current >= event.progress.required
  )
    return [{ label: "领取写生奖励", kind: "resolve_event", args }];
  if (
    event.kind === "mystery_box" &&
    event.available &&
    (event.purchased ?? 0) < event.effect.limit
  )
    return [
      {
        label: `买 1 袋种子盲盒 · ${event.effect.price} 元`,
        kind: "buy_mystery_seed",
        args: { ...args, quantity: 1, price: event.effect.price },
      },
    ];
  if (event.kind !== "merchant") return [];
  const buys = event.seedOffers.map((row) => {
    const price = Math.round(row.rate);
    return {
      label: `买 1 颗${row.name} · ${price} 元`,
      kind: "merchant_buy",
      args: { ...args, cropId: row.cropId, quantity: 1, price },
    };
  });
  const fertilizerBuys = (event.fertilizerOffers ?? []).map(
    ({ rate: price }) => ({
      label: `买 1 份肥料 · ${price} 元`,
      kind: "merchant_buy_fertilizer",
      args: { ...args, quantity: 1, price },
    }),
  );
  const offers = state.harvests.flatMap((row) => {
    const offer = (event.offers ?? (event.offer ? [event.offer] : [])).find(
      ({ cropId }) => cropId === row.crop_id,
    );
    if (!offer) return [];
    const price = Math.round(offer.rates[String(row.quality)]);
    return [
      {
        label: `溢价出售 1 份${offer.name} · ${price} 元`,
        kind: "merchant_sell",
        args: { ...args, harvestId: String(row.id), quantity: 1, price },
      },
    ];
  });
  return [...buys, ...fertilizerBuys, ...offers];
}
