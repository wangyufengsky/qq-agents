/* global window */
import { element, button } from "./renderer-shared.js";

const verbs = {
  plant: "播种",
  water: "浇水",
  fertilize: "施肥",
  harvest: "收成",
  clear: "铲除枯株",
  buy_seed: "买种子",
  buy_fertilizer: "买肥料",
  sell: "出售",
  gift: "赠礼",
};
const priorityLabels = {
  drought: "缺水严重",
  water: "缺水",
  low_water_forecast: "预计缺水",
  harvest: "可收成",
  clear: "可清理枯株",
};
const errors = {
  GARDEN_PAUSED: "花园时钟已暂停",
  GARDEN_PRICE_CHANGED: "价格已变化，请刷新花园",
  GARDEN_PLANT_CHANGED: "植株已变化，请刷新花园",
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
  const message = panel.querySelector(".garden-message");
  const refresh = panel.querySelector(".garden-refresh");
  let pending,
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
    content.append(
      element(
        "p",
        "",
        "第 " +
          garden.day +
          " 天 · 公共余额 " +
          garden.balance +
          " 元" +
          (paused ? " · 已暂停" : ""),
      ),
    );
    const grid = element("div", "desktop-garden-grid");
    const plantable = Object.entries(garden.crops).filter(
      ([id, crop]) => crop.enabled && (crop.market || garden.seeds[id] > 0),
    );
    for (const { id, plant } of garden.plots) {
      const tile = element("article", "desktop-garden-tile");
      tile.dataset.plot = id;
      tile.append(element("strong", "", "第 " + id + " 块"));
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
          element("p", "", "空地"),
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
        tile.append(element("p", "", plant.crop.name));
        const target = () => ({ plot: id, plantId: plant.id });
        if (plant.status === "mature")
          tile.append(
            element("p", "", "已成熟"),
            control("harvest", target, paused),
          );
        else if (plant.status === "withered")
          tile.append(
            element("p", "", "已枯萎"),
            control("clear", target, paused),
          );
        else {
          tile.append(
            element(
              "p",
              "",
              "成长 " +
                Math.floor((plant.growth / plant.crop.hours) * 100) +
                "% · 水分 " +
                Math.floor(plant.water),
            ),
            control("water", target, paused || plant.water === 100),
          );
          if (plant.fertilizer < plant.crop.fertilizer && garden.fertilizer > 0)
            tile.append(control("fertilize", target, paused));
        }
      }
      grid.append(tile);
    }
    content.append(grid);
    if (garden.priorities.length) {
      const priorities = element("ul");
      for (const item of garden.priorities)
        priorities.append(
          element(
            "li",
            "",
            "第 " + item.plot + " 块 · " + priorityLabels[item.kind],
          ),
        );
      content.append(priorities);
    }
    content.append(
      element("h3", "", "公共仓库"),
      element(
        "p",
        "",
        "肥料 " +
          garden.fertilizer +
          " 包 · " +
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
      message.textContent = "";
      content.replaceChildren();
    },
  };
}
