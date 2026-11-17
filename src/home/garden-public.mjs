// @ts-check
import { floodRisk, gardenHours } from "./garden-risks.mjs";
import { HOUR } from "./garden-rules.mjs";
import { renderOwnedHomeImage } from "./scene-view.mjs";

const stageLabels = {
  empty: "空地",
  seedling: "幼苗",
  growing: "生长中",
  mature: "已成熟",
  withered: "已枯萎",
};
const gardenMarkup = `<!doctype html><meta charset="utf-8">
<style>
*{box-sizing:border-box}
body{margin:0;background:#fff;color:#1f2923;font:18px system-ui,sans-serif}
main{padding:20px}
p{margin:4px 0 12px}
.grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px}
article{min-height:88px;padding:8px;border:1px solid #819185;border-radius:6px;overflow-wrap:anywhere}
article p{margin:2px 0}
[data-stage="growing"],[data-stage="seedling"]{background:#e7f4e8}
[data-stage="mature"]{background:#fff2cc}
[data-stage="withered"]{background:#eee4dc}
</style>
<main><strong>小窝花园</strong><p id="time"></p><div class="grid" id="plots"></div></main>`;

/** @typedef {ReturnType<import("./garden-service.mjs").GardenService["snapshot"]>} GardenState */
/** @typedef {{plot:number,name:string,stage:keyof typeof stageLabels,sheltered:boolean,water?:number,lowWater?:boolean,witheredReason?:"drought"|"flood",risk?:"critical"|"waterlogging"}} VisiblePlot */

/** @param {GardenState} state @param {{running:boolean, now:number}} options */
export function gardenPublicSnapshot(state, { running, now }) {
  /** @type {VisiblePlot[]} */
  const plots = state.plots.map(({ id, plant, sheltered }) => {
    if (!plant) return { plot: id, name: "", stage: "empty", sheltered };
    const stage =
      plant.status === "growing" && plant.growth / plant.crop.hours < 0.25
        ? "seedling"
        : plant.status;
    const risk = floodRisk(plant, sheltered, state.weather);
    return {
      plot: id,
      sheltered,
      ...(risk && { risk }),
      ...(plant.witheredReason && { witheredReason: plant.witheredReason }),
      name: plant.crop.name.trim().split(/\s+/).join(" "),
      stage,
      ...(plant.status === "growing"
        ? {
            water: Math.floor(plant.water),
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
  const heading = `小窝花园 · 第 ${state.day} 天 · ${weather.name} · 本日剩 ${hours} 花园小时${running ? "" : " · 已暂停"}`;
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
    running,
    plots,
    text: [heading, ...rows].join("\n"),
  };
}

/** @param {VisiblePlot} plot */
function plotCaption(plot) {
  return [
    stageLabels[plot.stage],
    plot.sheltered ? "有棚" : "露天",
    plot.water === undefined
      ? ""
      : `水分 ${plot.water}${plot.lowWater ? "（缺水）" : ""}`,
    plot.witheredReason === "flood"
      ? "积水枯萎"
      : plot.witheredReason === "drought"
        ? "长期缺水"
        : "",
    plot.risk === "critical"
      ? "本日结束前搭棚，否则枯萎"
      : plot.risk
        ? "暴雨积水，建议搭棚"
        : "",
  ]
    .filter(Boolean)
    .join(" · ");
}

/** @typedef {ReturnType<typeof gardenPublicSnapshot>} PublicSnapshot */
/** @param {PublicSnapshot} snapshot @param {{signal?:AbortSignal,executablePath?:string}} [options] */
export function renderGardenSnapshot(snapshot, options = {}) {
  return renderOwnedHomeImage(
    async (context) => {
      await context.route("**/*", (route) => route.abort());
      const page = await context.newPage();
      await page.setContent(gardenMarkup);
      await page.evaluate(
        ({ plots, heading }) => {
          const doc = globalThis.document;
          const grid = doc.getElementById("plots");
          const time = doc.getElementById("time");
          if (!grid || !time) throw Error("GARDEN_IMAGE_UNAVAILABLE");
          time.textContent = heading;
          for (const plot of plots) {
            const tile = doc.createElement("article");
            tile.dataset.stage = plot.stage;
            const title = doc.createElement("strong");
            title.textContent = `第 ${plot.plot} 块 ${plot.name}`;
            const stage = doc.createElement("p");
            stage.textContent = plot.caption;
            tile.append(title, stage);
            grid.append(tile);
          }
        },
        {
          plots: snapshot.plots.map((plot) => ({
            ...plot,
            caption: plotCaption(plot),
          })),
          heading: snapshot.text.split("\n")[0],
        },
      );
      return page
        .locator("main")
        .screenshot({ type: "png", animations: "disabled", timeout: 10000 });
    },
    { ...options, viewportSize: { width: 720, height: 600 } },
  );
}
