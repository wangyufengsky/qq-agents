// @ts-check
import { readFile } from "node:fs/promises";
import {
  gardenArtMarkup,
  gardenIconFile,
  gardenEventArtId,
  gardenIconMarkup,
  gardenLayers,
} from "../../public/garden-art/art.js";
import {
  gardenMachineStage,
  gardenStageAt,
  gardenStageLabel,
} from "../../public/garden-art/stages.js";
import { floodRisk, gardenHours } from "./garden-risks.mjs";
import { DAY, HOUR } from "./garden-rules.mjs";
import { renderOwnedHomeImage } from "./scene-view.mjs";

const artwork = Symbol("gardenSnapshotArtwork");
const eventArtwork = Symbol("gardenEventArtwork");
const artRoot = new URL("../../public/garden-art/", import.meta.url);
const gardenMarkup = `<!doctype html><meta charset="utf-8">
<style>
*{box-sizing:border-box}
body{margin:0;color:#412c1a;font:18px system-ui,sans-serif}
main{padding:20px;background-color:#fff1d7}
header{margin-bottom:14px}
strong{font-weight:700}
p{margin:4px 0 12px}
.grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px}
article{min-height:88px;padding:9px;background:#fef7e7;border:1px solid #af7e4d;border-radius:5px;overflow-wrap:anywhere}
article p{margin:3px 0 0;font-size:17px;line-height:1.35}
[data-stage="mature"]{background:#fff0c7}
[data-stage="withered"]{background:#eee4d4}
[data-risk="critical"]{border-color:#934329}
</style>
<main class="garden-paper"><header><div id="icons"></div><strong>小窝花园</strong><p id="time"></p></header><div class="grid" id="plots"></div></main>`;

/** @typedef {ReturnType<import("./garden-service.mjs").GardenService["snapshot"]>} GardenState */
/** @typedef {{plot:number,name:string,stage:ReturnType<typeof gardenMachineStage>,stageLabel?:string,sheltered:boolean,water?:number,lowWater?:boolean,dormant?:boolean,careMode?:"gentle"|"classic",witheredReason?:"drought"|"flood",risk?:"critical"|"waterlogging"}} VisiblePlot */

/** @param {GardenState} state @param {{running:boolean, now:number}} options */
export function gardenPublicSnapshot(state, { running, now }) {
  /** @type {VisiblePlot[]} */
  const plots = state.plots.map(({ id, plant, sheltered }) => {
    if (!plant) return { plot: id, name: "", stage: "empty", sheltered };
    const milestone = gardenStageAt(plant);
    const stage = gardenMachineStage(milestone);
    const risk = floodRisk(
      plant,
      sheltered,
      state.weather,
      state.event?.kind === "weather_flip"
        ? state.event.targetWeather
        : state.weather,
    );
    return {
      plot: id,
      sheltered,
      ...(risk && { risk }),
      ...(plant.witheredReason && { witheredReason: plant.witheredReason }),
      name: plant.crop.name.trim().split(/\s+/).join(" "),
      stage,
      stageLabel: gardenStageLabel(plant.cropId, milestone),
      ...(plant.status === "growing"
        ? {
            water: Math.floor(plant.water),
            careMode: plant.rules.careMode ?? "classic",
            dormant: plant.rules.careMode === "gentle" && plant.water === 0,
            lowWater: plant.water < plant.rules.lowWater,
          }
        : {}),
    };
  });
  const hours = gardenHours(state.dayRemaining / HOUR);
  const weather = {
    name: state.weather.name.trim().split(/\s+/).join(" "),
    kind: state.weather.kind,
  };
  const event = state.event
    ? {
        name: state.event.name.trim().split(/\s+/).join(" "),
        kind: state.event.kind,
        status: state.event.status,
      }
    : null;
  const heading = `小窝花园 · 第 ${state.day} 天 · ${weather.name} · 本日剩 ${hours} 花园小时${running ? "" : " · 已暂停"}${event ? " · " + event.name + ({ open: "", claimed: "（已领取）", chased: "（已驱赶）", expired: "", missed: "" }[event.status] || "") : ""}`;
  const descriptions = plots.map(
    (p) => `第 ${p.plot} 块：${p.name ? p.name + " · " : ""}${plotCaption(p)}`,
  );
  const rows = [0, 3, 6].map((start) =>
    descriptions.slice(start, start + 3).join("；"),
  );
  return {
    capturedAt: new Date(now).toISOString(),
    day: state.day,
    dayRemainingHours: hours,
    weather,
    ...(event && { event }),
    running,
    nightScene: state.nightScene,
    pollenPairs: state.pollenPairs,
    plots,
    text: [heading, ...rows].join("\n"),
    [eventArtwork]: state.event ? gardenEventArtId(state.event) : null,
    [artwork]: state.plots.map((plot) => gardenLayers(plot)),
  };
}

