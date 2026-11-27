import { bindGardenJournal, showGardenCard } from "./journal.js";
import { gardenStageAt, gardenStageLabel } from "./stages.js";
import { gardenCraftOrigin, giftShelfSlots } from "./gifts.js";
import * as art from "./art.js";

export { gardenGifts } from "./art.js";

export const gardenActions = {
  initialize: "开园",
  plant: "播种",
  buy_seed: "买种子",
  buy_seed_and_plant: "买种并播种",
  buy_fertilizer: "买肥料",
  water: "浇水",
  fertilize: "施肥",
  harvest: "收成",
  clear: "铲除枯株",
  shelter: "搭棚",
  unshelter: "撤棚",
  merchant_buy: "购买商人种子",
  merchant_sell: "卖给商人",
  chase_thief: "驱赶小偷",
  thief_loss: "小偷损失",
  sell: "出售",
  gift: "赠礼",
  merchant_buy_fertilizer: "购买商人肥料",
  resolve_event: "处理事件",
  choose_event: "选择事件选项",
  buy_mystery_seed: "购买盲盒",
  plant_mystery_seed: "种下盲盒",
  buy_gift: "购礼",
  craft_gift: "手作",
  build_facility: "建造设施",
  send_gift: "赠送物品",
  use_gift: "使用物品",
  display_gift: "展示物品",
  withdraw_gift: "收回展示",
  set_board_note: "保存花园留言",
  pop_seed_pod: "轻碰弹籽荚",
  event_reward: "事件奖励",
  event_cost: "事件支出",
};
const gardenQuality = { ordinary: "普通", fine: "优良", perfect: "完美" };
export const gardenLabels = {
  GLOBAL_PAUSED: "AI 全局暂停",
  ISOLATED_MODE: "框架处于隔离模式",
  UPDATE_IN_PROGRESS: "框架正在维护",
  GARDEN_DISABLED: "花园已暂停",
  GARDEN_PAUSED: "花园时钟已暂停",
  GARDEN_SETTINGS_CONFLICT: "设置已被更新。请先刷新，再核对你的修改。",
  GARDEN_PRICE_CHANGED: "价格已变化，请刷新后重试。",
  GARDEN_STOCK_UNAVAILABLE: "库存已有变化，请刷新后查看。",
  GARDEN_PLANT_CHANGED: "地块中的作物已变化，请刷新后查看。",
  GARDEN_EVENT_EXPIRED: "当天事件已过期，请刷新花园。",
  GARDEN_EVENT_CHOICE_INVALID: "这个选项的条件已变化，请刷新花园。",
  GARDEN_EVENT_ALREADY_RESOLVED: "已有伙伴作出了选择，请刷新查看结果。",
  GARDEN_EVENT_HANDLED: "这次事件已有人处理，请刷新花园。",
  GARDEN_EVENT_OFFER: "该报价已不可用，请刷新花园。",
  GARDEN_SHELTER_UNCHANGED: "棚状态已有变化，请刷新后查看。",
  GARDEN_PLOT_OCCUPIED: "这块地已有作物，请刷新后查看。",
  GARDEN_BALANCE_LOW: "公共账户余额不足。",
  GARDEN_WATER_FULL: "这株作物的水分已满。",
  GARDEN_FERTILIZER_FULL: "这株作物已施足肥料。",
  GARDEN_PLANT_STATE: "当前作物状态无法执行此操作。",
  GARDEN_RECIPIENT_UNAVAILABLE: "受赠对象已不可用。",
  GARDEN_GIFT_BUDGET_LOW: "今天的购礼与手作额度不足。",
  GARDEN_RECIPE_LOCKED: "建好干花晾晒架后才能制作。",
  GARDEN_RECIPE_INGREDIENTS: "原料不符合配方或库存已有变化，请刷新后查看。",
  GARDEN_FACILITY_ALREADY_BUILT: "这项设施已经建成。",
  GARDEN_ITEM_UNAVAILABLE: "这份物品已不可用，请刷新后查看。",
  GARDEN_ITEM_NOT_USABLE: "这份物品不能食用。",
  GARDEN_NOTE_TOO_LONG: "留言最多 120 字。",
  GARDEN_NOTE_LIMIT: "这一轮已经写了 3 次花园留言。",
  GARDEN_ROLE_UNAVAILABLE: "角色名单已有变化，请刷新后核对授权。",
};
const esc = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (char) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[char],
  );
const gardenOption = (key, label) =>
  `<option value="${esc(key)}">${esc(label)}</option>`;
const gardenDuration = (hours) =>
  new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 1 }).format(hours);
const gardenMoney = (value) => `${Number(value).toLocaleString("zh-CN")} 元`;
const gardenCropName = (state, id) => state.crops[id]?.name || id;
const gardenButton = (kind, text, main = false, disabled = false) =>
  `<button type="button" class="ghost${main ? " garden-main-action" : ""}" data-garden-act="${kind}"${disabled ? " disabled" : ""}>${text}</button>`;

function gardenHarvestTraits({
  cropId,
  harvestStage,
  ear,
  leafFront,
  leafBack,
}) {
  const stage = {
    tender:
      cropId === "sweet-corn"
        ? "嫩棒"
        : cropId === "drift-gourd"
          ? "嫩葫芦"
          : "嫩瓜",
    floating: "可漂流",
    bloom: "正开花",
    green: "青荚",
    silver: "银荚",
    dry: "干棒",
    hard: "硬壳",
  }[harvestStage];
  return [
    ear == null ? "" : `第 ${ear} 茬`,
    stage,
    leafFront && leafBack ? `叶面 ${leafFront} · 叶背 ${leafBack}` : "",
  ]
    .filter(Boolean)
    .join(" · ");
}

function gardenLotLabel(state, lot) {
  return [
    gardenCropName(state, lot.cropId),
    gardenHarvestTraits(lot),
    gardenQuality[lot.quality],
    `余 ${lot.quantity} 份`,
  ]
    .filter(Boolean)
    .join(" · ");
}

function gardenPlotMarkup({ id, plant, sheltered }, selected, bird) {
  const status = art.gardenPlotStatus(plant);
  const stage = plant
    ? gardenStageLabel(plant.cropId, gardenStageAt(plant))
    : status;
  const explorer = plant?.explorer;
  const condition =
    explorer?.bloom === "open"
      ? "花瓣舒展"
      : explorer?.bloom === "rolled"
        ? "花瓣卷起"
        : explorer?.silverBeads
          ? "绒叶带银珠"
          : (explorer?.leafShape ??
            (explorer &&
              gardenHarvestTraits({ cropId: plant.cropId, ...explorer })));
  return `<button type="button" class="garden-plot desktop-garden-tile garden-map-tile" data-stage="${status}" data-plot="${id}" aria-pressed="${id === selected}">
    <span class="garden-tile-top"><span aria-label="第 ${id} 块">${String(id).padStart(2, "0")}</span></span>
    ${art.gardenArtMarkup(art.gardenLayers({ plant, sheltered }))}
    <strong>${esc(plant?.variantName || plant?.crop.name || "空地")}</strong><small class="garden-plot-status">${stage}${status === "缺水" ? " · 缺水" : ""}</small>
    ${condition ? `<small class="garden-plot-condition">${esc(condition)}</small>` : ""}
    ${bird?.plot === id && bird.plantId === plant?.id ? '<small class="garden-bird">候鸟歇脚</small>' : ""}
  </button>`;
}

function gardenNoteMarkup(state, plot) {
  if (!state.boardNotes) return "";
  const note = plot ? plot.note : state.boardNotes.garden;
  const title = plot ? "地块便签" : "园艺小黑板";
  return `<section class="garden-board-note">
    <h4>${title}</h4>
    ${note ? `<p class="garden-note-text">${esc(note.text)}</p><small>${esc(note.authorName)} · 第 ${esc(note.day)} 天</small>` : "<p>还没有留言。</p>"}
    <details><summary>${note ? "编辑留言" : "写留言"}</summary>
      <form data-garden-note="${plot?.id ?? "garden"}">
        <fieldset${state.pauseReason ? " disabled" : ""}>
          <label>${title}<textarea name="text" rows="2" placeholder="最多 120 字">${note?.text ? "\n" + esc(note.text) : ""}</textarea></label>
          <button type="submit">保存留言</button>
          ${note ? '<button type="submit" value="clear">清除留言</button>' : ""}
        </fieldset>
      </form>
    </details>
  </section>`;
}

