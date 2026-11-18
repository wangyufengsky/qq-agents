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

function gardenWeatherConditionRow(condition, entries, crops, event = false) {
  const hasWeather = ["previous", "today", "streak"].includes(condition.field);
  const hasCount = !["previous", "today", "weekDay"].includes(condition.field);
  const plotCount = ["growing", "sheltered", "fertilizable", "alive"].includes(
    condition.field,
  );
  const needCrop = ["seed", "harvest"].includes(condition.field) || plotCount;
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
    ${gardenWeatherSelect("weatherField", "条件字段", event ? { today: "当天抽到的天气", ...gardenWeatherFields, growing: "生长中地块", sheltered: "有棚地块", fertilizable: "可施肥地块", alive: "有存活作物的地块", weekDay: "花园周内日序" } : gardenWeatherFields, condition.field)}
    ${hasWeather ? gardenWeatherSelect("weatherMatch", "匹配天气", matchOptions, match) : ""}
    ${needCrop ? gardenWeatherSelect("weatherCrop", plotCount ? "限定作物" : "库存作物", plotCount ? { "": "全部作物", ...crops } : crops, condition.cropId || "") : ""}
    ${condition.field === "weekDay" ? multiSelect("weekDays", "每七个花园日中的第几天", Object.fromEntries([1, 2, 3, 4, 5, 6, 7].map((n) => [n, "第 " + n + " 天"])), (condition.days ?? [6, 7]).map(String)) : ""}
    ${hasCount ? `${gardenWeatherSelect("weatherOp", "比较方式", gardenWeatherOps, condition.op || "gt")}<label>阈值<input name="weatherValue" type="number" min="0" max="${condition.field === "streak" ? 365 : plotCount ? 9 : Number.MAX_SAFE_INTEGER}" step="1" value="${condition.value ?? 0}" required/></label>` : ""}
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
        gardenReadPoolCondition,
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
  if (!form || event.target.closest("[data-event-entry]")) return false;
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

function gardenReadPoolCondition(node) {
  const read = (name) => node.querySelector(`[name="${name}"]`);
  const field = read("weatherField").value;
  const selection = read("weatherMatch")?.value;
  const [by, value] = selection?.split(":") || [];
  return {
    field,
    ...(selection && { match: { by, value } }),
    ...(read("weatherOp") && {
      op: read("weatherOp").value,
      value: read("weatherValue").valueAsNumber,
    }),
    ...(read("weatherCrop")?.value && { cropId: read("weatherCrop").value }),
    ...(field === "weekDay" && {
      days: Array.from(read("weekDays").selectedOptions, (o) =>
        Number(o.value),
      ),
    }),
  };
}
const gardenEventKinds = {
  blessing: "地块祝福",
  nuisance: "捣蛋来客",
  weather_flip: "天气反转",
  harvest_bonus: "收获与写生",
  mystery_box: "周末盲盒",
  merchant: "流浪商人",
  thief: "小偷",
  visitor: "幸运访客",
};
const gardenRewardKinds = {
  seed: "种子",
  fertilizer: "肥料",
  fertilizer_credit: "一次免费施肥",
};
const gardenEventNumbers = {
  merchant: [
    ["offers", "种子报价种类数", 1, 20, 1],
    ["discount", "种子售价倍率", 0, 1, "any"],
    ["minPremium", "最低收购倍率", 1.3, 1.6, "any"],
    ["maxPremium", "最高收购倍率", 1.3, 1.6, "any"],
  ],
  thief: [
    ["reward", "驱赶奖励（元）", 0, 1000, 1],
    ["coinLoss", "无人处理时零钱损失上限", 0, 1000, 1],
    ["cropLoss", "成品损失上限", 1, 5, 1],
  ],
};
const gardenEventNumber = ([key, label, min, max, step], value, fallback) =>
  `<label>${label}<input name="${key}" type="number" min="${min}" max="${max}" step="${step}" value="${esc(value ?? "")}"${fallback === undefined ? " required" : ` placeholder="默认 ${esc(fallback)}"`}/></label>`;

const gardenEventVariants = {
  blessing: {
    meteor: "流星许愿",
    dew: "清晨甘露",
    firefly: "萤火虫音乐会",
    earthworm: "黄金蚯蚓",
  },
  nuisance: { cat: "野猫", aphids: "蚜虫" },
  harvest_bonus: { twin: "双份收获", sketch: "写生竞赛" },
};
const gardenBlessingFields = [
  ["growth", "增加有效生长小时", 0, 24, "any"],
  ["quality", "增加品质分", 0, 100, 1],
  ["water", "增加水分", 0, 100, "any"],
];
const gardenMechanicFields = {
  meteor: gardenBlessingFields,
  dew: gardenBlessingFields,
  firefly: gardenBlessingFields,
  earthworm: [],
  cat: [["reward", "哄走奖励", 0, 1000, 1]],
  aphids: [
    ["cost", "除虫费用", 0, 1000, 1],
    ["growthRate", "生长倍率", 0, 1, "any"],
    ["qualityLoss", "日终品质损失", 0, 100, 1],
  ],
  twin: [["multiplier", "首笔收获倍率", 1, 100, 1]],
  sketch: [
    ["required", "不同作物数", 1, 9, 1],
    ["reward", "领奖金额", 0, 1000, 1],
  ],
  weather_flip: [["hour", "转为实况的花园小时", 1, 23, 1]],
  mystery_box: [
    ["price", "每袋价格", 0, 1000, 1],
    ["limit", "全园每日限购", 1, 100, 1],
  ],
};
const gardenMechanicDefaults = {
  meteor: { growth: 5, quality: 15 },
  dew: { water: 30 },
  firefly: { quality: 20 },
  earthworm: {},
  cat: { reward: 10 },
  aphids: { cost: 10, growthRate: 0.5, qualityLoss: 10 },
  twin: { multiplier: 2 },
  sketch: { required: 3, reward: 80 },
  weather_flip: { hour: 12 },
  mystery_box: { price: 25, limit: 2 },
};
const gardenGiftCatalog = [
  ["dried-fish", "小鱼干", 12],
  ["yarn-ball", "毛线球", 18],
  ["pressed-bookmark", "压花书签", 24],
];
function multiSelect(name, label, options, selected, required = true) {
  const ids = required
    ? Object.keys(options)
    : [
        ...selected,
        ...Object.keys(options).filter((id) => !selected.includes(id)),
      ];
  return `<label>${label}<select name="${name}" multiple${required ? " required" : ""} size="4">${ids
    .map(
      (id) =>
        `<option value="${esc(id)}"${selected.includes(id) ? " selected" : ""}>${esc(options[id])}</option>`,
    )
    .join("")}</select></label>`;
}
function gardenEventEffect(kind, effect, crops, weatherIds) {
  const variants = gardenEventVariants[kind],
    variant = effect.effect ?? Object.keys(variants ?? {})[0] ?? kind;
  if (gardenMechanicFields[variant]) {
    const fields = gardenMechanicFields[variant];
    return (
      (variants
        ? gardenWeatherSelect("variant", "玩法", variants, variant)
        : "") +
      (kind === "weather_flip"
        ? gardenWeatherSelect(
            "targetWeatherId",
            "午后天气条目",
            Object.fromEntries(weatherIds.map((id) => [id, id])),
            effect.targetWeatherId ??
              (weatherIds.includes("sun") ? "sun" : weatherIds[0]),
          )
        : "") +
      fields
        .map((field) => {
          const key = field[0],
            fallback = gardenMechanicDefaults[variant][key] ?? 0;
          return variants
            ? gardenEventNumber(field, effect[key], fallback)
            : gardenEventNumber(field, effect[key] ?? fallback);
        })
        .join("")
    );
  }
  if (kind === "visitor") {
    const reward = effect.reward ?? { kind: "fertilizer", quantity: 1 };
    return `${gardenWeatherSelect("rewardKind", "奖励类型", gardenRewardKinds, reward.kind)}
      ${reward.kind === "seed" ? gardenWeatherSelect("rewardCrop", "奖励作物", crops, reward.cropId) : ""}
      ${reward.kind === "fertilizer_credit" ? "" : gardenEventNumber(["quantity", "奖励数量", 1, 100, 1], reward.quantity)}`;
  }
  let extras = "";
  if (kind === "thief")
    extras = gardenWeatherSelect(
      "targetCropId",
      "只偷指定收成",
      { "": "任意收成", ...crops },
      effect.targetCropId ?? "",
    );
  if (kind === "merchant") {
    extras =
      multiSelect("seeds", "可报价种子", crops, effect.seeds, false) +
      multiSelect("harvests", "可收购作物", crops, effect.harvests, false) +
      gardenEventNumber(
        ["harvestOffers", "同时收购品种数", 1, 20, 1],
        effect.harvestOffers,
        1,
      ) +
      `<label>肥料单价（留空停售）<input type="number" min="0" max="1000" step="1" name="fertilizerRate" value="${esc(effect.fertilizerOffers?.[0]?.rate ?? "")}"></label>` +
      gardenGiftCatalog
        .map(([id, name, price]) => {
          const offer = effect.giftOffers?.find((o) => o.giftId === id);
          return `<fieldset data-gift-offer="${id}"${effect.giftOffers ? "" : " data-default-gift-offer"}><legend>${name}</legend>${gardenEventNumber(["giftStock", "每日库存（0 表示停售）", 0, 100, 1], offer?.stock ?? (effect.giftOffers ? 0 : 3))}${gardenEventNumber(["giftPrice", "礼物单价", 0, 1000, 1], offer?.price, price)}</fieldset>`;
        })
        .join("");
  }
  return (
    extras +
    gardenEventNumbers[kind]
      .map((field) => gardenEventNumber(field, effect[field[0]]))
      .join("")
  );
}

function gardenEventEntry(id, entry, weatherIds, crops) {
  return `<details class="card" data-event-entry="${esc(id)}"><summary>${esc(entry.name)} · ${esc(id)}${entry.enabled ? "" : " · 已停用"}</summary>
    <div class="garden-settings-grid">
      <label>事件名称<input name="eventName" value="${esc(entry.name)}" maxlength="40" required/></label>
      <label><input type="checkbox" name="eventEnabled"${entry.enabled ? " checked" : ""}/>启用事件</label>
      ${gardenEventNumber(["weight", "事件权重", 0, 10000, "any"], entry.weight)}
      ${gardenWeatherSelect("eventMode", "组合条件", { all: "全部满足", any: "任一满足" }, entry.mode)}
      ${gardenWeatherSelect("eventKind", "事件类型", gardenEventKinds, entry.effect.kind)}
    </div>
    <div class="garden-settings-grid" data-event-effect>${gardenEventEffect(entry.effect.kind, entry.effect, crops, weatherIds)}</div>
    <div data-event-conditions>${entry.conditions.map((row) => gardenWeatherConditionRow(row, weatherIds, crops, true)).join("")}</div>
    <button type="button" class="ghost" data-add-event-condition>新增事件条件</button>
  </details>`;
}

function gardenEventSettingsMarkup(pool, weather, crops, presets = []) {
  const ids = Object.keys(pool.entries);
  const names = Object.fromEntries(
    ids.map((id) => [id, pool.entries[id].name]),
  );
  const options = { "": "新建默认条目", ...names };
  return fold(
    "garden-event-settings",
    "每日事件池",
    `
    <p class="hint">天气抽取后筛选事件。设置从下一花园日起生效。</p>
    <div class="garden-settings-grid">
    ${gardenEventNumber(["eventRate", "每日事件触发率（0–1）", 0, 1, "any"], pool.rate)}
    <label>新事件 ID<input data-event-id maxlength="40" placeholder="例如 sunny-trader"/></label>
    ${gardenWeatherSelect("eventParent", "复制事件", options, "")}
    </div>
    <button type="button" class="ghost" data-add-event-entry>新增事件</button>
    <details><summary>补入新版预设</summary><p class="hint">选择缺少的条目后加入下方表单，保存设置后从下一花园日起生效。每池最多 40 条。</p>
    ${presets
      .map(({ id, entry, available }) => {
        const exists = Object.hasOwn(pool.entries, id);
        return `<label><input type="checkbox" data-event-preset="${esc(id)}" data-template="${esc(JSON.stringify(entry))}" ${exists || !available ? "disabled" : "checked"}> ${esc(entry.name)} · ${esc(id)}${exists ? "（已有同名 ID，保留当前设置）" : !available ? "（缺少引用的作物或天气）" : ""}</label>`;
      })
      .join("")}
    <button type="button" class="ghost" data-import-event-presets>把选中预设加入表单</button></details>
    <div data-event-entries>${ids.map((id) => gardenEventEntry(id, pool.entries[id], Object.keys(weather.entries), crops)).join("")}</div>
    `,
    { summary: "保存后次日生效" },
  );
}

function gardenReadEvents(form) {
  const entries = Object.fromEntries(
    Array.from(form.querySelectorAll("[data-event-entry]"), (row) => {
      const read = (key) => row.querySelector(`[name="${key}"]`);
      const kind = read("eventKind").value;
      let effect;
      if (kind === "visitor") {
        const rewardKind = read("rewardKind").value;
        effect = {
          kind,
          reward: {
            kind: rewardKind,
            quantity: read("quantity")?.valueAsNumber ?? 1,
            ...(rewardKind === "seed" && { cropId: read("rewardCrop").value }),
          },
        };
      } else if (gardenEventVariants[kind] || gardenMechanicFields[kind]) {
        const variant = read("variant")?.value;
        effect = {
          kind,
          ...(variant && { effect: variant }),
          ...(kind === "weather_flip" && {
            targetWeatherId: read("targetWeatherId").value,
          }),
          ...Object.fromEntries(
            gardenMechanicFields[variant ?? kind].flatMap(([k]) =>
              read(k).value === "" ? [] : [[k, read(k).valueAsNumber]],
            ),
          ),
        };
      } else {
        effect = {
          kind,
          ...Object.fromEntries(
            gardenEventNumbers[kind].map(([key]) => [
              key,
              read(key).valueAsNumber,
            ]),
          ),
        };
        if (kind === "thief" && read("targetCropId").value)
          effect.targetCropId = read("targetCropId").value;
        if (kind === "merchant") {
          if (read("harvestOffers").value !== "")
            effect.harvestOffers = read("harvestOffers").valueAsNumber;
          if (read("fertilizerRate").value !== "")
            effect.fertilizerOffers = [
              { rate: read("fertilizerRate").valueAsNumber },
            ];
          const giftFields = Array.from(
            row.querySelectorAll("[data-gift-offer]"),
          );
          const gifts = giftFields.map((box) => {
            const price = box.querySelector('[name="giftPrice"]');
            return {
              giftId: box.dataset.giftOffer,
              stock: box.querySelector('[name="giftStock"]').valueAsNumber,
              ...(price.value !== "" && { price: price.valueAsNumber }),
            };
          });
          if (
            !giftFields.every((box) =>
              box.hasAttribute("data-default-gift-offer"),
            ) ||
            !gifts.every((gift) => gift.stock === 3 && gift.price === undefined)
          )
            effect.giftOffers = gifts.filter((gift) => gift.stock > 0);
        }
        if (kind === "merchant")
          for (const key of ["seeds", "harvests"])
            effect[key] = Array.from(
              read(key).selectedOptions,
              (option) => option.value,
            );
      }
      return [
        row.dataset.eventEntry,
        {
          name: read("eventName").value,
          enabled: read("eventEnabled").checked,
          weight: read("weight").valueAsNumber,
          mode: read("eventMode").value,
          conditions: Array.from(
            row.querySelectorAll("[data-weather-condition]"),
            gardenReadPoolCondition,
          ),
          effect,
        },
      ];
    }),
  );
  return { rate: form.elements.eventRate.valueAsNumber, entries };
}

function gardenEventEdit(event, show) {
  const node = event.target;
  const form = node.closest("[data-garden-settings]");
  const row = node.closest("[data-event-entry]");
  const button = node.closest("button");
  if (
    !form ||
    (!row &&
      !button?.matches("[data-add-event-entry],[data-import-event-presets]"))
  )
    return false;
  const weather = Array.from(
    form.querySelectorAll("[data-weather-entry]"),
    (entry) => entry.dataset.weatherEntry,
  );
  const crops = Object.fromEntries(
    Array.from(form.querySelectorAll("[data-crop]"), (entry) => [
      entry.dataset.crop,
      entry.querySelector('[name="name"]').value,
    ]),
  );
  const first = Object.keys(crops)[0];
  const defaults = {
    merchant: {
      kind: "merchant",
      seeds: [first],
      harvests: [first],
      offers: 1,
      discount: 0.75,
      minPremium: 1.3,
      maxPremium: 1.6,
    },
    thief: { kind: "thief", reward: 15, coinLoss: 30, cropLoss: 1 },
    visitor: { kind: "visitor", reward: { kind: "fertilizer", quantity: 1 } },
  };
  if (button?.hasAttribute("data-import-event-presets")) {
    const container = form.querySelector("[data-event-entries]");
    const ids = new Set(
      Array.from(container.children, (e) => e.dataset.eventEntry),
    );
    const selected = Array.from(
      form.querySelectorAll("[data-event-preset]:checked:not(:disabled)"),
    ).filter((e) => !ids.has(e.dataset.eventPreset));
    if (ids.size + selected.length > 40) {
      show("超过 40 条上限，请减少选中的预设。");
      return true;
    }
    for (const input of selected) {
      const id = input.dataset.eventPreset,
        entry = JSON.parse(input.dataset.template);
      container.insertAdjacentHTML(
        "beforeend",
        gardenEventEntry(id, entry, weather, crops),
      );
      form.elements.eventParent.add(new Option(entry.name, id));
      input.checked = false;
      input.disabled = true;
    }
    show(
      selected.length
        ? "已加入选中的预设，请保存花园设置。"
        : "没有可加入的预设。",
    );
    return true;
  }
  if (event.type === "change") {
    if (node.name === "variant")
      row.querySelector("[data-event-effect]").innerHTML = gardenEventEffect(
        row.querySelector('[name="eventKind"]').value,
        { effect: node.value },
        crops,
        weather,
      );
    else if (node.name === "eventKind")
      row.querySelector("[data-event-effect]").innerHTML = gardenEventEffect(
        node.value,
        defaults[node.value] ?? {},
        crops,
        weather,
      );
    else if (node.name === "rewardKind")
      row.querySelector("[data-event-effect]").innerHTML = gardenEventEffect(
        "visitor",
        { reward: { kind: node.value, quantity: 1, cropId: first } },
        crops,
      );
    else if (node.name === "weatherField")
      node.closest("[data-weather-condition]").outerHTML =
        gardenWeatherConditionRow({ field: node.value }, weather, crops, true);
    return true;
  }
  if (button?.hasAttribute("data-remove-weather-condition")) {
    button.closest("[data-weather-condition]").remove();
    return true;
  }
  if (button?.hasAttribute("data-add-event-condition")) {
    const target = row.querySelector("[data-event-conditions]");
    if (target.children.length < 12)
      target.insertAdjacentHTML(
        "beforeend",
        gardenWeatherConditionRow({ field: "today" }, weather, crops, true),
      );
    else show("每个事件最多 12 个条件。");
    return true;
  }
  if (!button?.hasAttribute("data-add-event-entry")) return false;
  const idInput = form.querySelector("[data-event-id]");
  const id = idInput.value.trim();
  const existing = gardenReadEvents(form).entries;
  if (
    !/^[a-z][a-z0-9-]{0,39}$/.test(id) ||
    Object.hasOwn(existing, id) ||
    Object.keys(existing).length >= 40
  ) {
    show("请填写未占用的小写事件 ID，每池最多 40 个条目。");
    return true;
  }
  if (!form.reportValidity()) return true;
  const entry = existing[form.elements.eventParent.value] ?? {
    enabled: true,
    weight: 1,
    mode: "all",
    conditions: [],
    effect: defaults.visitor,
  };
  const target = form.querySelector("[data-event-entries]");
  target.insertAdjacentHTML(
    "beforeend",
    gardenEventEntry(id, { ...entry, name: id }, weather, crops),
  );
  target.lastElementChild.open = true;
  form.elements.eventParent.add(new Option(id, id));
  idInput.value = "";
  return true;
}

function gardenEventTrialMarkup(weather) {
  const names = Object.fromEntries(
    Object.entries(weather.entries).map(([id, row]) => [
      id,
      row.name + " · " + id,
    ]),
  );
  return fold(
    "garden-event-trial",
    "试配每日事件",
    `<form data-garden-event-trial>
    <div class="garden-settings-grid">
    ${gardenWeatherSelect("todayId", "模拟当日天气", { "": "当前天气", ...names }, "")}
    ${gardenWeatherSelect("previousId", "模拟前一日天气", { "": "最近结算天气", ...names }, "")}
    <label>模拟连续天数<input name="streak" type="number" min="1" max="365" step="1" value="1"/></label>
    <label>模拟日初余额<input name="balance" type="number" min="0" max="${Number.MAX_SAFE_INTEGER}" step="1" placeholder="当前余额"/></label><label>模拟花园日<input name="day" type="number" min="1" step="1" placeholder="当前花园日"/></label>
    </div>
    <button class="ghost" type="submit">计算事件概率</button><div data-event-trial-result role="status"></div>
  </form>`,
    { summary: "查看入池与无事件概率" },
  );
}

async function gardenRunEventTrial(form) {
  const { todayId, previousId, streak, balance, day } = form.elements;
  const result = await api("/api/home-garden/event-trial", {
    ...(day.value && { day: day.valueAsNumber }),
    ...(todayId.value && { todayId: todayId.value }),
    ...(previousId.value && {
      previousId: previousId.value,
      ...(streak.value && { streak: streak.valueAsNumber }),
    }),
    ...(balance.value && { balance: balance.valueAsNumber }),
  });
  const format = new Intl.NumberFormat("zh-CN", {
    style: "percent",
    maximumFractionDigits: 3,
  });
  const labels = {
    disabled: "已停用",
    no_seeds: "没有可交易库存",
    weather_unavailable: "实况天气不可用",
    zero_weight: "权重为零",
    conditions: "条件未满足",
  };
  form.querySelector("[data-event-trial-result]").innerHTML =
    `<p>第 ${esc(result.day)} 花园日 · 采用抽取预报 ${esc(result.today || "无")}</p><p>无事件 · ${format.format(result.noEvent)}</p><ul>
    ${result.rows.map((row) => `<li>${esc(row.name)} · ${format.format(row.probability)} · ${row.reason ? (labels[row.reason] ?? row.reason) + (row.failedConditions?.length ? "（第 " + row.failedConditions.map((i) => i + 1).join("、") + " 条）" : "") : "入池"}</li>`).join("")}
    </ul>`;
}
