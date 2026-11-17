const gardenActions = {
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
  sell: "出售",
  gift: "赠礼",
};
const gardenQuality = { ordinary: "普通", fine: "优良", perfect: "完美" };
const gardenLabels = {
  GLOBAL_PAUSED: "AI 全局暂停",
  ISOLATED_MODE: "框架处于隔离模式",
  UPDATE_IN_PROGRESS: "框架正在维护",
  GARDEN_DISABLED: "花园已暂停",
  DESKTOP_NOT_CONNECTED: "等待桌面小窝连接",
  GARDEN_PAUSED: "花园时钟已暂停",
  GARDEN_SETTINGS_CONFLICT: "设置已被更新。请先刷新，再核对你的修改。",
  GARDEN_PRICE_CHANGED: "价格已变化，请刷新后重试。",
  GARDEN_STOCK_UNAVAILABLE: "库存已有变化，请刷新后查看。",
  GARDEN_PLANT_CHANGED: "地块中的作物已变化，请刷新后查看。",
  GARDEN_SHELTER_UNCHANGED: "棚状态已有变化，请刷新后查看。",
  GARDEN_PLOT_OCCUPIED: "这块地已有作物，请刷新后查看。",
  GARDEN_BALANCE_LOW: "公共账户余额不足。",
  GARDEN_WATER_FULL: "这株作物的水分已满。",
  GARDEN_FERTILIZER_FULL: "这株作物已施足肥料。",
  GARDEN_PLANT_STATE: "当前作物状态无法执行此操作。",
  GARDEN_RECIPIENT_UNAVAILABLE: "受赠对象已不可用。",
  GARDEN_ROLE_UNAVAILABLE: "角色名单已有变化，请刷新后核对授权。",
};
const gardenFields = [
  ["speed", "全园速度倍率", 0.125, 16, "any"],
  ["turnLimit", "主人格每轮操作次数", 0, 100, 1],
  ["delegationHours", "浇水委托有效期（花园小时）", 1, 168, "any"],
  ["fertilizerPrice", "肥料单价", 0, 1000000, 1],
  ["startingWater", "播种时水分", 1, 100, "any"],
  ["watering", "单次浇水加水", 1, 100, "any"],
  ["lowWater", "缺水阈值", 1, 100, "any"],
  ["dryHours", "缺水枯萎时长（花园小时）", 1, 8760, "any"],
  ["dryQualityLoss", "每 24 花园小时缺水扣分", 0, 100, "any"],
  ["baseQuality", "基础品质分", 0, 100, "any"],
  ["fertilizerBonus", "施足肥料的品质加分", 0, 100, "any"],
  ["fineQuality", "优良最低分", 0, 100, "any"],
  ["perfectQuality", "完美最低分", 0, 100, "any"],
  ["fineMultiplier", "优良售价倍率", 1, 10, "any"],
  ["perfectMultiplier", "完美售价倍率", 1, 10, "any"],
];
const gardenCropFields = [
  ["seedPrice", "种子单价", 0, 1000000, 1],
  ["hours", "基础成熟时长（花园小时）", 0.01, 8760, "any"],
  ["dailyWater", "每花园日耗水", 0, 100, "any"],
  ["fertilizer", "需施肥次数", 0, 20, 1],
  ["salePrice", "基础售价", 0, 1000000, 1],
  ["yield", "每次收成份数", 1, 100, 1],
  ["floodDays", "连续积水枯萎天数", 1, 30, 1],
];
const gardenNumber = ([key, label, min, max, step], value) =>
  `<label>${label}<input name="${key}" type="number" min="${min}" max="${max}" step="${step}" value="${esc(value)}" required /></label>`;
const gardenChecked = (v) => (v ? " checked" : "");
const gardenOption = (key, label) =>
  `<option value="${esc(key)}">${esc(label)}</option>`;
const gardenDuration = (hours) =>
  new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 1 }).format(hours);
const gardenMoney = (value) => `${Number(value).toLocaleString("zh-CN")} 元`;
const gardenAt = (value) => new Date(value).toLocaleString("zh-CN");
const gardenCropName = (state, id) => state.settings.crops[id]?.name || id;
const gardenActorName = (state, kind, id) =>
  state.roles.find((row) => row.kind === kind && row.id === id)?.name ||
  (id === "system" ? "系统" : id);
const gardenButton = (kind, text) =>
  `<button type="button" class="ghost" data-garden-act="${kind}">${text}</button>`;

