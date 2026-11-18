// @ts-check
import { readFile } from "node:fs/promises";
import {
  gardenArtMarkup,
  gardenIconFile,
  gardenEventArtId,
  gardenIconMarkup,
  gardenLayers,
} from "../../public/garden-art/art.js";
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
    plots,
    text: [heading, ...rows].join("\n"),
    [eventArtwork]: state.event ? gardenEventArtId(state.event) : null,
    [artwork]: state.plots.map((plot) => gardenLayers(plot)),
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
  const files = new Set([
    "paper.webp",
    ...layers.flatMap((plot) => plot.map(({ file }) => file)),
    gardenIconFile("weather", snapshot.weather.kind),
    snapshot.event &&
      gardenIconFile("event", snapshot[eventArtwork] ?? snapshot.event.kind),
  ]);
  const optional = (/** @type {string} */ file) =>
    readArt(file).catch(() => null);
  const images = new Map(
    await Promise.all(
      [...files]
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
  const css =
    (await optional("art.css"))
      ?.toString("utf8")
      .replace(
        'url("./paper.webp")',
        images.get("paper.webp")
          ? `url("${images.get("paper.webp")}")`
          : "none",
      ) ?? "";
  const url = (/** @type {string} */ file) => images.get(file);
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
