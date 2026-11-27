// History cursors belong to one filter and one reader. Keep them with the panel.
const types = {
  opened: "开园",
  planted: "播种",
  sprouted: "发芽",
  developed: "生长",
  mature: "成熟",
  withered: "枯萎",
  water: "浇水",
  fertilize: "施肥",
  harvest: "收成",
  clear: "清理",
  event: "每日事件",
  visitor: "访客",
  visitor_reward: "访客奖励",
  discovery: "邻株发现",
  followup: "隔日回响",
  almanac: "图鉴点亮",
};
export async function showGardenCard(container, read) {
  container.textContent = "正在生成花卡…";
  try {
    const { png, text } = await read();
    if (!container.isConnected) return;
    const bytes = Uint8Array.from(atob(png), (c) => c.charCodeAt(0));
    const bitmap = await createImageBitmap(
      new Blob([bytes], { type: "image/png" }),
    );
    if (!container.isConnected) {
      bitmap.close();
      return;
    }
    const canvas = document.createElement("canvas");
    canvas.setAttribute("role", "img");
    canvas.setAttribute("aria-label", text);
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    canvas.getContext("2d").drawImage(bitmap, 0, 0);
    bitmap.close();
    container.replaceChildren(canvas);
  } catch {
    container.textContent = "花卡暂未生成，可以先读文字记录。";
  }
}