function gardenPlotDetail(state, plot) {
  const { id, plant, sheltered } = plot;
  const paused = Boolean(state.pauseReason);
  const canopy = sheltered
    ? gardenButton("unshelter", "撤棚")
    : gardenButton("shelter", "搭棚");
  if (!plant) {
    const crops = Object.entries(state.crops).filter(
      ([key, crop]) => crop.enabled && (crop.market || state.seeds[key] > 0),
    );
    return `<article class="garden-inspector" data-garden-detail="${id}"><small>第 ${id} 块地</small><h3>空地</h3><p>${sheltered ? "有棚" : "露天"}</p><fieldset${paused || !crops.length ? " disabled" : ""}>
      <select aria-label="第 ${id} 块的作物" data-garden-crop>${crops.map(([key, crop]) => gardenOption(key, `${crop.name} · ${state.seeds[key] > 0 ? "用库存种子" : gardenMoney(crop.seedPrice)}`)).join("")}</select>
      ${gardenButton("plant", "播种", true)}
    </fieldset><fieldset${paused ? " disabled" : ""}>${canopy}${state.mysterySeeds?.count ? gardenButton("plant_mystery_seed", "种下盲盒") : ""}</fieldset>${gardenNoteMarkup(state, plot)}</article>`;
  }
  const free = plant.earthwormDay !== undefined;
  const progress = Math.min(
    100,
    Math.floor((100 * plant.growth) / plant.crop.hours),
  );
  const stage = gardenStageLabel(plant.cropId, gardenStageAt(plant));
  return `<article class="garden-inspector" data-garden-detail="${id}">
    <small>第 ${id} 块地</small><h3>${esc(plant.variantName || plant.crop.name)}</h3><button type="button" data-journal-plant="${esc(plant.id)}">看这株 · 生长手帐</button>
    <p>${sheltered ? "有棚" : "露天"} · ${stage}${plant.quality ? " · " + gardenQuality[plant.quality] : ""}</p>
    ${plant.crop.maxHarvests > 1 ? `<p>已收 ${plant.harvestCount ?? 0} / ${plant.crop.maxHarvests} 茬</p>` : ""}
    ${plant.neighborBuffs?.length ? `<p>${plant.neighborBuffs.map(esc).join(" · ")}</p>` : ""}
    ${plant.explorer?.text && !plant.explorer.leafFront && !plant.explorer.neighbors?.length ? `<p class="garden-plant-clue">${esc(plant.explorer.text)}</p>` : ""}
    ${plant.explorer?.silverBeads && plant.explorer.leafShape ? `<p>叶形 · ${esc(plant.explorer.leafShape)}</p>` : ""}
    ${plant.explorer?.leafFront && plant.explorer?.leafBack ? `<p class="garden-ink-duo"><span>叶面 ${esc(plant.explorer.leafFront)}</span><span data-leaf-color="${plant.explorer.leafBack.includes("橙") ? "orange" : plant.explorer.leafBack.includes("玫") ? "rose" : "purple"}">叶背 ${esc(plant.explorer.leafBack)}</span></p>` : ""}
    ${plant.explorer?.neighbors?.length ? `<p>初开时记下的四邻</p><ul class="garden-echo-neighbors">${plant.explorer.neighbors.map(({ plot, name }) => `<li>第 ${esc(plot)} 块地 · ${esc(name)}</li>`).join("")}</ul>` : ""}
    ${plant.explorer?.rattles?.length ? '<button type="button" class="ghost" data-listen-pea>听豆荚</button>' : ""}
    ${
      plant.status === "growing"
        ? `<label>成长 <span>${progress}%</span><progress max="100" value="${progress}"></progress></label>
    <label>水分 <span>${Math.floor(plant.water)} / 100${plant.water < plant.rules.lowWater ? " · 缺水" : ""}</span><progress class="${plant.water < plant.rules.lowWater ? "garden-dry" : ""}" max="100" value="${plant.water}"></progress></label>
    <p>${plant.water === 0 ? (plant.rules.careMode === "gentle" ? "等水中 · 浇水后继续长" : "已连续无水 " + gardenDuration(plant.dry) + " / " + gardenDuration(plant.rules.dryHours) + " 花园小时") : ""}</p><p>施肥 ${plant.fertilizer}/${plant.crop.fertilizer}</p>`
        : ""
    }
    ${plant.witheredReason === "drought" ? '<p class="hint">长期缺水</p>' : ""}
    ${plant.witheredReason === "flood" ? '<p class="hint">连续暴雨积水</p>' : ""}
    <fieldset${paused ? " disabled" : ""}>
      ${
        plant.status === "mature"
          ? gardenButton("harvest", "收成", true)
          : plant.status === "withered"
            ? gardenButton("clear", "铲除枯株", true)
            : `${gardenButton("water", "浇水", true, plant.water >= 100)}${plant.fertilizer < plant.crop.fertilizer && (free || state.fertilizer || state.fertilizerCredits) ? gardenButton("fertilize", free ? "免费施肥" : "施肥") : ""}`
      }
      ${plant.explorer?.canPop ? gardenButton("pop_seed_pod", "轻碰弹籽荚") : ""}
      ${canopy}
    </fieldset>${gardenNoteMarkup(state, plot)}</article>`;
}

function gardenPriorityText({ plot, kind, hours, risk, hasNote }) {
  const time = gardenDuration(hours);
  return `第 ${plot} 块 · ${
    {
      dormant: "等水中，浇水后继续长",
      drought: `水分已用完，约 ${time} 个花园小时后枯萎`,
      water: hours === null ? "当前缺水" : `缺水，约 ${time} 个花园小时后耗尽`,
      flood: `暴雨积水，本日剩 ${Math.ceil(hours * 10) / 10} 花园小时 · ${risk === "critical" ? "日结束前搭棚，否则枯萎" : "建议搭棚"}`,
      low_water_forecast: `按现状约 ${time} 个花园小时后缺水`,
      harvest: hasNote ? "可收成 · 有便签" : "可收成",
      clear: "可以清理枯株",
    }[kind]
  }`;
}

function gardenWarehouse(state, guideOpen) {
  const market = Object.entries(state.crops).filter(
    ([, crop]) => crop.enabled && crop.market,
  );
  return `<div data-garden-warehouse>
    <h3>公共仓库</h3>
    <p>肥料 ${state.fertilizer} 包 · 免费施肥券 ${state.fertilizerCredits} 张 · 未开封种子袋 ${state.mysterySeeds?.count ?? 0} 袋</p>
    ${state.mysterySeeds?.bags?.length ? `<p>最早购入的种子袋可能种出：${state.mysterySeeds.bags[0].candidates.map(({ name }) => esc(name)).join("、")}。</p>` : ""}<label>查找物资<input type="search" data-stock-search></label><div class="garden-shelf garden-stock">${
      Object.entries(state.seeds)
        .filter(([, count]) => count > 0)
        .map(
          ([id, count]) =>
            `<div class="garden-good" data-search-stock>${productArt("crop", id)}<strong>${esc(gardenCropName(state, id))}</strong><span>${count} 颗</span></div>`,
        )
        .join("") || "<p>种子库存为空。</p>"
    }</div>
    <fieldset${state.pauseReason ? " disabled" : ""} class="garden-shop">
      <label>种子<select data-garden-seed>${market.map(([id, crop]) => gardenOption(id, crop.name + " · " + gardenMoney(crop.seedPrice))).join("")}</select></label>
      <label>购买数量<input data-garden-buy-count type="number" value="1" required min="1" max="1000000" step="1"/></label>
      ${gardenButton("buy_seed", "买种子", false, !market.length)}
      ${gardenButton("buy_fertilizer", `买肥料 · ${gardenMoney(state.fertilizerPrice)}/包`)}
    </fieldset>
    ${gardenCropGuide(state, guideOpen)}
    <h3>收成</h3><div class="garden-shelf">${
      state.market
        .map(
          (
            item,
          ) => `<article class="garden-good garden-harvest" data-search-stock data-harvest="${esc(item.id)}">
      ${productArt("crop", item.cropId)}<p><strong>${esc(gardenCropName(state, item.cropId))}</strong> · ${item.harvestStage || item.leafFront ? `${esc(gardenHarvestTraits(item))} · ` : ""}${gardenQuality[item.quality]} · 库存 ${item.quantity} · 单价约 ${gardenMoney(item.saleRate)}/份</p>
      <fieldset${state.pauseReason ? " disabled" : ""}>
        <label>数量<input data-garden-sale-count type="number" required min="1" max="${item.quantity}" step="1" value="1"/></label>
        <p>总价 <output data-sale-total>${gardenMoney(Math.round(item.saleRate))}</output></p>
        ${gardenButton("sell", "出售")}
        ${selectRecipient(state)}
        ${gardenButton("gift", "赠送", false, true)}
      </fieldset></article>`,
        )
        .join("") || '<p class="hint">还没有收成。</p>'
    }
  </div></div>`;
}

function gardenActionFrom(button, state) {
  const kind = button.dataset.gardenAct;
  if (kind === "build_facility") {
    const facility = state.facilities.find(
      ({ id }) => id === button.dataset.facility,
    );
    return { kind, facilityId: facility.id, price: facility.price };
  }
  if (button.dataset.gardenEventIndex !== undefined)
    return gardenChoiceAction(state, button, button.dataset.gardenEventIndex);
  const parent = button.closest("[data-garden-detail]");
  if (parent) {
    const entry = state.plots.find(
      (plot) => plot.id === Number(parent.dataset.gardenDetail),
    );
    if (
      kind === "shelter" ||
      kind === "unshelter" ||
      kind === "plant_mystery_seed"
    )
      return { kind, plot: entry.id };
    if (kind !== "plant")
      return { kind, plot: entry.id, plantId: entry.plant.id };
    const cropId = parent.querySelector("[data-garden-crop]").value;
    return {
      kind,
      plot: entry.id,
      cropId,
      ...(state.seeds[cropId] > 0
        ? {}
        : { buyPrice: state.crops[cropId].seedPrice }),
    };
  }
  const stock = button.closest("[data-harvest]");
  if (stock) {
    const count = stock.querySelector("[data-garden-sale-count]");
    if (!count.reportValidity()) return null;
    const quantity = count.valueAsNumber;
    const harvestId = stock.dataset.harvest;
    if (kind === "sell") {
      const item = state.market.find((row) => row.id === harvestId);
      return {
        kind,
        harvestId,
        quantity,
        price: Math.round(item.saleRate * quantity),
      };
    }
    const select = stock.querySelector('select[name="recipient"]');
    if (!select.reportValidity()) return null;
    const { kind: targetKind, id } = state.roles[select.value];
    return { kind, harvestId, quantity, recipient: { kind: targetKind, id } };
  }
  const shop = button.closest(".garden-shop");
  const count = shop.querySelector("[data-garden-buy-count]");
  if (!count.reportValidity()) return null;
  const quantity = count.valueAsNumber;
  if (kind === "buy_fertilizer")
    return { kind, quantity, price: state.fertilizerPrice * quantity };
  const cropId = shop.querySelector("[data-garden-seed]").value;
  return {
    kind,
    cropId,
    quantity,
    price: state.crops[cropId].seedPrice * quantity,
  };
}

function productArt(group, id) {
  return art.gardenIconMarkup(group, id);
}

function eventButton(
  action,
  index,
  disabled,
  label = action.label,
  projectIndex,
) {
  return `<button type="button" class="ghost" data-garden-act="${action.kind}" data-garden-event-index="${index}"${projectIndex === undefined ? "" : ` data-garden-project-index="${projectIndex}"`}${disabled ? " disabled" : ""}>${esc(label)}</button>`;
}

