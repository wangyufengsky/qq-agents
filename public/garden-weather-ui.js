const gardenWeatherNames = {
  sun: "晴天",
  cloud: "多云",
  drizzle: "细雨",
  storm: "暴雨",
};
const gardenWeatherLights = { high: "高", medium: "中", low: "低" };
const gardenWeatherFields = {
  previous: "前一日天气",
  streak: "连续天气天数",
  balance: "日初余额",
  seed: "日初种子库存",
  harvest: "日初收成库存",
  fertilizer: "日初肥料库存",
};
const gardenWeatherOps = {
  eq: "等于",
  gt: "大于",
  gte: "大于等于",
  lt: "小于",
  lte: "小于等于",
};
const gardenWeatherNumbers = [
  ["weight", "抽取权重", 0, 10000],
  ["demand", "耗水倍率", 0, 10],
  ["rain", "露天每日补水（暴雨时满水）", 0, 2400],
  ["outdoorGrowth", "露天成长倍率", 0, 4],
  ["qualityLoss", "积水与细雨品质扣分", 0, 100],
];

function gardenWeatherSelect(name, label, options, selected) {
  return `<label>${label}<select name="${name}">${Object.entries(options)
    .map(
      ([id, text]) =>
        `<option value="${esc(id)}"${id === selected ? " selected" : ""}>${esc(text)}</option>`,
    )
    .join("")}</select></label>`;
}

function gardenWeatherConditionRow(condition, entries, crops) {
  const hasWeather = ["previous", "streak"].includes(condition.field);
  const hasCount = condition.field !== "previous";
  const needCrop = ["seed", "harvest"].includes(condition.field);
  const matchOptions = {
    ...Object.fromEntries(
      Object.entries(gardenWeatherNames).map(([id, name]) => [
        "kind:" + id,
        "类型 · " + name,
      ]),
    ),
    ...Object.fromEntries(entries.map((id) => ["id:" + id, "条目 · " + id])),
  };
  const match = condition.match
    ? condition.match.by + ":" + condition.match.value
    : "kind:cloud";
  return `<div data-weather-condition class="record">
    ${gardenWeatherSelect("weatherField", "条件字段", gardenWeatherFields, condition.field)}
    ${hasWeather ? gardenWeatherSelect("weatherMatch", "匹配天气", matchOptions, match) : ""}
    ${needCrop ? gardenWeatherSelect("weatherCrop", "库存作物", crops, condition.cropId) : ""}
    ${hasCount ? `${gardenWeatherSelect("weatherOp", "比较方式", gardenWeatherOps, condition.op || "gt")}<label>阈值<input name="weatherValue" type="number" min="0" max="${condition.field === "streak" ? 365 : Number.MAX_SAFE_INTEGER}" step="1" value="${condition.value ?? 0}" required/></label>` : ""}
    <button type="button" class="ghost" data-remove-weather-condition>移除条件</button>
  </div>`;
}

function gardenWeatherEntryMarkup(id, entry, entries, crops) {
  return `<details class="card" data-weather-entry="${esc(id)}"><summary>${esc(entry.name)} · ${esc(id)}${entry.enabled ? "" : " · 已停用"}</summary>
    <div class="garden-settings-grid">
      <label>天气名称<input name="weatherName" maxlength="40" value="${esc(entry.name)}" required /></label>
      ${gardenWeatherSelect("weatherKind", "天气类型", gardenWeatherNames, entry.kind)}
      ${gardenWeatherSelect("weatherLight", "有效光照", gardenWeatherLights, entry.light)}
      ${gardenWeatherNumbers.map(([key, label, min, max]) => `<label>${label}<input name="${key}" type="number" min="${min}" max="${max}" step="any" value="${esc(entry[key])}" required /></label>`).join("")}
      <label><input type="checkbox" name="weatherEnabled"${entry.enabled ? " checked" : ""}/>启用条目</label>
      ${gardenWeatherSelect("weatherMode", "组合条件", { all: "全部满足", any: "任一满足" }, entry.mode)}
    </div>
    <div data-weather-conditions>${entry.conditions.map((condition) => gardenWeatherConditionRow(condition, entries, crops)).join("")}</div>
    <button type="button" class="ghost" data-add-weather-condition>新增条件</button>
  </details>`;
}

function gardenWeatherSettingsMarkup(pool, crops) {
  const ids = Object.keys(pool.entries);
  const names = Object.fromEntries(
    ids.map((id) => [id, pool.entries[id].name]),
  );
  return fold(
    "garden-weather-settings",
    "天气池",
    `<p class="hint">保存后的条目自下一花园日起参与抽取。兜底条目须启用且没有条件。</p>
    <div class="garden-settings-grid">
      ${gardenWeatherSelect("weatherFallback", "兜底天气", names, pool.fallback)}
      <label>新天气 ID<input data-weather-id maxlength="40" placeholder="例如 spring-rain"/></label>
      ${gardenWeatherSelect("weatherParent", "复制天气", names, pool.fallback)}
    </div>
    <button type="button" class="ghost" data-add-weather-entry>复制为新天气</button>
    <div data-weather-entries>${ids.map((id) => gardenWeatherEntryMarkup(id, pool.entries[id], ids, crops)).join("")}</div>`,
    { summary: "保存后次日生效" },
  );
}