function gardenPlotMarkup(state, { id, plant, sheltered }) {
  const paused = Boolean(state.pauseReason);
  const canopy = `<p>${sheltered ? "有棚" : "露天"}</p><fieldset${paused ? " disabled" : ""}>${sheltered ? gardenButton("unshelter", "撤棚") : gardenButton("shelter", "搭棚")}</fieldset>`;
  if (!plant) {
    const crops = Object.entries(state.settings.crops).filter(
      ([key, crop]) => crop.enabled && (crop.market || state.seeds[key] > 0),
    );
    return `<article class="garden-plot" data-plot="${id}"><h3>第 ${id} 块</h3><p>空地</p>${canopy}<fieldset${paused || !crops.length ? " disabled" : ""}>
      <select aria-label="第 ${id} 块的作物" data-garden-crop>${crops.map(([key, crop]) => gardenOption(key, `${crop.name} · ${state.seeds[key] > 0 ? "用库存种子" : gardenMoney(crop.seedPrice)}`)).join("")}</select>
      ${gardenButton("plant", "播种")}
    </fieldset></article>`;
  }
  const progress = Math.min(
    100,
    Math.floor((100 * plant.growth) / plant.crop.hours),
  );
  const stage =
    plant.status === "mature"
      ? "已成熟"
      : plant.status === "withered"
        ? "已枯萎"
        : progress < 25
          ? "幼苗"
          : "生长中";
  return `<article class="garden-plot garden-${plant.status}" data-plot="${id}">
    <h3>第 ${id} 块</h3>${canopy}<strong>${esc(plant.crop.name)}</strong>
    <p>${stage}${plant.quality ? " · " + gardenQuality[plant.quality] : ""}</p>
    ${plant.status === "growing" ? `<p>成长 ${progress}% · 水分 ${Math.floor(plant.water)}</p><p>施肥 ${plant.fertilizer}/${plant.crop.fertilizer}</p>` : ""}
    ${plant.witheredReason === "drought" ? '<p class="hint">长期缺水</p>' : ""}
    ${plant.witheredReason === "flood" ? '<p class="hint">连续暴雨积水</p>' : ""}
    <fieldset${paused ? " disabled" : ""}>
      ${
        plant.status === "mature"
          ? gardenButton("harvest", "收成")
          : plant.status === "withered"
            ? gardenButton("clear", "铲除枯株")
            : `${gardenButton("water", "浇水")}${plant.fertilizer < plant.crop.fertilizer && state.fertilizer ? gardenButton("fertilize", "施肥") : ""}`
      }
    </fieldset></article>`;
}

function gardenPriorityText({ plot, kind, hours, risk }) {
  const time = gardenDuration(hours);
  return `第 ${plot} 块 · ${
    {
      drought: `水分已用完，约 ${time} 个花园小时后枯萎`,
      water: hours === null ? "当前缺水" : `缺水，约 ${time} 个花园小时后耗尽`,
      flood: `暴雨积水，本日剩 ${Math.ceil(hours * 10) / 10} 花园小时 · ${risk === "critical" ? "日结束前搭棚，否则枯萎" : "建议搭棚"}`,
      low_water_forecast: `按现状约 ${time} 个花园小时后缺水`,
      harvest: "可收成",
      clear: "可以清理枯株",
    }[kind]
  }`;
}

function gardenWarehouse(state) {
  const recipients = state.roles
    .map((r, index) => gardenOption(index, r.name))
    .join("");
  const market = Object.entries(state.settings.crops).filter(
    ([, crop]) => crop.enabled && crop.market,
  );
  return `<div class="card">
    <h3>公共仓库</h3>
    <p>肥料 ${state.fertilizer} 包 · ${
      Object.entries(state.seeds)
        .filter(([, count]) => count > 0)
        .map(
          ([id, count]) => esc(gardenCropName(state, id)) + " " + count + " 颗",
        )
        .join(" · ") || "种子库存为空"
    }</p>
    <fieldset${state.pauseReason ? " disabled" : ""} class="garden-shop">
      <label>种子<select data-garden-seed>${market.map(([id, crop]) => gardenOption(id, crop.name + " · " + gardenMoney(crop.seedPrice))).join("")}</select></label>
      <label>购买数量<input data-garden-buy-count type="number" value="1" min="1" max="1000000" step="1"/></label>
      ${gardenButton("buy_seed", "买种子")}
      ${gardenButton("buy_fertilizer", `买肥料 · ${gardenMoney(state.settings.fertilizerPrice)}/包`)}
    </fieldset>
    ${
      state.market
        .map(
          (item) => `<article class="record" data-harvest="${esc(item.id)}">
      <p><strong>${esc(gardenCropName(state, item.cropId))}</strong> · ${gardenQuality[item.quality]} · 库存 ${item.quantity} · 售价约 ${gardenMoney(item.saleRate)}/份</p>
      <fieldset${state.pauseReason ? " disabled" : ""}>
        <label>数量<input data-garden-sale-count type="number" min="1" max="${item.quantity}" step="1" value="1"/></label>
        ${gardenButton("sell", "出售")}
        <label>送给<select data-garden-recipient>${recipients}</select></label>
        ${gardenButton("gift", "赠送")}
      </fieldset></article>`,
        )
        .join("") || '<p class="hint">还没有收成。</p>'
    }
  </div>`;
}

