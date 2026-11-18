/* global window */
import {
  gardenArtMarkup,
  gardenBalanceMarkup,
  gardenIconMarkup,
  gardenLayers,
  gardenPlotStatus,
  hideFailedGardenArt,
} from "../../public/garden-art/art.js";
import { element, button } from "./renderer-shared.js";

const verbs = {
  plant: "播种",
  water: "浇水",
  fertilize: "施肥",
  harvest: "收成",
  clear: "铲除枯株",
  shelter: "搭棚",
  unshelter: "撤棚",
  merchant_buy: "购买商人种子",
  merchant_sell: "卖给商人",
  chase_thief: "驱赶小偷",
  buy_seed: "买种子",
  buy_fertilizer: "买肥料",
  sell: "出售",
  gift: "赠礼",
};
const priorityLabels = {
  drought: "缺水严重",
  water: "缺水",
  low_water_forecast: "预计缺水",
  flood: "暴雨积水",
  harvest: "可收成",
  clear: "可清理枯株",
};
const errors = {
  GARDEN_PAUSED: "花园时钟已暂停",
  GARDEN_PRICE_CHANGED: "价格已变化，请刷新花园",
  GARDEN_PLANT_CHANGED: "植株已变化，请刷新花园",
  GARDEN_EVENT_EXPIRED: "当天事件已过期，请刷新花园",
  GARDEN_EVENT_HANDLED: "已有成员处理此事件，请刷新花园",
  GARDEN_EVENT_OFFER: "报价已不可用，请刷新花园",
  GARDEN_SHELTER_UNCHANGED: "棚状态已有变化，请刷新花园",
  GARDEN_PLOT_OCCUPIED: "地块已被占用，请刷新花园",
  GARDEN_STOCK_UNAVAILABLE: "库存已变化，请刷新花园",
  GARDEN_BALANCE_LOW: "公共余额不足",
  GARDEN_RECIPIENT_UNAVAILABLE: "受赠角色已不可用",
};
function picker(label, items) {
  const node = element("select");
  node.setAttribute("aria-label", label);
  for (const [value, text] of items) {
    const option = element("option", "", text);
    option.value = value;
    node.append(option);
  }
  return node;
}

