// @ts-check
import { readFileSync } from "node:fs";
import { gomoku } from "../gomoku/module.mjs";
/** UI v2 adds genuine source confirmation while preserving the published v1 bundle. @param {import('../core/registry.mjs').GameRegistry} registry */
export function registerGomokuP2(registry) {
  return registry.register(
    {
      ...gomoku,
      manifest: { ...gomoku.manifest, moduleVersion: "2", uiVersion: "2" },
    },
    Object.fromEntries(
      [
        ["rules.mjs", "../gomoku/module.mjs"],
        ["module.mjs", "./module.mjs"],
        ["page.mjs", "./page.mjs"],
        ["game-play.js", "../../../public/game-play.js"],
        ["game-play.css", "../../../public/game-play.css"],
        ["package-lock.json", "../../../package-lock.json"],
      ].map(([key, file]) => [
        key,
        readFileSync(new URL(file, import.meta.url)),
      ]),
    ),
  );
}