function switchButton(group, value, current, label) {
  return `<button type="button" data-garden-switch="${group}" data-value="${value}" aria-pressed="${value === current}">${label}</button>`;
}

function selectRecipient(state) {
  return `<label>送给<select name="recipient" aria-label="送给" required><option value="">选择收件人</option>${state.roles.map((role, index) => (role.kind === "admin" ? "" : gardenOption(index, role.name))).join("")}</select></label>`;
}

const noteInput = () =>
  '<label>赠言（可选）<textarea name="note" rows="2" maxlength="280"></textarea></label>';

function giftOffer(state, offer, index) {
  const available =
    (offer.stock == null || offer.stock > 0) && state.balance >= offer.price;
  return `<article class="garden-good">${productArt("gift", offer.giftId)}
    <strong>${esc(offer.name)}</strong><span class="garden-price">${offer.originalPrice != null && offer.originalPrice !== offer.price ? `<del>${gardenMoney(offer.originalPrice)}</del> ` : ""}${gardenMoney(offer.price)}</span>
    ${offer.stock != null ? `<small>余 ${offer.stock} 份</small>` : ""}
    ${
      available
        ? `<details><summary>选购</summary>
      <form data-garden-form="buy_gift" data-offer="${index}"><fieldset${state.pauseReason ? " disabled" : ""}>
        <label>购买方式<select name="delivery" aria-label="购买方式"><option value="keep">买下收好</option><option value="send">买下送给…</option></select></label>
        <fieldset data-gift-delivery hidden disabled>${selectRecipient(state)}${noteInput()}</fieldset>
        <p data-gift-confirmation>用公共金币 ${gardenMoney(offer.price)}，收进我的物品栏。</p>
        <button class="garden-main-action" type="submit">确认购买</button>
      </fieldset></form></details>`
        : `<small>${offer.stock === 0 ? "今日售罄" : "余额不足"}</small>`
    }
  </article>`;
}

function merchantShelf(state, view) {
  const { event } = state;
  const buys = event.seedOffers || [];
  const fertilizers = event.fertilizerOffers || [];
  const sales = event.offers ?? (event.offer ? [event.offer] : []);
  const gifts = event.giftOffers || [];
  const tabs = `<div class="garden-selector" aria-label="摊位货架">
    ${switchButton("lane", "buy", view.lane, `在售 · ${buys.length + fertilizers.length + gifts.length}`)}
    ${switchButton("lane", "sell", view.lane, `收购 · ${sales.length}`)}
  </div>`;
  const sub =
    gifts.length && view.lane === "buy"
      ? `<div class="garden-selector" aria-label="在售分类">
    ${switchButton("goods", "supplies", view.goods, "花园用品")}
    ${switchButton("goods", "gifts", view.goods, "小礼物")}
  </div>`
      : "";
  const buttons = (kind, predicate, label) =>
    state.eventActions
      .flatMap((action, i) =>
        action.kind === kind && predicate(action.args)
          ? [
              eventButton(
                action,
                i,
                state.pauseReason ||
                  (kind !== "merchant_sell" &&
                    action.args.price > state.balance),
                label,
              ),
            ]
          : [],
      )
      .join("");
  const rate = (price, original) =>
    `<span class="garden-price">${original != null && original !== price ? `<del>${gardenMoney(Math.round(original))}</del> ` : ""}${gardenMoney(Math.round(price))}</span>`;
  let goods;
  if (view.lane === "sell") {
    goods = sales.map((offer) => {
      const stock = state.market.filter((item) => item.cropId === offer.cropId);
      const tiers = Object.entries(offer.rates).map(([quality, price]) => {
        const lots = stock.filter((item) => item.quality === quality);
        return `<small>${gardenQuality[quality]} · ${gardenMoney(Math.round(price))} · 库存 ${lots.reduce((sum, item) => sum + item.quantity, 0)}</small>
          ${buttons("merchant_sell", ({ harvestId }) => lots.some((item) => item.id === harvestId), `卖 1 份${gardenQuality[quality]}`)}`;
      });
      return `<article class="garden-good">${productArt("crop", offer.cropId)}<strong>${esc(offer.name)}</strong>${tiers.join("")}</article>`;
    });
  } else if (view.goods === "gifts" && gifts.length) {
    goods = gifts.map((offer, index) => giftOffer(state, offer, index));
  } else {
    goods = [
      ...buys.map(
        (
          offer,
        ) => `<article class="garden-good">${productArt("crop", offer.cropId)}
        <strong>${esc(offer.name)}种子</strong>${rate(offer.rate, offer.originalRate)}
        ${buttons("merchant_buy", ({ cropId }) => cropId === offer.cropId, offer.rate > state.balance ? "余额不足" : "买 1 颗")}</article>`,
      ),
      ...fertilizers.map(
        (
          offer,
        ) => `<article class="garden-good">${productArt("supply", "fertilizer")}
        <strong>园艺肥料</strong>${rate(offer.rate, offer.originalRate)}
        ${buttons("merchant_buy_fertilizer", () => true, offer.rate > state.balance ? "余额不足" : "买 1 包")}</article>`,
      ),
    ];
  }
  return `${tabs}${sub}<div class="garden-shelf">${goods.join("") || "<p>这个货架暂无商品。</p>"}</div>
    <p class="garden-receipt" role="status">${esc(view.eventReceipt || "营业至本花园日结束。")}</p>`;
}

const kindLabels = {
  merchant: "商人来访",
  visitor: "花园访客",
  thief: "捣蛋事件",
  nuisance: "捣蛋事件",
  blessing: "花园祝福",
  weather_flip: "天气变化",
  harvest_bonus: "园艺奖励",
  mystery_box: "种子盲盒",
  choice: "花园抉择",
  story: "花园小景",
  explorer: "花园探索",
  table: "花园小聚",
  memory: "花园现场记忆",
};
const effectCopy = {
  cat: "日终仍未哄走时，它会撤掉一座现有的棚。",
  aphids: "虫害期间生长减慢，日终仍未除虫时会损失品质。",
  meteor: "流星划过时，生长中的作物获得成长与品质加成。",
  dew: "清晨的露水滋润了田间的幼苗。",
  firefly: "喜阴植物沐浴在萤火虫的微光里。",
  sketch: "让不同的作物同时出现在花圃里，达标后可领奖。",
};

const gardenInteractiveEvents = new Set([
  "choice",
  "explorer",
  "table",
  "memory",
]);

function gardenChoiceEntry(state, control, index) {
  const project = control.dataset.gardenProjectIndex;
  const actions =
    project === undefined
      ? state.eventActions
      : state.gardenProjects[Number(project)].actions;
  return actions[Number(index)];
}

function gardenChoiceAction(state, control, index) {
  const action = gardenChoiceEntry(state, control, index);
  return action
    ? {
        kind: action.kind,
        ...action.args,
        ...(action.textPrompt && { text: control.elements.text.value.trim() }),
      }
    : null;
}

function gardenChoiceOptions(state, project, projectIndex) {
  const choices = new Map();
  (project?.actions ?? state.eventActions).forEach((action, index) => {
    if (
      action.kind !== "choose_event" ||
      (!project &&
        state.event?.photos?.length &&
        action.args.choiceId === "compare-plot")
    )
      return;
    const key = action.args.choiceId;
    if (!choices.has(key)) choices.set(key, []);
    choices.get(key).push({ action, index });
  });
  const explorer = project || state.event.kind !== "choice";
  const targetLabel = ({ plot, harvestId, itemId, cropId, referenceDay }) => {
    const labels = [];
    if (referenceDay !== undefined) labels.push(`回看第 ${referenceDay} 天`);
    if (plot !== undefined) {
      const plant = state.plots.find(({ id }) => id === plot)?.plant;
      labels.push(
        explorer
          ? `第 ${plot} 块地${plant ? " · " + (plant.variantName || plant.crop.name) : ""}`
          : `第 ${plot} 块棚`,
      );
    }
    if (itemId !== undefined) {
      const items = state.personalGifts?.items ?? [];
      const item = items.find(({ id }) => id === itemId);
      if (item) {
        const copies = items.filter(({ giftId }) => giftId === item.giftId);
        labels.push(
          [
            item.name,
            copies.length > 1 ? `第 ${copies.indexOf(item) + 1} 份` : "",
            item.slot ? `展示第 ${item.slot} 格` : "",
          ]
            .filter(Boolean)
            .join(" · "),
        );
      } else labels.push("我的物品");
    }
    if (harvestId !== undefined) {
      const lot = state.market.find(({ id }) => id === harvestId);
      labels.push(lot ? gardenLotLabel(state, lot) : "仓库收成");
    }
    if (cropId !== undefined) labels.push(gardenCropName(state, cropId));
    return labels.join(" ／ ");
  };
  return [...choices.values()]
    .map((entries) => {
      const { action, index } = entries[0];
      const label =
        (project ? undefined : state.event.effect.options)?.find(
          ({ id }) => id === action.args.choiceId,
        )?.label ?? action.label;
      const { plot, harvestId, itemId, cropId, referenceDay } = action.args;
      const targets = [
        plot !== undefined && (explorer ? "选择地块" : "选择遮雨棚"),
        harvestId !== undefined && "选择一份收成",
        itemId !== undefined && "选择我的物品",
        cropId !== undefined && "选择一种作物",
        referenceDay !== undefined && "选择回看的日期",
      ].filter(Boolean);
      const target =
        targets.length > 1
          ? "选择组合"
          : (targets[0] ?? (entries.length > 1 ? "选择做法" : ""));
      const description = action.description
        ? `<p>${esc(action.description)}</p>`
        : "";
      if (!target && !action.textPrompt)
        return `<div class="garden-choice">${description}${eventButton(action, index, state.pauseReason, label, projectIndex)}</div>`;
      return `<form class="garden-choice" data-garden-choice${projectIndex === undefined ? "" : ` data-garden-project-index="${projectIndex}"`}>${description}
        <fieldset${state.pauseReason ? " disabled" : ""}>
          ${
            target
              ? `<label>${target}<select name="choice" aria-label="${target}"${explorer ? " data-update-choice-label" : ""} required>
            ${entries.map(({ action, index }) => gardenOption(index, targetLabel(action.args) || action.label)).join("")}
          </select></label>`
              : `<input type="hidden" name="choice" value="${index}">`
          }
          ${action.textPrompt ? `<label>${esc(action.textPrompt)}<input name="text" type="text" required></label>` : ""}
          <button type="submit" class="ghost">${esc(label)}</button>
        </fieldset></form>`;
    })
    .join("");
}