export function bindGarden(panel, getRoom) {
  const content = panel.querySelector(".garden-content");
  hideFailedGardenArt(content);
  content.classList.add("garden-paper", "garden-workspace");
  const message = panel.querySelector(".garden-message");
  const refresh = panel.querySelector(".garden-refresh");
  let pending,
    selected = 1,
    busy = false;
  async function request(action) {
    if (busy) return;
    const room = getRoom();
    if (!room?.connected || !room.roomEpoch) return;
    const key = action && JSON.stringify(action);
    if (key && pending?.key !== key)
      pending = { key, requestId: window.crypto.randomUUID() };
    busy = true;
    message.textContent = "正在读取花园…";
    try {
      const response = await window.nest.garden(
        room.roomEpoch,
        action ? { requestId: pending.requestId, action } : undefined,
      );
      if (panel.hidden || getRoom()?.roomEpoch !== room.roomEpoch) return;
      if (!response?.garden) {
        if (response?.error) pending = undefined;
        message.textContent =
          errors[response?.error] || "花园操作暂不可用，请刷新后查看。";
        return;
      }
      if (action) pending = undefined;
      message.textContent = action ? verbs[action.kind] + "完成" : "";
      draw(response.garden);
    } catch {
      if (getRoom()?.roomEpoch === room.roomEpoch)
        message.textContent = "暂时连不上花园，请刷新后查看。";
    } finally {
      busy = false;
    }
  }

  function control(kind, args, disabled) {
    const node = button("quiet", verbs[kind]);
    node.disabled = disabled;
    node.onclick = () => void request({ kind, ...args() });
    return node;
  }

  function draw(garden) {
    content.replaceChildren();
    if (!garden.initialized) {
      content.append(element("p", "", "花园尚未开园，可在管理台创建。"));
      return;
    }
    const paused = Boolean(garden.pauseReason);
    const head = element("header", "garden-workspace-head");
    head.append(element("h2", "", "小窝花园"));
    head.insertAdjacentHTML("beforeend", gardenBalanceMarkup(garden.balance));
    const meta = element("div", "garden-workspace-meta");
    const weather = element("span", "", garden.weather.name);
    weather.insertAdjacentHTML(
      "afterbegin",
      gardenIconMarkup("weather", garden.weather.kind),
    );
    meta.append(
      weather,
      element(
        "span",
        "",
        "第 " +
          garden.day +
          " 天 · 本日剩 " +
          Math.ceil(garden.dayRemaining / 360_000) / 10 +
          " 花园小时" +
          (paused ? " · 已暂停" : ""),
      ),
    );
    content.append(head, meta);
    const workspace = element("div", "garden-workspace-body");
    const board = element("section");
    const title = element("div", "garden-board-title");
    title.append(
      element("h3", "", "共享花圃"),
      element(
        "small",
        "",
        "已种植 " +
          garden.plots.filter(({ plant }) => plant).length +
          " / " +
          garden.plots.length,
      ),
    );
    const rail = element("section", "garden-rail");
    rail.setAttribute("aria-label", "地块详情与待办");
    const detail = element("div");
    rail.append(detail);
    const grid = element("div", "desktop-garden-grid garden-map");
    board.append(title, grid);
    workspace.append(board, rail);
    content.append(workspace);
    const plantable = Object.entries(garden.crops).filter(
      ([id, crop]) => crop.enabled && (crop.market || garden.seeds[id] > 0),
    );
    function selectPlot(id) {
      selected = id;
      const { plant, sheltered } = garden.plots.find((plot) => plot.id === id);
      for (const cell of grid.children)
        cell.setAttribute(
          "aria-pressed",
          String(Number(cell.dataset.plot) === selected),
        );
      const tile = element("article", "garden-inspector");
      tile.dataset.gardenDetail = id;
      tile.append(
        element("small", "", "第 " + id + " 块地"),
        element("h3", "", plant?.crop.name || "空地"),
        element("p", "", sheltered ? "有棚" : "露天"),
      );
      if (!plant) {
        const seeds = picker(
          "第 " + id + " 块作物",
          plantable.map(([key, crop]) => [
            key,
            crop.name +
              (garden.seeds[key] > 0
                ? " · 用库存"
                : " · " + crop.seedPrice + " 元"),
          ]),
        );
        seeds.disabled = paused;
        tile.append(
          seeds,
          control(
            "plant",
            () => ({
              plot: id,
              cropId: seeds.value,
              ...(garden.seeds[seeds.value] > 0
                ? {}
                : { buyPrice: garden.crops[seeds.value].seedPrice }),
            }),
            paused || !plantable.length,
          ),
        );
      } else {
        const target = () => ({ plot: id, plantId: plant.id });
        if (plant.status === "mature")
          tile.append(
            element(
              "p",
              "",
              "已成熟" +
                (plant.quality
                  ? " · " +
                    ({ ordinary: "普通", fine: "优良", perfect: "完美" }[
                      plant.quality
                    ] || "")
                  : ""),
            ),
            control("harvest", target, paused),
          );
        else if (plant.status === "withered")
          tile.append(
            element(
              "p",
              "",
              plant.witheredReason === "flood"
                ? "已枯萎 · 连续暴雨积水"
                : "已枯萎 · 长期缺水",
            ),
            control("clear", target, paused),
          );
        else {
          const progress = Math.floor((plant.growth / plant.crop.hours) * 100);
          const growing = element("div", "garden-growth");
          for (const [name, value, suffix, dry] of [
            ["成长", progress, "%", false],
            [
              "水分",
              Math.floor(plant.water),
              " / 100",
              plant.water < plant.rules.lowWater,
            ],
          ]) {
            const label = element("label", "", name);
            label.append(
              element(
                "span",
                dry ? "garden-dry" : "",
                value + suffix + (dry ? " · 缺水" : ""),
              ),
            );
            const meter = element("progress", dry ? "garden-dry" : "");
            meter.max = 100;
            meter.value = value;
            label.append(meter);
            growing.append(label);
          }
          const water = control("water", target, paused || plant.water === 100);
          water.classList.add("garden-main-action");
          tile.append(
            element("p", "", progress < 25 ? "幼苗" : "生长中"),
            growing,
            water,
          );
          if (
            plant.fertilizer < plant.crop.fertilizer &&
            (garden.fertilizer > 0 || garden.fertilizerCredits > 0)
          )
            tile.append(control("fertilize", target, paused));
        }
      }
      tile.append(
        control(
          sheltered ? "unshelter" : "shelter",
          () => ({ plot: id }),
          paused,
        ),
      );
      detail.replaceChildren(tile);
    }
    for (const { id, plant, sheltered } of garden.plots) {
      const cell = button("desktop-garden-tile garden-map-tile", "");
      cell.dataset.plot = id;
      const status = gardenPlotStatus(plant);
      const header = element("span", "garden-tile-top");
      header.append(
        element("span", "", String(id).padStart(2, "0")),
        element("span", status === "缺水" ? "garden-dry" : "", status),
      );
      cell.append(header);
      cell.insertAdjacentHTML(
        "beforeend",
        gardenArtMarkup(gardenLayers({ plant, sheltered })),
      );
      cell.append(element("strong", "", plant?.crop.name || "空地"));
      cell.onclick = () => selectPlot(id);
      grid.append(cell);
    }
    selectPlot(selected);
    if (garden.priorities.length) {
      const priorities = element("ul", "garden-priorities");
      rail.append(element("h3", "", "今天可做"));
      for (const item of garden.priorities) {
        const row = element("li");
        const jump = button(
          "",
          "第 " +
            item.plot +
            " 块 · " +
            priorityLabels[item.kind] +
            (item.kind === "flood"
              ? ` · 本日剩 ${Math.ceil(item.hours * 10) / 10} 花园小时 · ${item.risk === "critical" ? "日结束前搭棚，否则枯萎" : "建议搭棚"}`
              : ""),
        );
        jump.onclick = () => {
          selectPlot(item.plot);
          detail.scrollIntoView({ block: "nearest" });
        };
        row.append(jump);
        priorities.append(row);
      }
      rail.append(priorities);
    }
    if (garden.event) {
      const title = element("h3", "", garden.event.name);
      title.insertAdjacentHTML(
        "afterbegin",
        gardenIconMarkup("event", garden.event.kind),
      );
      rail.append(title);
      const status = { claimed: "奖励已入公共仓库", chased: "小偷已被驱赶" }[
        garden.event.status
      ];
      if (status) rail.append(element("p", "", status));
      for (const { kind, args, label } of garden.eventActions) {
        const action = control(kind, () => args, paused);
        action.textContent = label;
        rail.append(action);
      }
    }
    content.append(
      element("h3", "", "公共仓库"),
      element(
        "p",
        "",
        "肥料 " +
          garden.fertilizer +
          " 包 · " +
          (garden.fertilizerCredits
            ? `免费施肥 ${garden.fertilizerCredits} 次 · `
            : "") +
          (Object.entries(garden.seeds)
            .filter(([, count]) => count > 0)
            .map(([id, count]) => garden.crops[id].name + " " + count + " 颗")
            .join(" · ") || "种子库存为空"),
      ),
    );
    const market = Object.entries(garden.crops).filter(
      ([, crop]) => crop.market && crop.enabled,
    );
    const choose = picker(
      "买种子",
      market.map(([id, crop]) => [
        id,
        crop.name + " · " + crop.seedPrice + " 元",
      ]),
    );
    choose.disabled = paused;
    content.append(
      choose,
      control(
        "buy_seed",
        () => ({
          cropId: choose.value,
          quantity: 1,
          price: garden.crops[choose.value].seedPrice,
        }),
        paused || !market.length,
      ),
      control(
        "buy_fertilizer",
        () => ({ quantity: 1, price: garden.fertilizerPrice }),
        paused,
      ),
    );
    for (const lot of garden.market) {
      const row = element("article", "desktop-garden-stock");
      const recipient = picker(
        "送给",
        garden.roles.map((role, index) => [index, role.name]),
      );
      recipient.disabled = paused;
      row.append(
        element(
          "p",
          "",
          garden.crops[lot.cropId].name + " · " + lot.quantity + " 份",
        ),
        control(
          "sell",
          () => ({
            harvestId: lot.id,
            quantity: 1,
            price: Math.round(lot.saleRate),
          }),
          paused,
        ),
        recipient,
        control(
          "gift",
          () => {
            const { kind, id } = garden.roles[Number(recipient.value)];
            return { harvestId: lot.id, quantity: 1, recipient: { kind, id } };
          },
          paused,
        ),
      );
      content.append(row);
    }
  }
  refresh.onclick = () => void request();
  return {
    refresh: () => void request(),
    clear: () => {
      pending = undefined;
      selected = 1;
      message.textContent = "";
      content.replaceChildren();
    },
  };
}