export function bindGardenJournal(root, read, esc, showTab, onStatus) {
  let state,
    plantId,
    origin,
    returnPage,
    selectedFact,
    cursor,
    entries = [],
    revision = 0,
    digestRevision = 0,
    filters = {};
  let digest,
    digestShown = false,
    loading = false;
  const body = () => root.querySelector("[data-journal-body]");
  const current = () => root.isConnected && body();
  const date = (row) =>
    row.day == null ? "日期未记录" : "第 " + row.day + " 天";
  const actor = (who) =>
    !who
      ? ""
      : state.roles.find((r) => r.id === who.id && r.kind === who.kind)?.name ||
        (who.kind === "admin" ? "管理员" : "当时的伙伴");
  const opt = (value, label, selected) =>
    `<option value="${esc(value)}"${String(value) === String(selected) ? " selected" : ""}>${esc(label)}</option>`;
  const plantLink = (ref, factId) =>
    `<button type="button" class="garden-journal-link" data-journal-plant="${esc(ref.plantId)}" data-journal-fact="${esc(factId)}">${esc(ref.name || state.crops[ref.cropId]?.name || "植株")}手帐 ↗</button>`;
  function fact(row, links) {
    const who = actor(row.actor);
    const refs = links
      ? row.plants.map((ref) => plantLink(ref, row.id)).join(" ")
      : "";
    return `<li data-fact="${esc(row.id)}"><time>${esc(row.time || "时间未记录")}</time> ${who ? esc(who) + " · " : ""}${esc(row.text)} ${refs}</li>`;
  }
  function grouped(links) {
    const days = new Map();
    for (const entry of entries) {
      if (!days.has(entry.day)) days.set(entry.day, []);
      days.get(entry.day).push(entry);
    }
    return [...days.values()]
      .map((rows) => {
        const care = rows.filter((row) =>
          ["water", "fertilize"].includes(row.type),
        );
        const shown = links ? rows.filter((row) => !care.includes(row)) : rows;
        return (
          '<section class="garden-journal-day"><h4>' +
          esc(date(rows[0])) +
          "</h4><ul>" +
          shown.map((r) => fact(r, links)).join("") +
          "</ul>" +
          (links && care.length
            ? "<details><summary>照料记录 · " +
              care.length +
              " 笔</summary><ul>" +
              care.map((r) => fact(r, true)).join("") +
              "</ul></details>"
            : "") +
          "</section>"
        );
      })
      .join("");
  }
  function filterForm() {
    return (
      '<form data-journal-filter class="garden-journal-filters"><label>从第几天<input name="fromDay" type="number" min="1" step="1" placeholder="开园" value="' +
      esc(filters.fromDay) +
      '"></label><label>到第几天<input name="toDay" type="number" min="1" step="1" placeholder="今天" value="' +
      esc(filters.toDay) +
      '"></label>' +
      '<label>地块<select aria-label="地块" name="plot">' +
      opt("", "全部地块", filters.plot) +
      state.plots.map((p) => opt(p.id, p.id + " 号地", filters.plot)).join("") +
      "</select></label>" +
      '<label>记录<select aria-label="记录" name="type">' +
      opt("", "全部记录", filters.type) +
      Object.entries(types)
        .map(([v, l]) => opt(v, l, filters.type))
        .join("") +
      "</select></label>" +
      '<label>伙伴<select aria-label="伙伴" name="actorId">' +
      opt("", "所有人", filters.actorId) +
      state.roles.map((r) => opt(r.id, r.name, filters.actorId)).join("") +
      "</select></label><button>筛选</button></form>"
    );
  }
  async function list(more = false) {
    const target = body();
    if (!target) return;
    const attempt = ++revision;
    loading = true;
    if (!more) {
      entries = [];
      cursor = null;
      target.innerHTML = '<p role="status">正在翻开手帐…</p>';
    }
    try {
      const q = plantId
        ? { view: "plant_history", plantId }
        : { view: "timeline", ...filters };
      const result = await read({
        ...q,
        limit: 40,
        ...(more && cursor ? { cursor } : {}),
      });
      if (revision !== attempt || target !== body()) return;
      entries.push(...result.entries);
      cursor = result.nextCursor;
      const plant = result.plant;
      const highlight =
        plantId && selectedFact
          ? `<aside class="garden-digest">${esc(date(selectedFact))} · ${esc(selectedFact.time)} · ${esc(selectedFact.text)}</aside>`
          : "";
      target.innerHTML =
        (plantId
          ? '<button type="button" data-journal-back>← ' +
            (origin ? "返回花圃" : "返回花园年表") +
            "</button><h3>" +
            esc(plant?.name || "植株") +
            "的手帐</h3>" +
            highlight +
            (plant
              ? "<p>" +
                esc(plant.plot) +
                " 号地" +
                (plant.actor ? " · " + esc(actor(plant.actor)) + "播种" : "") +
                '</p><button type="button" data-journal-card>查看单株花卡</button><div data-journal-image></div>'
              : "")
          : "<h3>花园年表</h3>" + filterForm()) +
        (result.coverage?.partial
          ? '<p class="hint">第 ' +
            esc(result.coverage.fromDay) +
            " 天起完整记录，更早的日期仅列出能核实的事情。</p>"
          : "") +
        (entries.length
          ? grouped(!plantId)
          : "<p>这个范围内没有已记录的变化。</p>") +
        (cursor
          ? '<button type="button" data-journal-more>继续翻页</button>'
          : "");
    } catch {
      if (attempt === revision && current())
        target.innerHTML =
          '<p>暂时读不到记录。</p><button type="button" data-journal-retry>重新读取</button>';
    } finally {
      if (revision === attempt) loading = false;
    }
  }
  async function card() {
    const container = root.querySelector("[data-journal-image]");
    if (!container || !plantId) return;
    await showGardenCard(container, () =>
      read({ view: "plant_image", plantId }),
    );
  }
  function renderDigest() {
    const target = root.querySelector("[data-journal-note]");
    if (!target || !digest) return;
    const label =
      digest.initial && digest.overview
        ? "第 " +
          digest.overview.day +
          " 天 · 已种 " +
          digest.overview.occupied +
          " 株，成熟 " +
          digest.overview.mature +
          " 株。"
        : "";
    target.hidden = !digest.entries.length && !label;
    target.innerHTML =
      "<strong>回园便笺</strong> " +
      esc(label) +
      digest.entries
        .map(
          (r) =>
            esc(actor(r.actor) ? actor(r.actor) + " · " : "") +
            esc(r.text) +
            (r.plants.length ? " " + plantLink(r.plants[0], r.id) : ""),
        )
        .join("；") +
      ' <button type="button" class="garden-journal-link" data-garden-tab="records">翻开年表 ↗</button>';
    if (!digestShown && target.getClientRects().length && !document.hidden) {
      digestShown = true;
      void read({ view: "ack", through: digest.through }).catch(() => {
        digestShown = false;
      });
    }
  }
  root.addEventListener("click", (event) => {
    const b = event.target.closest("button");
    if (!state || !b) return;
    if (b.dataset.journalPlant) {
      if (!plantId)
        origin = b.closest('[data-garden-pane="board"]') ? "board" : null;
      // Keep the original nodes to restore the same filtered page and expanded day.
      if (!origin && !plantId) {
        returnPage = {
          nodes: [...body().childNodes],
          entries,
          cursor,
          button: b,
        };
      }
      selectedFact = [...entries, ...(digest?.entries || [])].find(
        (r) => r.id === Number(b.dataset.journalFact),
      );
      plantId = b.dataset.journalPlant;
      showTab("records");
      void list();
    } else if (b.hasAttribute("data-journal-back")) {
      plantId = null;
      const tab = origin;
      origin = null;
      selectedFact = null;
      if (tab) {
        showTab(tab);
        root
          .querySelector("[data-garden-inspector] [data-journal-plant]")
          ?.focus();
      } else if (returnPage) {
        revision++;
        loading = false;
        entries = returnPage.entries;
        cursor = returnPage.cursor;
        body().replaceChildren(...returnPage.nodes);
        returnPage.button.focus();
        returnPage = null;
      } else void list();
    } else if (b.hasAttribute("data-journal-more") && !loading) void list(true);
    else if (b.hasAttribute("data-journal-retry")) void list();
    else if (b.hasAttribute("data-journal-card")) void card();
    else if (b.dataset.gardenTab === "records") {
      plantId = null;
      origin = null;
      selectedFact = null;
      returnPage = null;
      void list();
    } else if (b.dataset.gardenTab === "board") queueMicrotask(renderDigest);
  });
  root.addEventListener("submit", (event) => {
    if (!event.target.matches("[data-journal-filter]")) return;
    event.preventDefault();
    const values = Object.fromEntries(
      [...new FormData(event.target)].filter(([, v]) => v !== ""),
    );
    for (const key of ["plot", "fromDay", "toDay"])
      if (values[key]) values[key] = Number(values[key]);
    if (values.fromDay && values.toDay && values.fromDay > values.toDay) {
      onStatus?.("起始日期应早于或等于截止日期。");
      return;
    }
    filters = values;
    void list();
  });
  return {
    draw(next, tab) {
      state = next;
      if (tab === "records") void list();
      const attempt = ++digestRevision;
      void read({ view: "digest" })
        .then((value) => {
          if (attempt !== digestRevision || !current()) return;
          digest = value;
          digestShown = false;
          renderDigest();
        })
        .catch(() => {});
    },
    clear() {
      revision++;
      digestRevision++;
      state = null;
      plantId = null;
      origin = null;
      selectedFact = null;
      returnPage = null;
      cursor = null;
      entries = [];
      digest = null;
      filters = {};
      digestShown = false;
    },
  };
}