function gardenCropEditor(id, crop) {
  return `<details class="card garden-crop" data-crop="${esc(id)}">
    <summary>${esc(crop.name)} · ${esc(id)}${crop.enabled ? "" : " · 已停种"}</summary>
    <div class="garden-settings-grid">
      <label>名称<input name="name" value="${esc(crop.name)}" required maxlength="60"/></label>
      <label>说明<input name="description" value="${esc(crop.description)}" maxlength="400"/></label>
      <label>光照偏好<select name="light">
       ${Object.entries({ sun: "喜阳", neutral: "适中", shade: "喜阴" })
         .map(
           ([key, label]) =>
             `<option value="${key}"${crop.light === key ? " selected" : ""}>${label}</option>`,
         )
         .join("")}
      </select></label>
      ${gardenCropFields.map((field) => gardenNumber(field, crop[field[0]])).join("")}
      <label><input name="rainSensitive" type="checkbox"${gardenChecked(crop.rainSensitive ?? id === "strawberry")}/>怕涝（细雨露天扣品质）</label>
      ${[
        ["high", "高"],
        ["medium", "中"],
        ["low", "低"],
      ]
        .map(
          ([key, label]) =>
            `<label>${label}光照倍率<input name="light-${key}" type="number" min="0" max="4" step="any" value="${esc(crop.lightRates?.[key] ?? "")}" placeholder="按偏好默认"/></label>`,
        )
        .join("")}
      <label><input name="enabled" type="checkbox"${gardenChecked(crop.enabled)}/>允许播种</label>
      <label><input name="market" type="checkbox"${gardenChecked(crop.market)}/>集市售种</label>
    </div></details>`;
}

function gardenSettingsMarkup(state) {
  return fold(
    "garden-settings",
    "花园设置",
    `<form data-garden-settings>
    <p class="hint">保存后即时生效。生长规则用在新播种的作物，市价用于下一笔交易。初始资金 ${gardenMoney(state.settings.initialBalance)} 已记入建园账本。</p>
    <div class="garden-settings-grid">
      <label><input name="garden-enabled" type="checkbox"${gardenChecked(state.settings.enabled)}/>花园继续运行</label>
      ${gardenFields.map((field) => gardenNumber(field, state.settings[field[0]])).join("")}
    </div>
    <fieldset><legend>允许使用主人格工具经营</legend>
    ${state.roles
      .filter((r) => r.kind === "agent")
      .map(
        (r) =>
          `<label><input name="roleIds" value="${esc(r.id)}" type="checkbox"${gardenChecked(state.roleIds.includes(r.id))}/>${esc(r.name)}</label>`,
      )
      .join("")}</fieldset>
    <h3>作物图鉴</h3>
    <div class="garden-shop">
      <label>作物 ID<input data-crop-id maxlength="40" placeholder="例如 lemon-mint"/></label>
      <label>复制自<select data-crop-parent>${Object.entries(
        state.settings.crops,
      )
        .map(([id, crop]) => gardenOption(id, crop.name))
        .join("")}</select></label>
      <button type="button" class="ghost" data-add-crop>新增作物</button>
    </div>
    ${Object.entries(state.settings.crops)
      .map(([id, crop]) => gardenCropEditor(id, crop))
      .join("")}
    ${gardenWeatherSettingsMarkup(state.settings.weather, Object.fromEntries(Object.entries(state.settings.crops).map(([id, crop]) => [id, crop.name])))}
    <button type="submit" class="primary">保存花园设置</button>
  </form>`,
    {
      summary: `当前 ${state.settings.speed}× · 每轮 ${state.settings.turnLimit} 次`,
    },
  );
}

function gardenLogRows(entries, format, empty) {
  return entries.length
    ? entries.map((entry) => `<p class="record">${format(entry)}</p>`).join("")
    : `<p class="hint">${empty}</p>`;
}