function gardenWeatherTrialMarkup(pool) {
  return fold(
    "garden-weather-trial",
    "试配天气",
    `<form data-garden-weather-trial>
      <p class="hint">按已保存的天气池和目前仓库计算概率。模拟值仅用于本次试配。</p>
      <div class="garden-settings-grid">
        <label>模拟日初余额<input name="balance" type="number" min="0" max="${Number.MAX_SAFE_INTEGER}" step="1" placeholder="当前余额"/></label>
        ${gardenWeatherSelect("previousId", "模拟前一日天气", { "": "最近结算天气", ...Object.fromEntries(Object.entries(pool.entries).map(([id, entry]) => [id, entry.name + " · " + id])) }, "")}
        <label>模拟连续天数<input name="streak" type="number" min="1" max="365" step="1" value="1"/></label>
      </div>
      <button class="ghost" type="submit">计算天气概率</button>
      <div data-weather-trial-result role="status"></div>
    </form>`,
    { summary: "查看入池概率" },
  );
}

function gardenReadWeather(form) {
  const entries = Object.fromEntries(
    Array.from(form.querySelectorAll("[data-weather-entry]"), (row) => {
      const read = (name) => row.querySelector(`[name="${name}"]`);
      const conditions = Array.from(
        row.querySelectorAll("[data-weather-condition]"),
        (node) => {
          const field = node.querySelector('[name="weatherField"]').value;
          const selection = node.querySelector('[name="weatherMatch"]')?.value;
          const [by, value] = selection?.split(":") || [];
          return {
            field,
            ...(selection && { match: { by, value } }),
            ...(field !== "previous" && {
              op: node.querySelector('[name="weatherOp"]').value,
              value: node.querySelector('[name="weatherValue"]').valueAsNumber,
            }),
            ...(["seed", "harvest"].includes(field) && {
              cropId: node.querySelector('[name="weatherCrop"]').value,
            }),
          };
        },
      );
      return [
        row.dataset.weatherEntry,
        {
          name: read("weatherName").value,
          enabled: read("weatherEnabled").checked,
          kind: read("weatherKind").value,
          light: read("weatherLight").value,
          mode: read("weatherMode").value,
          conditions,
          ...Object.fromEntries(
            gardenWeatherNumbers.map(([key]) => [key, read(key).valueAsNumber]),
          ),
        },
      ];
    }),
  );
  return { entries, fallback: form.elements.weatherFallback.value };
}

function gardenWeatherEdit(event, show) {
  const form = event.target.closest("[data-garden-settings]");
  if (!form) return false;
  const ids = Array.from(
    form.querySelectorAll("[data-weather-entry]"),
    (node) => node.dataset.weatherEntry,
  );
  const crops = Object.fromEntries(
    Array.from(form.querySelectorAll("[data-crop]"), (node) => [
      node.dataset.crop,
      node.querySelector('[name="name"]').value,
    ]),
  );
  if (event.type === "change" && event.target.name === "weatherField") {
    event.target.closest("[data-weather-condition]").outerHTML =
      gardenWeatherConditionRow({ field: event.target.value }, ids, crops);
    return true;
  }
  const button = event.target.closest("button");
  if (!button) return false;
  if (button.hasAttribute("data-remove-weather-condition")) {
    button.closest("[data-weather-condition]").remove();
    return true;
  }
  if (button.hasAttribute("data-add-weather-condition")) {
    const parent = button
      .closest("[data-weather-entry]")
      .querySelector("[data-weather-conditions]");
    if (parent.children.length < 12)
      parent.insertAdjacentHTML(
        "beforeend",
        gardenWeatherConditionRow({ field: "previous" }, ids, crops),
      );
    else show("每个天气条目最多 12 个条件。");
    return true;
  }
  if (!button.hasAttribute("data-add-weather-entry")) return false;
  if (!form.reportValidity()) return true;
  const idInput = form.querySelector("[data-weather-id]");
  const id = idInput.value.trim();
  if (
    ids.length >= 40 ||
    !/^[a-z][a-z0-9-]{0,39}$/.test(id) ||
    ids.includes(id)
  ) {
    show("请填写未占用的小写天气 ID，每池最多 40 个天气条目。");
    return true;
  }
  const pool = gardenReadWeather(form);
  const entry = {
    ...pool.entries[form.elements.weatherParent.value],
    name: id,
  };
  const parent = form.querySelector("[data-weather-entries]");
  parent.insertAdjacentHTML(
    "beforeend",
    gardenWeatherEntryMarkup(id, entry, [...ids, id], crops),
  );
  parent.lastElementChild.open = true;
  for (const select of form.querySelectorAll(
    '[name="weatherFallback"],[name="weatherParent"],[name="weatherMatch"]',
  )) {
    const value = select.name === "weatherMatch" ? "id:" + id : id;
    if (!Array.from(select.options).some((option) => option.value === value))
      select.add(
        new Option(select.name === "weatherMatch" ? "条目 · " + id : id, value),
      );
  }
  idInput.value = "";
  return true;
}

async function gardenRunWeatherTrial(form) {
  const { balance, previousId, streak } = form.elements;
  const result = await api("/api/home-garden/weather-trial", {
    ...(balance.value !== "" && { balance: balance.valueAsNumber }),
    ...(previousId.value && {
      previousId: previousId.value,
      streak: streak.valueAsNumber,
    }),
  });
  const format = new Intl.NumberFormat("zh-CN", {
    style: "percent",
    maximumFractionDigits: 3,
  });
  const labels = {
    disabled: "已停用",
    zero_weight: "权重为零",
    conditions: "条件未满足",
  };
  form.querySelector("[data-weather-trial-result]").innerHTML = `
    <p>参考前一日天气 · ${esc(result.previous?.name || "无")}</p>
    <ul>${result.rows
      .map(
        (row) =>
          `<li>${esc(row.name)} · ${format.format(row.probability)} · ${
            row.id === result.fallback
              ? "兜底"
              : row.reason
                ? labels[row.reason] +
                  (row.reason === "conditions"
                    ? `（第 ${row.failedConditions.map((index) => index + 1).join("、")} 条）`
                    : "")
                : "入池"
          }</li>`,
      )
      .join("")}</ul>`;
}