function gardenProjects(state) {
  if (!state.gardenProjects?.length) return "";
  return state.gardenProjects
    .map(
      (project, index) => `<section class="garden-explorer-project">
    <h3>${esc(project.name)}</h3><p>${esc(project.detail)}</p>
    ${gardenChoiceOptions(state, project, index)}
  </section>`,
    )
    .join("");
}

function gardenFollowups(state) {
  const replies = (state.followups ?? []).filter(
    ({ day }) => day === state.day,
  );
  if (!replies.length) return "";
  return `<aside class="garden-followups"><h3>隔日回响</h3><ul>${replies.map(({ title, text }) => `<li>${title ? `<strong>${esc(title)}</strong> · ` : ""}${esc(text)}</li>`).join("")}</ul></aside>`;
}

function gardenBird(state) {
  const { event } = state;
  return event?.effect?.story === "migratory_bird" &&
    !event.outcome?.unavailable
    ? event.target
    : undefined;
}

function gardenPhotoMarkup(state, view) {
  const { photos, today } = state.event;
  if (!photos?.length || !today?.length) return "";
  const photo = photos.find(({ day }) => day === view.photoDay) ?? photos[0];
  const stageLabels = {
    seedling: "已播种",
    growing: "生长中",
    mature: "成熟",
    withered: "枯萎",
  };
  const grid = (plots, historic) => `<div class="garden-photo-grid">
    ${plots
      .map(({ plot, name, stage }) => {
        const cells = `<span>第 ${esc(plot)} 格</span><strong>${esc(name || "空地")}</strong>${stage ? `<small>${esc(stageLabels[stage] ?? stage)}</small>` : ""}`;
        const index = historic
          ? state.eventActions.findIndex(
              ({ args }) =>
                args.choiceId === "compare-plot" &&
                args.referenceDay === photo.day &&
                args.plot === plot,
            )
          : -1;
        return index < 0
          ? `<div class="garden-photo-cell">${cells}</div>`
          : `<button type="button" class="garden-photo-cell ghost" data-garden-act="choose_event" data-garden-event-index="${index}" aria-label="对照第 ${esc(photo.day)} 天第 ${esc(plot)} 格 · ${esc(name || "空地")}"${state.pauseReason ? " disabled" : ""}>${cells}</button>`;
      })
      .join("")}
  </div>`;
  return `<section class="garden-photo-pair" aria-label="今昔九格">
    <section>
      <label>旧照日期<select aria-label="旧照日期" data-garden-photo-day>
        ${photos.map(({ day }) => `<option value="${esc(day)}"${day === photo.day ? " selected" : ""}>第 ${esc(day)} 天</option>`).join("")}
      </select></label>
      ${grid(photo.plots, true)}
    </section>
    <section><p>今天 · 第 ${esc(state.day)} 天</p>${grid(today, false)}</section>
  </section>`;
}

function eventBody(state, view) {
  const { event } = state;
  if (event.kind === "merchant") return merchantShelf(state, view);
  const effect = event.effect || {};
  const outcome = event.outcome || {};
  const status = {
    claimed:
      {
        visitor: "奖励已入公共仓库",
        nuisance: "事件已处理",
        blessing: "日初已生效",
      }[event.kind] || "奖励已领取",
    chased: "小偷已被驱赶",
    resolved: "事件已处理",
    applied: "日初已生效",
    fulfilled: "奖励已领取",
  }[event.status];
  let details = gardenPhotoMarkup(state, view);
  if (event.kind === "story" || gardenInteractiveEvents.has(event.kind)) {
    if (outcome.label) details += `<p>已选 · ${esc(outcome.label)}</p>`;
    if (outcome.detail)
      details += `<p class="garden-event-outcome" role="status">${esc(outcome.detail)}</p>`;
    if (outcome.plantCard?.imageRequest)
      details +=
        '<button type="button" class="ghost" data-garden-history-card>查看对照花卡</button><div data-garden-history-image></div>';
    if (gardenInteractiveEvents.has(event.kind) && outcome.plots?.length)
      details += `<div class="garden-event-actions">${outcome.plots.map((plot) => `<button type="button" class="ghost" data-garden-jump="${esc(plot)}">看第 ${esc(plot)} 块地</button>`).join("")}</div>`;
    if (outcome.pausedPlot)
      details += `<p>第 ${esc(outcome.pausedPlot)} 块地暂留给小猫。</p>`;
    const bird = gardenBird(state);
    if (bird) {
      const atPlot = state.plots.find(({ id }) => id === bird.plot);
      details +=
        atPlot?.plant?.id === bird.plantId
          ? `<button type="button" class="ghost" data-garden-jump="${bird.plot}">查看候鸟歇脚的第 ${bird.plot} 块地</button>`
          : "<p>候鸟歇脚的植株已离开花圃。</p>";
    }
    if (
      gardenInteractiveEvents.has(event.kind) &&
      event.status === "open" &&
      !state.eventActions.length
    )
      details +=
        effect.story === "boot_pond" && outcome.detail
          ? "<p>叶舟先顺着水漂一会儿。</p>"
          : "<p>眼下没有可选的地块或收成。</p>";
  } else if (event.kind === "visitor" && event.reward) {
    const { kind, cropId, quantity } = event.reward;
    const label =
      kind === "seed"
        ? `${esc(gardenCropName(state, cropId))}种子 ${quantity} 颗`
        : kind === "fertilizer"
          ? `肥料 ${quantity} 包`
          : `免费施肥券 ${quantity} 张`;
    details = `<p>访客带来${label}。</p>`;
  } else if (event.kind === "thief" && event.status === "open") {
    details = `<p>驱赶奖励 ${gardenMoney(event.reward)}。${event.targetCropId ? `日终会取走最多 ${event.cropLoss} 份${esc(gardenCropName(state, event.targetCropId))}。` : `日终会取走最多 ${event.cropLoss} 份收成，仓库没有收成时扣最多 ${gardenMoney(event.coinLoss)}。`}</p>`;
  } else if (event.kind === "weather_flip" && event.targetWeather) {
    details = `<p>${esc(event.forecast?.name ?? state.weatherForecast?.name)} → ${esc(event.targetWeather.name)} · ${effect.hour}:00 切换</p><p>当前实况：${esc(state.weather.name)}。积水按日终实况结算。</p>`;
  } else if (event.kind === "blessing") {
    if (effect.effect === "earthworm") {
      const plot = state.plots.find((entry) => entry.id === outcome.plotId);
      details = `<p>${outcome.used ? "免费施肥已使用。" : !outcome.unavailable && plot?.plant?.id === outcome.plantId && plot?.plant ? `第 ${plot.id} 块的这株作物下次施肥免费。` : "松土权益已失效。"}</p>`;
    } else {
      const rows = (outcome.plots || []).map((plot) => {
        const changes = [
          plot.quality ? `品质 +${plot.quality}` : "",
          plot.growth ? `成长 +${gardenDuration(plot.growth)} 小时` : "",
          plot.water ? `水分 +${gardenDuration(plot.water)}` : "",
        ].filter(Boolean);
        return `<li>第 ${plot.plotId} 块${changes.length ? " · " + changes.join(" · ") : ""}</li>`;
      });
      details = rows.length
        ? `<ul>${rows.join("")}</ul>`
        : "<p>今天没有受益地块。</p>";
    }
  } else if (effect.effect === "sketch" && event.progress) {
    const { current, required } = event.progress;
    details = `<p>花圃里已有 ${current} 种作物 · 目标 ${required} 种</p><progress aria-label="写生达标进度" max="${required}" value="${Math.min(current, required)}"></progress>`;
  } else if (effect.effect === "twin") {
    details = `<p>${outcome.plotId ? `第 ${outcome.plotId} 块地的 ${outcome.quantity} 份收成已入库。` : `今天全园第一笔成熟收成的产量为 ${effect.multiplier ?? 2} 倍。`}</p>`;
  } else if (event.kind === "mystery_box") {
    details = `<p><strong>${gardenMoney(effect.price)} / 袋</strong> · 已购 ${event.purchased ?? 0} / ${effect.limit}</p>
    <p>仓库待拆 ${state.mysterySeeds?.count ?? 0} 袋，可留到以后再种。</p>`;
    const empty = state.plots.find(({ plant }) => !plant);
    if (event.available === false || (event.purchased ?? 0) >= effect.limit)
      details += "<p>今日种子袋已停售。</p>";
    if (empty && state.mysterySeeds?.count)
      details += `<button type="button" class="ghost" data-garden-jump="${empty.id}">去空地播种</button>`;
  }
  const actions = gardenInteractiveEvents.has(event.kind)
    ? gardenChoiceOptions(state)
    : state.eventActions
        .map((entry, index) => {
          const cost =
            entry.args.price ??
            (effect.effect === "aphids" ? (effect.cost ?? 10) : 0);
          const reward = {
            cat: effect.reward ?? 10,
            sketch: effect.reward ?? 80,
          }[effect.effect];
          const label = reward
            ? `${entry.label} · +${gardenMoney(reward)}`
            : entry.label;
          return eventButton(
            entry,
            index,
            state.pauseReason || cost > state.balance,
            label,
          );
        })
        .join("");
  return `${status ? `<p><strong>${status}</strong></p>` : ""}${details}
    ${actions ? `<div class="garden-event-actions">${actions}</div>` : ""}
    ${view.eventReceipt && view.eventReceipt !== outcome.detail ? `<p class="garden-receipt" role="status">${esc(view.eventReceipt)}</p>` : ""}`;
}