/** @param {VisiblePlot} plot */
function plotCaption(plot) {
  return [
    plot.stageLabel ?? "空地",
    plot.sheltered ? "有棚" : "露天",
    plot.water === undefined
      ? ""
      : `水分 ${plot.water}${plot.dormant ? "（等水中 · 浇水后继续长）" : plot.lowWater ? "（缺水）" : ""}`,
    plot.witheredReason === "flood"
      ? "积水枯萎"
      : plot.witheredReason === "drought"
        ? "长期缺水"
        : "",
    plot.risk === "critical"
      ? "本日结束前搭棚，否则枯萎"
      : plot.risk
        ? plot.careMode === "gentle"
          ? "暴雨暂停生长，天晴后恢复"
          : "暴雨积水，建议搭棚"
        : "",
  ]
    .filter(Boolean)
    .join(" · ");
}

/** @param {string} file */
function readGardenArt(file) {
  return readFile(new URL(file, artRoot));
}

/** @typedef {ReturnType<typeof gardenPublicSnapshot>} PublicSnapshot */
/** @param {PublicSnapshot} snapshot @param {{signal?:AbortSignal,executablePath?:string, readArt?:(file:string)=>Promise<Buffer>}} [options] */
export async function renderGardenSnapshot(
  snapshot,
  { readArt = readGardenArt, ...options } = {},
) {
  const layers = snapshot[artwork] ?? [];
  const { css, url } = await snapshotArt(readArt, [
    ...layers.flatMap((plot) => plot.map(({ file }) => file)),
    gardenIconFile("weather", snapshot.weather.kind),
    snapshot.event &&
      gardenIconFile("event", snapshot[eventArtwork] ?? snapshot.event.kind),
  ]);
  return renderOwnedHomeImage(
    async (context) => {
      await context.route("**/*", (route) => route.abort());
      const page = await context.newPage();
      await page.setContent(gardenMarkup);
      if (css) await page.addStyleTag({ content: css });
      await page.evaluate(
        async ({ plots, heading, icons }) => {
          const doc = globalThis.document;
          const grid = doc.getElementById("plots");
          const time = doc.getElementById("time");
          if (!grid || !time) throw Error("GARDEN_IMAGE_UNAVAILABLE");
          time.textContent = heading;
          doc.getElementById("icons")?.insertAdjacentHTML("afterbegin", icons);
          for (const plot of plots) {
            const tile = doc.createElement("article");
            tile.className = "garden-paper-tile";
            tile.dataset.stage = plot.stage;
            if (plot.risk) tile.dataset.risk = plot.risk;
            const title = doc.createElement("strong");
            title.textContent = `第 ${plot.plot} 块 ${plot.name}`;
            const stage = doc.createElement("p");
            stage.textContent = plot.caption;
            tile.append(title);
            tile.insertAdjacentHTML("beforeend", plot.art);
            tile.append(stage);
            grid.append(tile);
          }
          await Promise.all(
            Array.from(doc.images, (img) =>
              img.decode().catch(() => img.remove()),
            ),
          );
        },
        {
          plots: snapshot.plots.map((plot, index) => ({
            ...plot,
            caption: plotCaption(plot),
            art: css ? gardenArtMarkup(layers[index] ?? [], url) : "",
          })),
          heading: snapshot.text.split("\n")[0].replace(/^小窝花园 · /, ""),
          icons: css
            ? gardenIconMarkup("weather", snapshot.weather.kind, url) +
              (snapshot.event
                ? gardenIconMarkup(
                    "event",
                    snapshot[eventArtwork] ?? snapshot.event.kind,
                    url,
                  )
                : "")
            : "",
        },
      );
      return page
        .locator("main")
        .screenshot({ type: "png", animations: "disabled", timeout: 10000 });
    },
    { ...options, viewportSize: { width: 720, height: 600 } },
  );
}