function gardenMarkup(state) {
  if (!state.initialized)
    return `<section class="card"><h2>小窝花园</h2><p>开园后建立九块共享花圃。首次开园时，受影响的主人格会话可能交接一次。</p>
      <form data-garden-initialize><label>初始资金<input name="initialBalance" type="number" value="1000" min="0" max="1000000" required /></label>
        <button type="submit" class="primary">开园</button></form></section>`;
  const info = state.pauseReason ? gardenLabels[state.pauseReason] : "运行中";
  return `<section class="card"><h2>小窝花园</h2><p><strong>${gardenMoney(state.balance)}</strong> · 第 ${state.day} 天 · ${esc(state.weather.name)} · ${state.settings.speed}× · ${info}</p>
      <p class="hint">本日剩 ${gardenDuration(state.dayRemaining / 3600000)} 个花园小时</p>
      <div class="garden-grid">${state.plots.map((entry) => gardenPlotMarkup(state, entry)).join("")}</div>
      ${state.priorities.length ? `<h3>可以先做</h3><ul>${state.priorities.map((item) => `<li>${gardenPriorityText(item)}</li>`).join("")}</ul>` : ""}
    </section>
    ${gardenWarehouse(state)}
    ${fold(
      "garden-activity",
      "经营活动",
      gardenLogRows(
        state.activity,
        (row) =>
          `${esc(gardenAt(row.at))} · ${esc(gardenActorName(state, row.actor_kind, row.actor_id))} · ${gardenActions[row.action]}${row.result.plot ? " · 第 " + row.result.plot + " 块" : ""}`,
        "还没有经营活动。",
      ),
      { summary: "最近操作" },
    )}
    ${fold(
      "garden-ledger",
      "公共账本",
      gardenLogRows(
        state.ledger,
        (row) =>
          `${esc(gardenAt(row.at))} · ${esc(gardenActorName(state, row.actor_kind, row.actor_id))} · ${gardenActions[row.action]} · ${row.delta > 0 ? "+" : ""}${gardenMoney(row.delta)} · 余额 ${gardenMoney(row.balance)}`,
        "还没有账目。",
      ),
      { summary: "最近资金变动" },
    )}
    ${fold(
      "garden-gifts",
      "赠礼记录",
      gardenLogRows(
        state.gifts,
        (row) =>
          `${esc(gardenAt(row.at))} · ${esc(gardenActorName(state, row.giver_kind, row.giver_id))} 送给 ${esc(gardenActorName(state, row.recipient_kind, row.recipient_id))} · ${esc(gardenCropName(state, row.crop_id))} × ${row.quantity}`,
        "还没有赠礼。",
      ),
      { summary: "最近赠礼" },
    )}
    ${gardenSettingsMarkup(state)}
    ${gardenWeatherTrialMarkup(state.settings.weather)}`;
}

function gardenFormSettings(form, state) {
  const settings = { ...state.settings, crops: Object.create(null) };
  settings.enabled = form.elements["garden-enabled"].checked;
  for (const [key] of gardenFields)
    settings[key] = form.elements[key].valueAsNumber;
  for (const row of form.querySelectorAll("[data-crop]")) {
    const read = (key) => row.querySelector(`[name="${key}"]`);
    const crop = Object.fromEntries(
      gardenCropFields.map(([key]) => [key, read(key).valueAsNumber]),
    );
    for (const key of ["name", "description", "light"])
      crop[key] = read(key).value;
    for (const key of ["enabled", "market", "rainSensitive"])
      crop[key] = read(key).checked;
    const overrides = ["high", "medium", "low"]
      .filter((key) => read("light-" + key).value !== "")
      .map((key) => [key, read("light-" + key).valueAsNumber]);
    if (overrides.length) crop.lightRates = Object.fromEntries(overrides);
    settings.crops[row.dataset.crop] = crop;
  }
  settings.weather = gardenReadWeather(form);
  return {
    settings,
    expectedRevision: state.settingsRevision,
    roleIds: new FormData(form).getAll("roleIds"),
  };
}

function gardenActionFrom(button, state) {
  const kind = button.dataset.gardenAct;
  const parent = button.closest("[data-plot]");
  if (parent) {
    const entry = state.plots.find(
      (plot) => plot.id === Number(parent.dataset.plot),
    );
    if (kind === "shelter" || kind === "unshelter")
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
        : { buyPrice: state.settings.crops[cropId].seedPrice }),
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
    const { kind: targetKind, id } =
      state.roles[Number(stock.querySelector("[data-garden-recipient]").value)];
    return { kind, harvestId, quantity, recipient: { kind: targetKind, id } };
  }
  const shop = button.closest(".garden-shop");
  const count = shop.querySelector("[data-garden-buy-count]");
  if (!count.reportValidity()) return null;
  const quantity = count.valueAsNumber;
  if (kind === "buy_fertilizer")
    return { kind, quantity, price: state.settings.fertilizerPrice * quantity };
  const cropId = shop.querySelector("[data-garden-seed]").value;
  return {
    kind,
    cropId,
    quantity,
    price: state.settings.crops[cropId].seedPrice * quantity,
  };
}