function gardenEventMarkup(state, view) {
  const { event } = state;
  if (!event)
    return '<article class="garden-ticket"><h3>今日事件</h3><p>今天没有特殊事件。</p></article>';
  const image =
    productArt("event", art.gardenEventArtId(event)) ||
    (event.kind === "weather_flip"
      ? art.gardenIconMarkup("weather", state.weather.kind)
      : art.gardenIconMarkup(
          "event",
          ["merchant", "thief", "visitor"].includes(event.kind)
            ? event.kind
            : "visitor",
        ));
  const copy = event.description ?? effectCopy[event.effect?.effect];
  return `<article class="garden-ticket${event.kind === "merchant" ? " garden-merchant" : ""}">
    <header>${image}<div><small>今日事件 · ${kindLabels[event.kind] || "花园日常"}</small><h3>${esc(event.name)}</h3>${copy ? `<p>${esc(copy)}</p>` : ""}</div></header>
    ${eventBody(state, view)}
  </article>`;
}

function craftOrigin(meta) {
  const text = gardenCraftOrigin(meta);
  return text ? `<p class="garden-craft-origin">${esc(text)}</p>` : "";
}

function communityGiftMarkup(shelves) {
  return `<h3>串门看展示柜</h3>${
    shelves.length
      ? shelves
          .map(
            ({ owner, items }) =>
              `<details class="garden-visit-shelf">
      <summary>${esc(owner.name)}的展示柜 · ${items.length} / ${giftShelfSlots.length} 格</summary>
      ${shelfMarkup(items, false)}
    </details>`,
          )
          .join("")
      : "<p>还没有伙伴摆出展示物。</p>"
  }`;
}

function shelfMarkup(shelf, editable, paused) {
  return `<div class="${editable ? "garden-display" : "garden-visit-display"} gift-cabinet">${giftShelfSlots
    .map((slot) => {
      const item = shelf.find((entry) => entry.slot === slot);
      if (!item?.name)
        return `<article class="cabinet-cell cabinet-empty"><small>第 ${slot} 格</small><span>空位</span></article>`;
      return `<article class="cabinet-cell"><small>第 ${slot} 格</small>${productArt("gift", item.giftId)}
      <strong>${esc(item.name)}</strong>${item.description ? `<p>${esc(item.description)}</p>` : ""}${item.note ? `<p>${esc(item.note)}</p>` : ""}
      ${craftOrigin(item.craftMeta)}
      ${editable ? `<button type="button" class="ghost" data-withdraw="${slot}"${paused ? " disabled" : ""}>收回</button>` : ""}</article>`;
    })
    .join("")}</div>`;
}

function giftSource({ giver, recipient, day, note }, sent = false) {
  const name = sent ? `送给${recipient.name}` : giver?.name || "原赠送者";
  return `<p>${esc(name)} · 第 ${esc(day)} 个花园日</p>${note ? `<blockquote>${esc(note)}</blockquote>` : ""}`;
}

function personalGiftMarkup(state, view) {
  const gifts = state.personalGifts;
  if (!gifts) return "<p>暂时无法读取物品栏。</p>";
  const { items, received, shelf } = gifts;
  const firstEmpty = giftShelfSlots.find(
    (slot) => !shelf.some((entry) => entry.slot === slot),
  );
  const filtered = items.filter(
    (item) =>
      view.filter === "all" ||
      (view.filter === "displayed" ? item.slot : item.source),
  );
  const groups = Map.groupBy(filtered, (item) => item.giftId);
  const byId = new Map(received.map((source) => [source.id, source]));
  return `<header class="cabinet-heading"><h3>我的展示柜</h3><span>${shelf.length} / ${giftShelfSlots.length} 格</span></header>
    ${shelfMarkup(shelf, true, state.pauseReason)}
    <h3>我的物品</h3><div class="garden-selector" aria-label="物品筛选">
    ${switchButton("filter", "all", view.filter, "全部")}
    ${switchButton("filter", "received", view.filter, "收到的")}
    ${switchButton("filter", "displayed", view.filter, "展示中")}
  </div><div class="garden-shelf">${
    Array.from(
      groups,
      ([giftId, copies]) => `<article class="garden-good">
    ${productArt("gift", giftId)}<strong>${esc(copies[0].name)}</strong><span>${copies.length} 份</span>
    <details><summary>查看物品</summary>${copies
      .map((item, index) => {
        const source =
          typeof item.source === "object" ? item.source : byId.get(item.source);
        return `<section class="garden-gift-copy" data-item="${esc(item.id)}">
        <h4>第 ${index + 1} 份${item.slot ? ` · 展示格 ${item.slot}` : ""}</h4>
        ${source ? giftSource(source) : item.craftMeta ? "<p>花园手作</p>" : art.gardenGifts[giftId]?.eventOnly ? "<p>花园纪念品</p>" : "<p>自己购买</p>"}
        ${craftOrigin(item.craftMeta)}
        ${item.loaned ? "<p>窗边借用中，明早归还。</p>" : ""}
        ${art.gardenGifts[giftId]?.eventOnly && item.description ? `<p>${esc(item.description)}</p>` : ""}
        <details><summary>送给伙伴</summary><form data-garden-form="send_gift"><fieldset${state.pauseReason || item.loaned ? " disabled" : ""}>
          ${selectRecipient(state)}${noteInput()}<button type="submit">确认赠送</button>
        </fieldset></form></details>
        <details><summary>${item.slot ? "换位或更新展示" : "摆入展示栏"}</summary>
          <form data-garden-form="display_gift"><fieldset${state.pauseReason || item.loaned ? " disabled" : ""}>
          <label>展示格<select name="slot">${giftShelfSlots
            .map((slot) => {
              const occupant = shelf.find((entry) => entry.slot === slot);
              return `<option value="${slot}"${(item.slot ?? firstEmpty) === slot ? " selected" : ""}>第 ${slot} 格${occupant ? " · " + esc(occupant.name) : " · 空位"}</option>`;
            })
            .join("")}</select></label>
          <label>公开说明<textarea name="description" rows="2" maxlength="280">${esc(shelf.find((entry) => entry.slot === item.slot)?.description)}</textarea></label>
          ${source?.note ? `<label><input type="checkbox" name="publishNote"${item.note ? " checked" : ""}>公开这份礼物的赠言</label>` : ""}
          <button type="submit">确认展示</button>
        </fieldset></form></details>
        ${item.usable && !item.loaned ? `<form data-garden-form="use_gift"><button type="submit"${state.pauseReason ? " disabled" : ""}>吃掉这份</button></form>` : ""}
      </section>`;
      })
      .join("")}</details></article>`,
    ).join("") || "<p>这里还没有物品。</p>"
  }</div>

    <details class="garden-received"><summary>收到的礼物记录 · ${received.length} 份</summary>
      ${received.map((source) => `<article><strong>${esc(source.name)}</strong>${giftSource(source)}${craftOrigin(source.craftMeta)}</article>`).join("") || "<p>还没有收到小礼物。</p>"}
    </details>
    ${
      gifts.sent?.length
        ? `<details class="garden-received"><summary>送出的礼物记录 · ${gifts.sent.length} 份</summary>
      ${gifts.sent
        .map(
          (source) => `<article><strong>${esc(source.name)}</strong>
        ${giftSource(source, true)}${craftOrigin(source.craftMeta)}</article>`,
        )
        .join("")}
    </details>`
        : ""
    }`;
}

function gardenCraftMarkup(state) {
  return `<h3>花园手作台</h3><div class="garden-shelf garden-recipes">
    ${state.craftRecipes
      .map((recipe) => {
        const {
          id,
          name,
          price,
          usable,
          locked,
          ready,
          harvestIds,
          ingredientCount,
          requirements,
          suggestedHarvestIds,
        } = recipe;
        const lots = state.market.filter((lot) => harvestIds.includes(lot.id));
        const names = (lot) => gardenLotLabel(state, lot);
        const ingredients = Array.from(
          { length: ingredientCount },
          (_, index) => {
            const pick = suggestedHarvestIds?.[index];
            const other = lots.find(
              (lot) => lot.id === suggestedHarvestIds?.[1 - index],
            );
            return `<label>原料 ${index + 1}<select data-craft-ingredient aria-label="原料 ${index + 1}" name="harvestId" required>
          <option value="">选择收成</option>
          ${lots.map((lot) => `<option value="${esc(lot.id)}" data-crop="${esc(lot.cropId)}"${lot.id === pick ? " selected" : ""}${lot.cropId === other?.cropId ? " disabled" : ""}>${esc(names(lot))}</option>`).join("")}
        </select></label>`;
          },
        ).join("");
        return `<article class="garden-good" data-garden-recipe="${esc(id)}">
        ${productArt("gift", id)}<h4>${esc(name)}</h4>
        <p>${requirements.map(esc).join(" · ")}</p>
        <p>工本费 ${gardenMoney(price)}${usable ? " · 可食用" : ""}</p>
        ${
          locked
            ? "<p>建好干花晾晒架后解锁。</p>"
            : !ready
              ? "<p>仓库里的原料还不够。</p>"
              : `<form data-garden-form="craft_gift"><fieldset${state.pauseReason ? " disabled" : ""}>
            ${ingredients}
            <label>成品去向<select name="delivery" aria-label="成品去向"><option value="keep">自己收好</option><option value="send">送给伙伴</option></select></label>
            <fieldset data-gift-delivery hidden disabled>${selectRecipient(state)}${noteInput()}</fieldset>
            <button type="submit" class="garden-main-action"${price > state.balance ? " disabled" : ""}>制作</button>
            ${price > state.balance ? "<p>公共金币不足。</p>" : ""}
          </fieldset></form>`
        }
      </article>`;
      })
      .join("")}
  </div>`;
}

function gardenAlmanacRecent(entries = []) {
  return entries.length
    ? `<p>最近点亮 · ${entries.map(({ name, variantName }) => esc(variantName || name)).join("、")}</p>`
    : "";
}