/** @param {(file:string)=>Promise<Buffer>} readArt @param {Array<string|null|false|undefined>} files */
async function snapshotArt(readArt, files) {
  const optional = (/** @type {string} */ file) =>
    readArt(file).catch(() => null);
  const images = new Map(
    await Promise.all(
      [...new Set(["paper.webp", ...files])]
        .filter((file) => typeof file === "string")
        .map(async (file) => {
          const data = await optional(file);
          return /** @type {const} */ ([
            file,
            data
              ? "data:image/webp;base64," + data.toString("base64")
              : undefined,
          ]);
        }),
    ),
  );
  const paper = images.get("paper.webp");
  return {
    css:
      (await optional("art.css"))
        ?.toString("utf8")
        .replace('url("./paper.webp")', paper ? `url("${paper}")` : "none") ??
      "",
    url: (/** @type {string} */ file) => images.get(file),
  };
}

/** @param {number} clock */
function gardenTime(clock) {
  const day = Math.floor(clock / DAY) + 1;
  const minute = Math.floor((clock % DAY) / (HOUR / 60));
  const time = [Math.floor(minute / 60), minute % 60]
    .map((part) => String(part).padStart(2, "0"))
    .join(":");
  return { day, minute, time };
}

/** @typedef {ReturnType<import("./garden-service.mjs").GardenService["plantHistory"]>} PlantHistory */

/**
 * Card-ready data always uses a public allowlist, including in the subject turn.
 * @param {GardenState} state
 * @param {PlantHistory} detail Public journal projection.
 * @param {{running:boolean,now:number,plot?:number}} options
 */
