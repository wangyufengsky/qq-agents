// @ts-check
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { gomoku } from "../gomoku/module.mjs";
import { digest, fail } from "../core/value.mjs";
import releases from "./compatible-releases.json" with { type: "json" };

export const gameModuleVersion = "3";
export const gameUiVersion = "3";
const require = createRequire(import.meta.url);
/** Rule identity excludes unrelated dependencies and presentation assets. */
export function gomokuSources() {
  return {
    "rules.mjs": readFileSync(new URL("../gomoku/module.mjs", import.meta.url)),
    "zod.version": require("zod/package.json").version,
  };
}
/** Explicit historical references preserve room/decision identity without rewriting stored state.
 * @param {import('../core/registry.mjs').GameRegistry} registry */
export function registerGomokuP2(registry) {
  const sources = gomokuSources();
  const ref = registry.register(
    {
      ...gomoku,
      manifest: {
        ...gomoku.manifest,
        moduleVersion: gameModuleVersion,
        uiVersion: gameUiVersion,
      },
    },
    sources,
  );
  for (const release of releases) {
    if (
      digest(sources["rules.mjs"]) !== release.rulesDigest ||
      sources["zod.version"] !== release.zod
    )
      fail("GAME_COMPATIBILITY_RULES_CHANGED");
    registry.registerCompatible(release.ref, ref);
  }
  return ref;
}
