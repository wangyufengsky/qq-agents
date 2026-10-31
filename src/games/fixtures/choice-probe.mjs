// @ts-check
import { z } from "zod";
import { readFileSync } from "node:fs";

const symbol = z.enum(["sun", "moon"]);
const state = z.strictObject({
  players: z.array(z.string()).length(2),
  choices: z.array(symbol.nullable()).length(2),
});
const outcome = z.strictObject({
  kind: z.enum(["win", "loss"]),
  winners: z.array(z.string()).max(2),
  reasonCode: z.enum(["MATCHED", "DIFFERENT"]),
  details: z.strictObject({}),
});
/** @type {import('../core/registry.mjs').Definition} */
export const choiceProbe = {
  manifest: {
    gameType: "choice-probe",
    moduleVersion: "1",
    moduleApiVersion: 1,
    rulesVersion: "1",
    stateSchemaVersion: "1",
    uiVersion: "1",
    capabilities: [
      "turn-sequential-v1",
      "private-values-v1",
      "shared-outcome-v1",
    ],
    participants: { min: 2, max: 2, kinds: ["human", "ai"] },
    limits: { action: 1024, state: 4096, view: 4096, random: 0 },
  },
  schemas: {
    options: z.strictObject({}),
    state,
    outcome,
    actions: { "game.choose": z.strictObject({ symbol }) },
    view: z.strictObject({
      ownChoice: symbol.nullable(),
      revealed: z.array(symbol).length(2).nullable(),
      canChoose: z.boolean(),
      result: outcome.nullable(),
    }),
  },
  create(_options, players) {
    return {
      players: players.map((/** @type {any} */ p) => p.participantId),
      choices: [null, null],
    };
  },
  applyAction(current, actor, action) {
    const index = current.players.indexOf(actor);
    if (
      action.type !== "game.choose" ||
      index !== current.choices.indexOf(null)
    )
      return { rejected: true };
    const choices = [...current.choices];
    choices[index] = action.payload.symbol;
    return { state: { ...current, choices } };
  },
  nextActor(current) {
    const index = current.choices.indexOf(null);
    return index < 0 ? null : current.players[index];
  },
  outcome: result,
  projectView(current, viewer) {
    const index = current.players.indexOf(viewer.participantId),
      done = !current.choices.includes(null);
    return {
      ownChoice: current.choices[index],
      revealed: done ? [...current.choices] : null,
      canChoose: !done && current.choices.indexOf(null) === index,
      result: result(current),
    };
  },
};
/** @param {any} current */
function result(current) {
  if (current.choices.includes(null)) return null;
  const matched = current.choices[0] === current.choices[1];
  return {
    kind: matched ? "win" : "loss",
    winners: matched ? [...current.players] : [],
    reasonCode: matched ? "MATCHED" : "DIFFERENT",
    details: {},
  };
}
/** @param {import('../core/registry.mjs').GameRegistry} registry */
export function registerChoiceProbe(registry) {
  return registry.register(choiceProbe, {
    "package-lock.json": readFileSync(
      new URL("../../../package-lock.json", import.meta.url),
    ),
    "choice-probe.mjs": readFileSync(
      new URL("./choice-probe.mjs", import.meta.url),
    ),
    "game-p1a.js": readFileSync(
      new URL("../../../public/game-p1a.js", import.meta.url),
    ),
    "game-p1a.css": readFileSync(
      new URL("../../../public/game-p1a.css", import.meta.url),
    ),
  });
}