function gardenAlmanacMarkup({ entries, unlocked, total, newlyUnlocked }) {
  return `<h3>植物图鉴</h3><p>已点亮 ${esc(unlocked)} / ${esc(total)} 种</p>
    ${gardenAlmanacRecent(newlyUnlocked)}
    <div class="garden-shelf">${
      entries
        .map(
          (
            entry,
          ) => `<article class="garden-good" data-almanac-crop="${esc(entry.cropId)}">
      ${productArt("crop", entry.cropId)}<h4>${esc(entry.name)}</h4>
      <p>种植 ${esc(entry.plantedCount)} 株 · 收成 ${esc(entry.harvestCount)} 次</p>
      ${entry.firstDiscoveredDay != null ? `<p>第 ${esc(entry.firstDiscoveredDay)} 天首次点亮</p>` : ""}
      ${entry.bestQuality ? `<p>最佳品质 · ${esc(gardenQuality[entry.bestQuality])}</p>` : ""}
      ${entry.variants?.length ? `<p>已见花色 · ${entry.variants.map(({ name }) => esc(name)).join("、")}</p>` : ""}
    </article>`,
        )
        .join("") || "<p>种下第一株作物后，这里会记下它的名字。</p>"
    }</div>`;
}

function gardenGateMarkup(history) {
  return `<h3>历季园门</h3>${
    history.length
      ? `<ol class="garden-gate-history">${history
          .map(
            ({ season, day, display }) => `<li>
    <span>第 ${esc(season)} 季 · 第 ${esc(day)} 天</span>
    <strong>${esc(display?.name)}</strong>
  </li>`,
          )
          .join("")}</ol>`
      : "<p>园门还没有留下陈列记录。</p>"
  }`;
}

function gardenFacilitiesMarkup(state) {
  return `<h3>园角设施</h3>
    ${state.tomorrowForecast?.hint ? `<p class="garden-forecast">${esc(state.tomorrowForecast.hint)}</p>` : ""}
    <div class="garden-shelf">${state.facilities
      .map(
        (facility) => `<article class="garden-good">
      <h4>${esc(facility.name)}</h4><p>${esc(facility.description)}</p>
      ${
        facility.built
          ? `<p>已建成 · 第 ${esc(facility.builtDay)} 天</p>`
          : `<button type="button" class="ghost" data-garden-act="build_facility" data-facility="${esc(facility.id)}"${state.pauseReason || facility.price > state.balance ? " disabled" : ""}>建造 · ${gardenMoney(facility.price)}</button>
        ${facility.price > state.balance ? "<p>公共金币不足。</p>" : ""}`
      }
    </article>`,
      )
      .join("")}</div>`;
}

function actionFromGift(form, state) {
  const kind = form.dataset.gardenForm;
  const fields = new FormData(form);
  const recipient = () => {
    const { kind, id } = state.roles[Number(fields.get("recipient"))];
    return { kind, id };
  };
  const note = String(fields.get("note") || "").trim();
  if (kind === "buy_gift") {
    const { giftId, price } =
      state.event.giftOffers[Number(form.dataset.offer)];
    return {
      kind,
      eventId: state.event.id,
      giftId,
      price,
      ...(fields.get("delivery") === "send"
        ? { recipient: recipient(), ...(note ? { note } : {}) }
        : {}),
    };
  }
  if (kind === "craft_gift") {
    const recipeId = form.closest("[data-garden-recipe]").dataset.gardenRecipe;
    const { price } = state.craftRecipes.find(({ id }) => id === recipeId);
    return {
      kind,
      recipeId,
      price,
      harvestIds: fields.getAll("harvestId"),
      ...(fields.get("delivery") === "send"
        ? { recipient: recipient(), ...(note ? { note } : {}) }
        : {}),
    };
  }
  const { item: itemId } = form.closest("[data-item]").dataset;
  if (kind === "send_gift")
    return { kind, itemId, recipient: recipient(), ...(note ? { note } : {}) };
  if (kind === "display_gift")
    return {
      kind,
      itemId,
      slot: Number(fields.get("slot")),
      description: String(fields.get("description")).trim(),
      publishNote: fields.has("publishNote"),
    };
  return { kind, itemId };
}

export function gardenReceipt(state, action, receipt) {
  const result = receipt ?? {};
  if (action.kind === "set_board_note")
    return action.text ? "留言已保存。" : "留言已清除。";
  if (action.kind === "choose_event")
    return (
      result.outcome?.detail ||
      result.detail ||
      (state.event?.id === action.eventId && state.event.outcome?.detail) ||
      "选择已记录。"
    );
  if (action.kind === "pop_seed_pod")
    return result.seedBag
      ? "弹籽荚响了一声，种子袋已收入公共仓库。"
      : result.surprise?.title || result.detail || "弹籽荚响了一声。";
  if (action.kind === "harvest" && result.peasPerPod && result.podCount)
    return `收成完成 · ${result.podCount} 个豆荚，共 ${result.quantity} 粒豌豆；每荚 ${result.peasPerPod} 粒。`;
  if (action.kind === "harvest" && result.surprise)
    return `收成完成 · ${result.surprise.title}`;
  const name = (kind, id) =>
    state.roles.find((role) => role.kind === kind && role.id === id)?.name;
  if (action.kind === "gift") {
    const crop = (state.settings?.crops ?? state.crops)?.[result.cropId];
    return `已将 ${result.quantity} 份${crop?.name || result.cropId}送给${name(action.recipient.kind, action.recipient.id) || action.recipient.id}。`;
  }
  if (action.kind === "build_facility")
    return `${state.facilities?.find(({ id }) => id === action.facilityId)?.name || "设施"}已建成，支出 ${gardenMoney(action.price)}。`;
  if (action.kind === "craft_gift") {
    const item =
      state.craftRecipes?.find(({ id }) => id === action.recipeId)?.name ||
      "手作礼物";
    const recipient =
      action.recipient && name(action.recipient.kind, action.recipient.id);
    return `${item}${recipient ? "已送给" + recipient : "已收入我的物品栏"}，工本费 ${gardenMoney(action.price)}。`;
  }
  if (action.kind === "buy_gift" || action.kind === "send_gift") {
    const item =
      result.name ||
      state.event?.giftOffers?.find(({ giftId }) => giftId === action.giftId)
        ?.name ||
      "礼物";
    const recipient =
      action.recipient && name(action.recipient.kind, action.recipient.id);
    return `${item}${recipient ? "已送给" + recipient : "已收入我的物品栏"}${action.kind === "buy_gift" ? "，支出 " + gardenMoney(action.price) : ""}。`;
  }
  if (
    action.kind === "merchant_buy" ||
    action.kind === "merchant_buy_fertilizer"
  )
    return `${gardenActions[action.kind]}完成，支出 ${gardenMoney(action.price)}。`;
  if (action.kind === "merchant_sell")
    return `出售完成，收入 ${gardenMoney(action.price)}。`;
  if (action.kind === "buy_mystery_seed")
    return `支出 ${gardenMoney(action.price)}，未拆封种子袋已入库。`;
  if (action.kind === "plant_mystery_seed")
    return `盲盒揭晓 · 第 ${action.plot} 块已种下${state.plots.find(({ id }) => id === action.plot)?.plant?.crop.name || "种子"}。`;
  if (action.kind === "resolve_event" && typeof result.delta === "number")
    return `事件已处理${result.delta ? `，${result.delta > 0 ? "收入" : "支出"} ${gardenMoney(Math.abs(result.delta))}` : ""}。`;
  return (gardenActions[action.kind] || "花园操作") + "完成";
}

function gardenTodo(state) {
  return `<section class="garden-todo"><h3>今天可做</h3>
    ${state.priorities.length ? `<ul class="garden-priorities">${state.priorities.map((item) => `<li><button type="button" data-garden-jump="${item.plot}">${gardenPriorityText(item)} <span aria-hidden="true">查看 ↗</span></button></li>`).join("")}</ul>` : "<p>当前没有需要处理的地块。</p>"}</section>`;
}

export const gardenEventOperation = (action, state) =>
  (action.kind !== "choose_event" || action.eventId === state.event?.id) &&
  [
    "merchant_buy",
    "merchant_buy_fertilizer",
    "merchant_sell",
    "buy_gift",
    "chase_thief",
    "resolve_event",
    "choose_event",
    "buy_mystery_seed",
  ].includes(action.kind);

function sceneCaption(scene) {
  if (!scene || scene.period === "day") return "";
  const sky =
    scene.stars === "clear"
      ? "晴夜繁星"
      : scene.stars === "sparse"
        ? "云间疏星"
        : scene.period === "dusk"
          ? "暮色花圃"
          : "夜间花圃";
  const caption = [
    sky,
    scene.butterflies && "小蝴蝶停在猫薄荷上",
    scene.fireflies && "花间有萤点",
  ]
    .filter(Boolean)
    .join(" · ");
  return `<p class="garden-scene-caption">${caption}</p>`;
}

function gardenSceneDecor(scene) {
  if (!scene || scene.period === "day") return "";
  const stars = scene.stars === "clear" ? 6 : scene.stars === "sparse" ? 3 : 0;
  return `<div class="garden-night-scene" aria-hidden="true">
    ${'<i class="garden-scene-star"></i>'.repeat(stars)}
    ${scene.fireflies ? '<i class="garden-scene-firefly"></i><i class="garden-scene-firefly"></i>' : ""}
    ${scene.butterflies ? '<i class="garden-scene-butterfly"></i>' : ""}
  </div>`;
}

function gardenPollenMarkup(state) {
  return (state.pollenPairs ?? [])
    .map(
      ({ plots, hint }) => `
    <aside class="garden-pollen">
      <span class="garden-pollen-dust" aria-hidden="true"></span>
      <div><strong>${esc(hint ?? "蓝紫色花粉")}</strong><p>第 ${plots.map(esc).join("、")} 号地之间落了一点花粉。</p></div>
    </aside>`,
    )
    .join("");
}