export function gardenPlantSnapshot(state, detail, { running, now, plot }) {
  const { day, minute, time } = gardenTime(state.clock);
  const stamp = `第 ${day} 天 ${time}${running ? "" : " · 花园时钟已停"}`;
  const common = {
    capturedAt: new Date(now).toISOString(),
    day,
    minute,
    time,
    running,
  };
  const record = detail.plant;
  if (!record) {
    const empty = plot && !state.plots.find(({ id }) => id === plot)?.plant;
    return {
      ...common,
      plot,
      status: detail.choices.length ? "ambiguous" : empty ? "empty" : "unknown",
      choices: detail.choices.map(({ plantId, plot, plantedClock }) => ({
        plantId,
        plot,
        planted: plantedClock == null ? null : gardenTime(plantedClock),
      })),
      text: detail.choices.length
        ? "同种有多株，请选择地块与播种日。"
        : empty
          ? `第 ${plot} 块地是空地 · ${stamp}`
          : "没有查到这株的记录。",
    };
  }
  plot = record.plot;
  const current = state.plots.find(({ plant }) => plant?.id === record.plantId);
  /** @type {import("./garden-rules.mjs").Plant|null} */
  const plant = current?.plant ?? record.snapshot;
  const archived = record.status === "harvested" || record.status === "cleared";
  const sheltered = current?.sheltered;
  const growing = plant?.status === "growing" && !archived;
  const growth = plant ? Math.min(1, plant.growth / plant.crop.hours) : null;
  const milestone = plant ? gardenStageAt(plant) : null;
  const stage = milestone ? gardenMachineStage(milestone) : undefined;
  const stageLabel =
    (milestone && gardenStageLabel(record.cropId, milestone)) ||
    "此前阶段未记录";
  const label = archived
    ? `${record.status === "harvested" ? "已收成" : "已清理"} · ${stageLabel}`
    : stageLabel;
  const lowWater = !!(growing && plant && plant.water < plant.rules.lowWater);
  const rainPause =
    growing &&
    sheltered === false &&
    state.weather.kind === "storm" &&
    state.weather.outdoorGrowth === 0;
  const noWater = growing && plant && plant.water <= 0;
  const gentle = plant?.rules.careMode === "gentle";
  const dormancy = !!(noWater && gentle);
  const dry =
    noWater && plant && !gentle
      ? `已连续无水 ${gardenHours(plant.dry)} / ${plant.rules.dryHours} 花园小时`
      : null;
  const qualityNames = { ordinary: "普通", fine: "优良", perfect: "完美" };
  const conditions = [
    label,
    ...(growing && plant
      ? [
          `水分 ${Math.floor(plant.water)}${lowWater ? "（缺水）" : ""}`,
          sheltered ? "有棚" : "露天",
          ...(rainPause
            ? ["暴雨暂停生长"]
            : dry
              ? [dry]
              : dormancy
                ? ["等水中 · 浇水后继续长"]
                : []),
        ]
      : []),
    ...(plant?.quality ? [`品质已锁定 · ${qualityNames[plant.quality]}`] : []),
  ];
  const journal = detail.entries.map(
    ({ id, type, day, time, text, plants }) => ({
      id,
      type,
      day,
      time,
      text,
      plants,
    }),
  );
  const milestones = journal
    .filter(({ type }) =>
      [
        "planted",
        "sprouted",
        "developed",
        "mature",
        "harvest",
        "clear",
        "withered",
      ].includes(type),
    )
    .slice(0, 3)
    .reverse();
  const matureClock = detail.entries.find(
    (item) => item.type === "mature" && item.clock !== null,
  )?.clock;
  const mature = matureClock == null ? null : gardenTime(matureClock);
  const matureText = mature ? `第 ${mature.day} 天 ${mature.time}` : null;
  if (matureText) conditions.push(`成熟于${matureText}`);
  const environment = [
    sheltered === undefined ? null : sheltered ? "有棚" : "露天",
    plant ? (gentle ? "安心照料" : "经典照料") : null,
  ]
    .filter(Boolean)
    .join(" · ");
  const cardDetails = [
    ...(plant?.quality ? [["成熟品质", qualityNames[plant.quality]]] : []),
    ...(environment ? [["种植环境", environment]] : []),
    ...(plant?.status === "mature"
      ? [["成熟时刻", matureText ?? "此前时间未记录"]]
      : []),
    ...(growing && plant && growth !== null
      ? [
          ["生长进度", `${Math.floor(growth * 100)}%`],
          ["水分", `${Math.floor(plant.water)}${lowWater ? "（缺水）" : ""}`],
          ...(rainPause
            ? [["照料状态", "暴雨暂停生长"]]
            : dry
              ? [["照料状态", dry]]
              : dormancy
                ? [["照料状态", "等水中 · 浇水后继续长"]]
                : []),
        ]
      : []),
  ];
  const partialHistory =
    record.plantedClock == null ||
    (detail.coverage.partial &&
      record.plantedClock < detail.coverage.fromClock);
  const historyNotice = partialHistory
    ? `可追溯起点为第 ${detail.coverage.fromDay} 天 · 此前时间未记录`
    : null;
  const title = `第 ${plot} 块 · ${record.name}`;
  const snapshotId = `${record.plantId}:${state.clock}:${state.revision}`;
  return {
    ...common,
    name: record.name,
    plantId: record.plantId,
    snapshotId,
    planted:
      record.plantedClock == null ? null : gardenTime(record.plantedClock),
    plot,
    status: record.status,
    archived,
    stage,
    stageLabel,
    ...(growth !== null && { growth, fertilizer: plant?.fertilizer }),
    ...(plant?.quality && { quality: plant.quality }),
    ...(growing &&
      plant && {
        water: Math.floor(plant.water),
        lowWater,
        sheltered,
        dormancy,
        rainPause,
      }),
    conditions,
    cardStage: label,
    cardDetails,
    milestones,
    journal,
    nextCursor: detail.nextCursor,
    coverage: detail.coverage,
    historyNotice,
    text: [title, conditions.join(" · "), stamp, historyNotice]
      .filter(Boolean)
      .join("\n"),
    [artwork]: gardenLayers({
      plant,
      sheltered: sheltered ?? false,
    }),
  };
}

