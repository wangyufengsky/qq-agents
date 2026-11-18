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
  `<label>${label}<input name="${esc(key)}" type="number" min="${min}" max="${max}" step="${step}" value="${esc(value)}" required /></label>`;
const gardenChecked = (v) => (v ? " checked" : "");
const gardenOption = (key, label) =>
  `<option value="${esc(key)}">${esc(label)}</option>`;
const gardenMoney = (value) => `${Number(value).toLocaleString("zh-CN")} 元`;
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

function gardenSettingsMarkup(state, catalog) {
  const roles = state.roles.filter(({ kind }) => kind === "agent");
  const budgets = state.settings.giftBudgets;
  return fold(
    "garden-settings",
    "花园设置",
    `<form data-garden-settings>
    <p class="hint">保存后即时生效。生长规则用在新播种的作物，市价用于下一笔交易。初始资金 ${gardenMoney(state.settings.initialBalance)} 已记入建园账本。</p>
    <div class="garden-settings-grid">
      <label><input name="garden-enabled" type="checkbox"${gardenChecked(state.settings.enabled)}/>花园继续运行</label>
      ${gardenFields.map((field) => gardenNumber(field, state.settings[field[0]])).join("")}
    </div>
    <fieldset><legend>照料方式</legend>
      <label>新播种作物<select name="careMode">
        <option value="gentle"${state.settings.careMode === "gentle" ? " selected" : ""}>安心照料 · 无水休眠，补水复苏</option>
        <option value="classic"${state.settings.careMode !== "gentle" ? " selected" : ""}>经典照料 · 长期无水会枯萎</option>
      </select></label>
      <label><input type="checkbox" name="careGrowing" ${state.settings.careMode === "gentle" ? "" : "disabled"}/>同时保护园中 ${state.plots.filter(({ plant }) => plant?.status === "growing" && plant.rules.careMode !== "gentle").length} 株仍按经典规则生长的作物</label>
    </fieldset>
    <fieldset><legend>允许使用主人格工具经营</legend>
    ${state.roles
      .filter((r) => r.kind === "agent")
      .map(
        (r) =>
          `<label><input name="roleIds" value="${esc(r.id)}" type="checkbox"${gardenChecked(state.roleIds.includes(r.id))}/>${esc(r.name)}</label>`,
      )
      .join("")}</fieldset>
    ${
      budgets
        ? `<fieldset><legend>伙伴自主购礼额度（每花园日）</legend>
      ${gardenNumber(["gift-budget-total", "全园总额", 0, 1000000, 1], budgets.total)}
      ${roles.map(({ id, name }) => gardenNumber(["gift-budget-" + id, esc(name) + " 上限", 0, 1000000, 1], budgets.roles[id] ?? 0)).join("")}
    </fieldset>`
        : ""
    }
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
    ${gardenEventSettingsMarkup(state.settings.events, state.settings.weather, Object.fromEntries(Object.entries(state.settings.crops).map(([id, crop]) => [id, crop.name])), catalog, state.eventPresets)}
    <button type="submit" class="primary">保存花园设置</button>
  </form>`,
    {
      summary: `当前 ${state.settings.speed}× · 每轮 ${state.settings.turnLimit} 次`,
    },
  );
}

function gardenInitializeMarkup(state) {
  if (!state.initialized)
    return `<section class="card"><h2>小窝花园</h2><p>开园后建立九块共享花圃。首次开园时，受影响的主人格会话可能交接一次。</p>
      <form data-garden-initialize><label>初始资金<input name="initialBalance" type="number" value="1000" min="0" max="1000000" required /></label>
        <button type="submit" class="primary">开园</button></form></section>`;
}

function gardenFormSettings(form, state) {
  const settings = { ...state.settings, crops: Object.create(null) };
  settings.careMode = form.elements.careMode.value;
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
  if (settings.giftBudgets)
    settings.giftBudgets = {
      total: form.elements["gift-budget-total"].valueAsNumber,
      roles: Object.fromEntries(
        state.roles
          .filter(({ kind }) => kind === "agent")
          .map(({ id }) => [
            id,
            form.elements["gift-budget-" + id].valueAsNumber,
          ]),
      ),
    };
  settings.weather = gardenReadWeather(form);
  settings.events = gardenReadEvents(form);
  return {
    settings,
    careScope:
      settings.careMode === "gentle" && form.elements.careGrowing.checked
        ? "growing"
        : "future",
    expectedRevision: state.settingsRevision,
    roleIds: new FormData(form).getAll("roleIds"),
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
    shared,
    workspace,
    busy = false,
    pendingAction;
  const show = (next, receipt) => {
    if (!page.isConnected) return;
    state = next;
    if (!next.initialized) {
      panel.innerHTML = gardenInitializeMarkup(next);
      return;
    }
    workspace ||= shared.bindGardenWorkspace(panel, {
      act,
      journal: (query) => api("/api/home-garden/journal", query),
      records: (current) => shared.gardenRecordsMarkup(current, fold),
      settings: (
        current,
      ) => `${gardenSettingsMarkup(current, shared.gardenGifts)}
        ${gardenWeatherTrialMarkup(current.settings.weather)}
        ${gardenEventTrialMarkup(current.settings.weather)}`,
      onStatus: (text) => (message.textContent = text),
    });
    workspace.draw(next, receipt);
  };
  const run = async (operation, success = "") => {
    if (busy) return;
    busy = true;
    page.setAttribute("aria-busy", "true");
    message.textContent = "";
    try {
      const status = await operation();
      if (status || success) message.textContent = status || success;
    } catch (error) {
      const stock = error.stock;
      message.textContent = stock
        ? "该份收成" +
          ({
            sell: "最近被售出，",
            gift: "最近被赠送，",
            thief: "最近被偷走一部分，",
          }[stock.lastUse] || "") +
          "剩余 " +
          stock.available +
          " 份。请刷新后查看。"
        : shared?.gardenLabels[error.code] || error.message;
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
    if (
      gardenEventEdit(
        event,
        (text) => (message.textContent = text),
        shared?.gardenGifts,
      )
    )
      return;
    if (gardenWeatherEdit(event, (text) => (message.textContent = text)))
      return;
  });
  function act(action) {
    if (busy) return;
    const payload = JSON.stringify(action);
    if (pendingAction?.payload !== payload)
      pendingAction = { payload, requestId: crypto.randomUUID() };
    void run(async () => {
      const { garden, receipt } = await api("/api/home-garden/act", {
        requestId: pendingAction.requestId,
        action,
      });
      pendingAction = undefined;
      const status = shared.gardenReceipt(garden, action, receipt);
      show(garden, shared.gardenEventOperation(action.kind) ? status : "");
      return shared.gardenEventOperation(action.kind) ? "" : status;
    });
  }
  page.addEventListener("change", ({ target }) => {
    if (target.name === "careMode") {
      const growing = target.form.elements.careGrowing;
      growing.disabled = target.value !== "gentle";
      growing.checked = !growing.disabled;
    }
  });
  page.addEventListener(
    "change",
    (event) =>
      gardenEventEdit(
        event,
        (text) => (message.textContent = text),
        shared?.gardenGifts,
      ) || gardenWeatherEdit(event, (text) => (message.textContent = text)),
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
    if (form.hasAttribute("data-garden-event-trial"))
      return void run(() => gardenRunEventTrial(form));
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
  void run(async () => {
    shared = await import("/garden-art/workspace.js");
    await refresh();
  });
}