function gardenCropGuide(state, guideOpen) {
  const regular = Object.entries(state.crops).filter(
    ([id, crop]) => id !== "catnip" && crop.enabled && crop.market,
  );
  const catnip = state.crops.catnip;
  const mistbell = state.crops.mistbell;
  if (!catnip || !mistbell) return "";
  const revealed =
    state.mistbellDiscovered ||
    state.seeds.mistbell > 0 ||
    state.plots.some(({ plant }) => plant?.cropId === "mistbell");
  return `<details class="garden-crop-guide" data-garden-crop-guide${guideOpen ? " open" : ""}>
    <summary>作物图鉴</summary>
    <div class="garden-crop-guide-pair">
      ${regular
        .map(
          ([id, crop]) => `<article class="garden-crop-guide-entry">
            ${productArt("crop", id)}
            <div><h4>${esc(crop.name)}</h4><p>${esc(crop.description)}</p></div>
          </article>`,
        )
        .join("")}
      <article class="garden-crop-guide-entry">
        ${productArt("crop", "catnip")}
        <div><h4>${esc(catnip.name)}</h4><p>${esc(catnip.description)}</p></div>
      </article>
      <article class="garden-crop-guide-entry" data-discovered="${Boolean(revealed)}">
        ${productArt("crop", "mistbell")}
        <div><h4>${revealed ? esc(mistbell.name) : "未知邻株种子"}</h4><p>${revealed ? esc(mistbell.description) : "留意相邻地块之间飘起的花粉。"}</p></div>
      </article>
    </div>
  </details>`;
}

function header(state) {
  const time = Math.floor((24 * 3600000 - state.dayRemaining) / 60000);
  const clock = [Math.floor(time / 60), time % 60]
    .map((n) => String(n).padStart(2, "0"))
    .join(":");
  const pause = state.pauseReason
    ? gardenLabels[state.pauseReason] || "花园已暂停"
    : "";
  const flora =
    state.nightScene?.period === "night"
      ? ["moonflower", ...(state.mistbellDiscovered ? ["mistbell"] : [])]
      : state.nightScene?.period === "dusk"
        ? ["moonflower", "catnip", "strawberry"]
        : ["moonflower", "sunflower", "strawberry", "mint"];
  const story = state.event?.effect?.story;
  const mood =
    story === "tea" && state.event.status === "resolved"
      ? "tea"
      : state.fullMoon
        ? "moon"
        : "";
  return `<header class="garden-workspace-head" data-period="${esc(state.nightScene?.period)}" data-garden-mood="${mood}">
    ${gardenSceneDecor(state.nightScene)}
    <div><h2>小窝花园</h2><p>第 ${state.day} 个花园日 · ${esc(state.weather.name)} · ${clock}${state.speed ? ` · ${state.speed}×` : ""}${pause ? " · " + pause : ""}</p>${sceneCaption(state.nightScene)}${mood ? `<p class="garden-scene-caption">${mood === "tea" ? "园中茶会正在进行" : "满月照着花圃"}</p>` : ""}</div>
    <div class="garden-cover-flora" aria-hidden="true">${flora.map((id) => productArt("crop", id)).join("")}</div>
    ${art.gardenBalanceMarkup(state.balance)}
  </header>`;
}

async function playGardenTaps(intervals, frequency = 480) {
  if (typeof AudioContext === "undefined") return;
  const audio = new AudioContext();
  try {
    await audio.resume();
    let at = audio.currentTime + 0.015;
    let last;
    for (const interval of intervals) {
      const tick = audio.createOscillator();
      const tone = audio.createGain();
      tick.type = "triangle";
      tick.frequency.setValueAtTime(frequency, at);
      tick.frequency.exponentialRampToValueAtTime(120, at + 0.035);
      tone.gain.setValueAtTime(0.075, at);
      tone.gain.exponentialRampToValueAtTime(0.001, at + 0.05);
      tick.connect(tone).connect(audio.destination);
      tick.start(at);
      tick.stop(at + 0.052);
      last = tick;
      at += interval;
    }
    if (last) last.onended = () => void audio.close();
    else await audio.close();
  } catch {
    await audio.close();
  }
}