function renderGarden() {
  const content = $("#content");
  content.innerHTML =
    '<section id="garden-page" class="garden-page"><button type="button" class="ghost" data-garden-refresh>刷新花园</button><p role="status" data-garden-status>读取花园…</p><div data-garden-body></div></section>';
  const page = $("#garden-page");
  const panel = page.querySelector("[data-garden-body]");
  const message = page.querySelector("[data-garden-status]");
  let state,
    busy = false,
    pendingAction;
  const show = (next) => {
    if (!page.isConnected) return;
    state = next;
    panel.innerHTML = gardenMarkup(next);
  };
  const run = async (operation, success = "") => {
    if (busy) return;
    busy = true;
    page.setAttribute("aria-busy", "true");
    message.textContent = "";
    try {
      await operation();
      message.textContent = success;
    } catch (error) {
      const stock = error.stock;
      message.textContent = stock
        ? "该份收成" +
          ({ sell: "最近被售出，", gift: "最近被赠送，" }[stock.lastUse] ||
            "") +
          "剩余 " +
          stock.available +
          " 份。请刷新后查看。"
        : gardenLabels[error.code] || error.message;
      if (error.code) pendingAction = undefined;
    } finally {
      busy = false;
      page.removeAttribute("aria-busy");
    }
  };
  const refresh = async () => show(await api("/api/home-garden"));
  page.addEventListener("click", (event) => {
    const button = event.target.closest("button");
    if (!button || busy) return;
    if (button.hasAttribute("data-garden-refresh"))
      return void run(refresh, "花园已刷新");
    if (button.hasAttribute("data-add-crop")) {
      const form = button.form;
      if (!form.reportValidity()) return;
      const id = form.querySelector("[data-crop-id]").value.trim();
      const key = form.querySelector("[data-crop-parent]").value;
      const { settings } = gardenFormSettings(form, state);
      if (
        !/^[a-z][a-z0-9-]{0,39}$/.test(id) ||
        Object.hasOwn(settings.crops, id)
      ) {
        message.textContent =
          "请填写未使用的作物 ID，以小写字母开头，只含小写字母、数字和短横线。";
        return;
      }
      const last = Array.from(form.querySelectorAll(".garden-crop")).at(-1);
      last.insertAdjacentHTML(
        "afterend",
        gardenCropEditor(id, { ...settings.crops[key], name: id }),
      );
      last.nextElementSibling.open = true;
      form
        .querySelector("[data-crop-parent]")
        .insertAdjacentHTML("beforeend", gardenOption(id, id));
      form.querySelector("[data-crop-id]").value = "";
      return;
    }
    if (gardenWeatherEdit(event, (text) => (message.textContent = text)))
      return;
    if (!button.hasAttribute("data-garden-act")) return;
    const action = gardenActionFrom(button, state);
    if (!action) return;
    const payload = JSON.stringify(action);
    if (pendingAction?.payload !== payload)
      pendingAction = { payload, requestId: crypto.randomUUID() };
    void run(async () => {
      const { garden } = await api("/api/home-garden/act", {
        requestId: pendingAction.requestId,
        action,
      });
      pendingAction = undefined;
      show(garden);
    }, gardenActions[action.kind] + "完成");
  });
  page.addEventListener("change", (event) =>
    gardenWeatherEdit(event, (text) => (message.textContent = text)),
  );
  page.addEventListener(
    "invalid",
    (event) => {
      for (const detail of page.querySelectorAll("details"))
        if (detail.contains(event.target)) detail.open = true;
    },
    true,
  );
  page.addEventListener("submit", (event) => {
    event.preventDefault();
    if (busy) return;
    const form = event.target;
    if (form.hasAttribute("data-garden-weather-trial"))
      return void run(() => gardenRunWeatherTrial(form));
    if (form.hasAttribute("data-garden-initialize"))
      void run(
        async () =>
          show(
            await api("/api/home-garden/initialize", {
              initialBalance: form.elements.initialBalance.valueAsNumber,
            }),
          ),
        "已开园",
      );
    if (form.hasAttribute("data-garden-settings"))
      void run(
        async () =>
          show(
            await api(
              "/api/home-garden/settings",
              gardenFormSettings(form, state),
            ),
          ),
        "设置已保存",
      );
  });
  void run(refresh);
}