/** @typedef {ReturnType<typeof gardenPlantSnapshot>} PlantSnapshot */
/** @param {PlantSnapshot} snapshot @param {{signal?:AbortSignal,executablePath?:string,readArt?:(file:string)=>Promise<Buffer>}} [options] */
export async function renderGardenPlantSnapshot(
  snapshot,
  { readArt = readGardenArt, ...options } = {},
) {
  if (!("plantId" in snapshot)) throw Error("GARDEN_IMAGE_UNAVAILABLE");
  const layers = snapshot[artwork];
  const { css, url } = await snapshotArt(
    readArt,
    layers.map(({ file }) => file),
  );
  return renderOwnedHomeImage(
    async (context) => {
      await context.route("**/*", (route) => route.abort());
      const page = await context.newPage();
      await page.setContent(`<!doctype html><html lang="zh-CN"><meta charset="utf-8">
        <main class="garden-paper"><header><span></span><h1></h1><p></p></header>
        <section class="plate"><div class="sticker"></div><dl></dl></section>
        <section class="book"><h2>这株花的手帐</h2><ol></ol></section><footer></footer></main>`);
      await page.addStyleTag({
        content:
          css +
          `
        *{box-sizing:border-box}
        body{margin:0;background:#eff0e3;color:#243f32;font:16px/1.5 system-ui,"PingFang SC",sans-serif}
        main.garden-paper{color:#243f32;border:1px solid #a4ae94;border-radius:16px;overflow:hidden;
          background:#fff9e9}
        header{padding:18px 27px 15px;background:#315b4b;color:#fff5db}
        h1,h2{font-family:Georgia,"Songti SC",serif}
        header span{font-size:13px;letter-spacing:.05em;color:#dce1c1}
        h1{margin:3px 0;font-size:34px;line-height:1.25;overflow-wrap:anywhere}
        header p{margin:4px 0 0;color:#f5e7ca;overflow-wrap:anywhere}
        .plate{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);align-items:center;
          gap:18px;padding:12px 26px;background:#eef0db;border-bottom:1px dashed #a9b397}
        .sticker{display:grid;place-items:center;min-height:152px}
        .sticker .garden-art-plot{width:min(100%,180px)}
        .sticker p{margin:0;color:#506448;text-align:center;overflow-wrap:anywhere}
        dl{margin:0;padding:4px 0}
        dt{font-size:13px;color:#506448}
        dd{margin:0 0 5px;font-size:17px;overflow-wrap:anywhere}
        dd:last-child{margin-bottom:0}
        .book{padding:15px 27px 16px}
        h2{margin:0 0 7px;font-size:20px}
        ol{margin:0;padding:0;list-style:none}
        li{display:grid;grid-template-columns:117px minmax(0,1fr);gap:12px;padding:6px 0;
          border-bottom:1px dashed #cfceb6;overflow-wrap:anywhere}
        time{color:#506448;font-size:14px}
        footer{padding:11px 27px;background:#f0ebd8;color:#485c48;font-size:13px}
        `,
      });
      await page.evaluate(
        async ({
          area,
          name,
          art,
          stage,
          details,
          milestones,
          stamp,
          historyNotice,
        }) => {
          const doc = globalThis.document;
          const header = doc.querySelector("header");
          const sticker = doc.querySelector(".sticker");
          const facts = doc.querySelector("dl");
          const list = doc.querySelector("ol");
          const footer = doc.querySelector("footer");
          if (!header || !sticker || !facts || !list || !footer)
            throw Error("GARDEN_IMAGE_UNAVAILABLE");
          header.children[0].textContent = area;
          header.children[1].textContent = name;
          header.children[2].textContent = stage;
          sticker.insertAdjacentHTML("afterbegin", art);
          for (const [key, value] of details) {
            const term = doc.createElement("dt");
            term.textContent = key;
            const description = doc.createElement("dd");
            description.textContent = value;
            facts.append(term, description);
          }
          for (const item of milestones) {
            const entry = doc.createElement("li");
            const time = doc.createElement("time");
            time.textContent =
              item.day == null
                ? "时间未记录"
                : `第 ${item.day} 天 ${item.time}`;
            const note = doc.createElement("span");
            note.textContent = item.text;
            entry.append(time, note);
            list.append(entry);
          }
          if (!milestones.length) list.textContent = "尚无已记录的里程碑";
          footer.textContent = [stamp, historyNotice]
            .filter(Boolean)
            .join(" · ");
          await Promise.all(
            Array.from(doc.images, (img) =>
              img.decode().catch(() => img.remove()),
            ),
          );
          if (!sticker.querySelector(".garden-art-plant")) {
            const fallback = doc.createElement("p");
            fallback.textContent = name + " · " + stage;
            sticker.replaceChildren(fallback);
          }
        },
        {
          area: `小窝花园 / ${String(snapshot.plot).padStart(2, "0")} 号花圃`,
          name: snapshot.name,
          art: css ? gardenArtMarkup(layers, url) : "",
          stage: snapshot.cardStage,
          details: snapshot.cardDetails,
          milestones: snapshot.milestones,
          stamp: `快照于第 ${snapshot.day} 个花园日 ${snapshot.time}${snapshot.running ? "" : " · 花园时钟已停"}`,
          historyNotice: snapshot.historyNotice,
        },
      );
      return page
        .locator("main")
        .screenshot({ type: "png", animations: "disabled", timeout: 10_000 });
    },
    { ...options, viewportSize: { width: 500, height: 660 } },
  );
}