export function bindGardenWorkspace(
  root,
  { act, records, settings, journal, onStatus, compact = false },
) {
  art.hideFailedGardenArt(root);
  const view = {
    tab: "board",
    lane: "buy",
    goods: "supplies",
    filter: "all",
    selected: 1,
    eventReceipt: "",
  };
  let state;
  const book =
    journal && bindGardenJournal(root, journal, esc, showTab, onStatus);
  function showTab(tab) {
    view.tab = tab;
    for (const nav of root.querySelectorAll("[data-garden-tab]")) {
      if (nav.closest(".garden-nav"))
        nav.setAttribute("aria-current", String(nav.dataset.gardenTab === tab));
    }
    for (const pane of root.querySelectorAll("[data-garden-pane]")) {
      pane.hidden =
        pane.dataset.gardenPane !== tab &&
        !(tab === "event" && pane.dataset.gardenPane === "board");
    }
    root.querySelector(".garden-workspace").dataset.active = tab;
  }
  function updateSection(group) {
    if (group === "filter")
      root.querySelector('[data-garden-pane="items"]').innerHTML =
        personalGiftMarkup(state, view);
    else
      root.querySelector("[data-garden-ticket]").innerHTML = gardenEventMarkup(
        state,
        view,
      );
    root
      .querySelector(
        `[data-garden-switch="${group}"][data-value="${view[group]}"]`,
      )
      ?.focus({ preventScroll: true });
  }
  function selectPlot(id, jump) {
    view.selected = id;
    const detail = root.querySelector("[data-garden-inspector]");
    detail.innerHTML = gardenPlotDetail(
      state,
      state.plots.find((plot) => plot.id === id),
    );
    for (const tile of root.querySelectorAll(".garden-map-tile"))
      tile.setAttribute(
        "aria-pressed",
        String(Number(tile.dataset.plot) === id),
      );
    if (jump) {
      showTab("board");
      root.querySelector(`[data-plot="${id}"]`)?.focus({ preventScroll: true });
      detail.scrollIntoView({ block: "nearest" });
    }
  }
  root.addEventListener("click", (event) => {
    const button = event.target.closest("button");
    if (!state || !button || button.matches(":disabled")) return;
    const { gardenTab, gardenSwitch, plot, gardenJump, withdraw } =
      button.dataset;
    if (button.hasAttribute("data-garden-history-card")) {
      const image = root.querySelector("[data-garden-history-image]");
      const query = state.event?.outcome?.plantCard?.imageRequest;
      if (journal && image && query)
        void showGardenCard(image, () => journal(query));
    } else if (button.hasAttribute("data-listen-pea")) {
      const cues = state.plots.find(({ id }) => id === view.selected)?.plant
        ?.explorer?.rattles;
      if (cues?.length) void playGardenTaps(cues.map(() => 0.23));
    } else if (gardenTab) {
      showTab(gardenTab);
      if (!button.closest(".garden-nav"))
        root
          .querySelector(`.garden-nav [data-garden-tab="${gardenTab}"]`)
          ?.focus();
    } else if (gardenSwitch) {
      view[gardenSwitch] = button.dataset.value;
      updateSection(gardenSwitch);
    } else if (plot || gardenJump) {
      selectPlot(Number(plot ?? gardenJump), Boolean(gardenJump));
    } else if (withdraw) {
      act({ kind: "withdraw_gift", slot: Number(withdraw) });
    } else if (button.dataset.gardenAct) {
      const action = gardenActionFrom(button, state);
      if (action) {
        if (action.kind === "choose_event" && action.choiceId === "rain-drum")
          void playGardenTaps([0.26, 0.15, 0.34, 0.16, 0.3], 240);
        act(action);
      }
    }
  });
  root.addEventListener("input", ({ target }) => {
    if (target.matches("[data-stock-search]")) {
      const query = target.value.trim().toLocaleLowerCase("zh-CN");
      for (const entry of root.querySelectorAll("[data-search-stock]"))
        entry.hidden = !entry.textContent
          .toLocaleLowerCase("zh-CN")
          .includes(query);
    } else if (target.matches("[data-garden-sale-count]")) {
      const stock = target.closest("[data-harvest]");
      const lot = state.market.find(
        (item) => item.id === stock.dataset.harvest,
      );
      stock.querySelector("[data-sale-total]").value =
        target.validity.valid && target.value
          ? gardenMoney(Math.round(lot.saleRate * target.valueAsNumber))
          : "—";
    }
  });
  root.addEventListener("change", ({ target }) => {
    if (target.matches('[data-harvest] select[name="recipient"]')) {
      target
        .closest("[data-harvest]")
        .querySelector('[data-garden-act="gift"]').disabled = !target.value;
      return;
    }
    const form = target.form;
    if (target.matches("[data-garden-photo-day]")) {
      view.photoDay = Number(target.value);
      const ticket = root.querySelector("[data-garden-ticket]");
      ticket.innerHTML = gardenEventMarkup(state, view);
      ticket
        .querySelector("[data-garden-photo-day]")
        ?.focus({ preventScroll: true });
      return;
    }
    if (target.matches("[data-update-choice-label]")) {
      const option = gardenChoiceEntry(state, form, target.value);
      if (option)
        form.querySelector('button[type="submit"]').textContent = option.label;
      return;
    }
    if (target.matches("[data-craft-ingredient]")) {
      const selects = [...form.querySelectorAll("[data-craft-ingredient]")];
      for (const select of selects) {
        const chosen = selects.find((other) => other !== select)
          ?.selectedOptions[0]?.dataset.crop;
        for (const option of select.options)
          option.disabled = Boolean(chosen && option.dataset.crop === chosen);
      }
      return;
    }
    if (!["buy_gift", "craft_gift"].includes(form?.dataset.gardenForm)) return;
    const sending = form.elements.delivery.value === "send";
    const fields = form.querySelector("[data-gift-delivery]");
    fields.hidden = fields.disabled = !sending;
    if (form.dataset.gardenForm === "craft_gift") return;
    const { price } = state.event.giftOffers[Number(form.dataset.offer)];
    const choice = form.elements.recipient.value;
    const recipient = sending
      ? choice
        ? `送给${state.roles[Number(choice)].name}`
        : "请选择收件人"
      : "收进我的物品栏";
    form.querySelector("[data-gift-confirmation]").textContent =
      `用公共金币 ${gardenMoney(price)}，${recipient}。`;
  });
  root.addEventListener("submit", (event) => {
    const form = event.target;
    if (form.matches("[data-garden-choice]")) {
      event.preventDefault();
      const action = gardenChoiceAction(
        state,
        form,
        form.elements.choice.value,
      );
      if (
        action?.text !== undefined &&
        (!action.text || [...action.text].length > 120)
      ) {
        onStatus?.("请填写 1 到 120 个字。");
        return;
      }
      if (action) act(action);
      return;
    }
    const note = form.dataset.gardenNote;
    if (note !== undefined) {
      event.preventDefault();
      const text =
        event.submitter?.value === "clear"
          ? ""
          : form.elements.text.value.trim();
      if ([...text].length > 120) {
        onStatus?.(gardenLabels.GARDEN_NOTE_TOO_LONG);
        return;
      }
      act({
        kind: "set_board_note",
        scope: note === "garden" ? "garden" : "plot",
        ...(note === "garden" ? {} : { plot: Number(note) }),
        text,
      });
      return;
    }
    if (!form.dataset.gardenForm) return;
    event.preventDefault();
    event.stopPropagation();
    act(actionFromGift(event.target, state));
  });
  return {
    draw(garden, receipt) {
      const guideOpen = root.querySelector("[data-garden-crop-guide]")?.open;
      state = {
        ...garden,
        crops: garden.settings?.crops ?? garden.crops,
        fertilizerPrice:
          garden.settings?.fertilizerPrice ?? garden.fertilizerPrice,
        speed: garden.settings?.speed ?? garden.speed,
      };
      view.eventReceipt = receipt || "";
      if (!state.plots.some(({ id }) => id === view.selected))
        view.selected = state.plots[0].id;
      const tabs = [
        ["board", "花圃"],
        ["event", "今日事件"],
        ["warehouse", "公共仓库"],
        ...(state.craftRecipes ? [["craft", "手作台"]] : []),
        ["items", "我的物品"],
        ...(state.communityShelves ? [["community", "串门"]] : []),
        ...(state.almanac ? [["almanac", "植物图鉴"]] : []),
        ...(state.facilities ? [["facilities", "园角设施"]] : []),
        ...(state.gateHistory ? [["gate", "历季园门"]] : []),
        ...(records ? [["records", "花园记录"]] : []),
        ...(settings ? [["settings", "花园设置"]] : []),
      ];
      root.innerHTML = `<section class="garden-paper garden-workspace${compact ? " garden-compact" : " garden-console-paper"}">
        ${header(state)}
        <div class="garden-nav" role="navigation" aria-label="花园导航">${tabs.map(([id, label]) => `<button type="button" data-garden-tab="${id}">${label}</button>`).join("")}</div>
        <div class="garden-view">
          <div class="garden-workspace-body" data-garden-pane="board">
            <section class="garden-board">
              ${gardenNoteMarkup(state)}
              <div class="garden-digest" data-journal-note hidden></div>
              ${gardenPollenMarkup(state)}
              ${state.echoScent ? `<p class="garden-forecast">${esc(state.echoScent.text)} <button type="button" class="ghost" data-garden-jump="${esc(state.echoScent.plot)}">看第 ${esc(state.echoScent.plot)} 块地</button></p>` : ""}
              ${gardenFollowups(state)}
              ${gardenProjects(state)}
              ${state.tomorrowForecast?.hint ? `<p class="garden-forecast">${esc(state.tomorrowForecast.hint)}</p>` : ""}
              ${state.almanacSummary ? `<button type="button" class="ghost" data-garden-tab="almanac">图鉴已点亮 ${esc(state.almanacSummary.unlocked)} / ${esc(state.almanacSummary.total)} 种</button>${gardenAlmanacRecent(state.almanacSummary.newlyUnlocked)}` : ""}
              ${state.event ? `<button type="button" class="garden-event-shortcut" data-garden-tab="event">${art.gardenIconMarkup("event", art.gardenEventArtId(state.event))}<span>${esc(state.event.name)}</span><b>${state.event.kind === "merchant" ? "逛小摊 ↗" : "查看 ↗"}</b></button>` : ""}
              <div class="garden-board-title"><h3>共享花圃</h3><small>已种植 ${state.plots.filter(({ plant }) => plant).length} / ${state.plots.length} 块</small></div>
              <div class="garden-grid garden-map">${state.plots.map((entry) => gardenPlotMarkup(entry, view.selected, gardenBird(state))).join("")}</div>
              <div data-garden-inspector></div>
            </section>
            <section class="garden-rail" aria-label="今日事件与待办"><div data-garden-ticket>${gardenEventMarkup(state, view)}</div>${gardenTodo(state)}</section>
          </div>
          <div data-garden-pane="warehouse">${gardenWarehouse(state, guideOpen)}</div>
          ${state.craftRecipes ? `<div data-garden-pane="craft">${gardenCraftMarkup(state)}</div>` : ""}
          <div data-garden-pane="items">${personalGiftMarkup(state, view)}</div>
          ${state.communityShelves ? `<div data-garden-pane="community">${communityGiftMarkup(state.communityShelves)}</div>` : ""}
          ${state.almanac ? `<div data-garden-pane="almanac">${gardenAlmanacMarkup(state.almanac)}</div>` : ""}
          ${state.facilities ? `<div data-garden-pane="facilities">${gardenFacilitiesMarkup(state)}</div>` : ""}
          ${state.gateHistory ? `<div data-garden-pane="gate">${gardenGateMarkup(state.gateHistory)}</div>` : ""}
          ${records ? `<div data-garden-pane="records"><div class="garden-journal" data-journal-body></div><h3>花园记录</h3>${records(state)}</div>` : ""}
          ${settings ? `<div data-garden-pane="settings">${settings(state)}</div>` : ""}
        </div>
      </section>`;
      selectPlot(view.selected, false);
      showTab(view.tab);
      book?.draw(state, view.tab);
    },
    clear() {
      book?.clear();
      state = undefined;
      Object.assign(view, {
        tab: "board",
        lane: "buy",
        goods: "supplies",
        filter: "all",
        selected: 1,
        eventReceipt: "",
      });
      root.replaceChildren();
      onStatus?.("");
    },
  };
}

const gardenAt = (value) => new Date(value).toLocaleString("zh-CN");
const gardenActorName = (state, kind, id) =>
  state.roles.find((row) => row.kind === kind && row.id === id)?.name ||
  (id === "system" ? "系统" : id);
function gardenLogRows(entries, format, empty) {
  return entries.length
    ? entries.map((entry) => `<p class="record">${format(entry)}</p>`).join("")
    : `<p class="hint">${empty}</p>`;
}

export function gardenRecordsMarkup(
  state,
  fold = (id, title, body) =>
    `<details class="garden-record"><summary id="${id}">${title}</summary>${body}</details>`,
) {
  return `    ${fold(
    "garden-event-history",
    "每日事件记录",
    gardenLogRows(
      state.eventHistory ?? [],
      (entry) => {
        const status = {
          open: "进行中",
          expired: "已结束",
          chased: "已驱赶",
          missed: "未驱赶",
          claimed: "已领取",
          resolved: "已处理",
          applied: "已生效",
        }[entry.status];
        const result = entry.outcome;
        let outcome = "";
        if (result?.label)
          outcome = ` · ${esc(result.label)}${result.detail ? ` · ${esc(result.detail)}` : ""}`;
        else if (result?.detail) outcome = ` · ${esc(result.detail)}`;
        else if (result?.coins !== undefined)
          outcome = ` · 损失 ${gardenMoney(result.coins)}`;
        else if (result?.quantity && entry.kind === "thief")
          outcome = ` · 损失 ${result.quantity} 份${esc(gardenCropName(state, result.cropId))}`;
        else if (result?.quantity && entry.kind === "harvest_bonus")
          outcome = ` · 收成 ${result.quantity} 份`;
        else if (result?.reward)
          outcome = ` · 收入 ${gardenMoney(result.reward)}`;
        else if (result?.cost) outcome = ` · 支出 ${gardenMoney(result.cost)}`;
        return `第 ${entry.day} 天 · ${esc(entry.name)} · ${status || "已记录"}${outcome}`;
      },
      "还没有事件。",
    ),
    { summary: "最近 14 条" },
  )}
    ${fold(
      "garden-activity",
      "经营活动",
      gardenLogRows(
        state.activity ?? [],
        (row) =>
          `${esc(gardenAt(row.at))} · ${esc(gardenActorName(state, row.actor_kind, row.actor_id))} · ${gardenActions[row.action] || row.action}${row.result?.plot ? " · 第 " + row.result?.plot + " 块" : ""}${row.result?.eventId ? " · " + esc(row.result?.eventId) : ""}${row.result?.price !== undefined ? " · " + gardenMoney(row.result?.price) : ""}`,
        "还没有经营活动。",
      ),
      { summary: "最近操作" },
    )}
    ${fold(
      "garden-ledger",
      "公共账本",
      gardenLogRows(
        state.ledger ?? [],
        (row) =>
          `${esc(gardenAt(row.at))} · ${esc(gardenActorName(state, row.actor_kind, row.actor_id))} · ${gardenActions[row.action] || row.action} · ${row.delta > 0 ? "+" : ""}${gardenMoney(row.delta)} · 余额 ${gardenMoney(row.balance)}`,
        "还没有账目。",
      ),
      { summary: "最近资金变动" },
    )}
    ${fold(
      "garden-gifts",
      "赠礼记录",
      gardenLogRows(
        state.gifts ?? [],
        (row) =>
          `${esc(gardenAt(row.at))} · ${esc(gardenActorName(state, row.giver_kind, row.giver_id))} 送给 ${esc(gardenActorName(state, row.recipient_kind, row.recipient_id))} · ${esc(gardenCropName(state, row.crop_id))} × ${row.quantity}`,
        "还没有赠礼。",
      ),
      { summary: "最近赠礼" },
    )}
`;
}
