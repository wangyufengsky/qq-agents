// @ts-check
import { z } from "zod";
import { readFileSync } from "node:fs";

const coordinate = z.strictObject({
  x: z.number().int().min(0).max(14),
  y: z.number().int().min(0).max(14),
});
const state = z.strictObject({
  players: z.array(z.string()).length(2),
  board: z
    .array(z.union([z.literal(0), z.literal(1), z.literal(2)]))
    .length(225),
  turn: z.union([z.literal(0), z.literal(1)]),
  lastMove: coordinate.nullable(),
  resigned: z.union([z.literal(0), z.literal(1)]).nullable(),
});
const outcome = z.strictObject({
  kind: z.enum(["win", "draw"]),
  winners: z.array(z.string()).max(1),
  reasonCode: z.enum(["FIVE_OR_MORE", "BOARD_FULL", "RESIGNED"]),
  details: z.strictObject({}),
});
/** @typedef {z.infer<typeof state>} State */
/** @param {State} current */
function result(current) {
  const win = (
    /** @type {number} */ index,
    /** @type {string} */ reasonCode,
  ) => ({
    kind: "win",
    winners: [current.players[index]],
    reasonCode,
    details: {},
  });
  if (current.resigned !== null) return win(1 - current.resigned, "RESIGNED");
  for (let y = 0; y < 15; y++)
    for (let x = 0; x < 15; x++) {
      const stone = current.board[y * 15 + x];
      if (!stone) continue;
      for (const [dx, dy] of [
        [1, 0],
        [0, 1],
        [1, 1],
        [1, -1],
      ]) {
        const endX = x + 4 * dx,
          endY = y + 4 * dy;
        if (endX < 0 || endX > 14 || endY < 0 || endY > 14) continue;
        if (
          [1, 2, 3, 4].every(
            (step) =>
              current.board[(y + step * dy) * 15 + x + step * dx] === stone,
          )
        )
          return win(stone - 1, "FIVE_OR_MORE");
      }
    }
  return current.board.includes(0)
    ? null
    : { kind: "draw", winners: [], reasonCode: "BOARD_FULL", details: {} };
}
/** @type {import('../core/registry.mjs').Definition} */
export const gomoku = {
  manifest: {
    gameType: "gomoku",
    moduleVersion: "1",
    moduleApiVersion: 1,
    rulesVersion: "1",
    stateSchemaVersion: "1",
    uiVersion: "1",
    capabilities: ["turn-sequential-v1"],
    participants: { min: 2, max: 2, kinds: ["human", "ai"] },
    limits: { action: 1024, state: 4096, view: 4096, random: 0 },
  },
  schemas: {
    options: z.strictObject({}),
    state,
    outcome,
    actions: { "game.place": coordinate, "game.resign": z.strictObject({}) },
    view: z.strictObject({
      board: state.shape.board,
      lastMove: coordinate.nullable(),
      color: z.enum(["black", "white"]),
      turn: z.enum(["black", "white"]).nullable(),
      canAct: z.boolean(),
      result: outcome.nullable(),
    }),
  },
  create(_options, players) {
    return {
      players: players.map((/** @type {any} */ p) => p.participantId),
      board: Array(225).fill(0),
      turn: 0,
      lastMove: null,
      resigned: null,
    };
  },
  applyAction(current, actor, action) {
    if (result(current) || current.players[current.turn] !== actor)
      return { rejected: true };
    if (action.type === "game.resign")
      return { state: { ...current, resigned: current.turn } };
    if (action.type !== "game.place") return { rejected: true };
    // The kernel validates schemas, but the pure module also rejects invalid direct calls.
    const parsed = coordinate.safeParse(action.payload);
    if (!parsed.success) return { rejected: true };
    const { x, y } = parsed.data;
    if (current.board[y * 15 + x]) return { rejected: true };
    const board = [...current.board];
    board[y * 15 + x] = current.turn + 1;
    return {
      state: { ...current, board, turn: 1 - current.turn, lastMove: { x, y } },
    };
  },
  nextActor(current) {
    return result(current) ? null : current.players[current.turn];
  },
  outcome: result,
  projectView(current, viewer) {
    const finished = result(current);
    return {
      board: [...current.board],
      lastMove: current.lastMove,
      color: current.players[0] === viewer.participantId ? "black" : "white",
      turn: finished ? null : current.turn === 0 ? "black" : "white",
      canAct:
        !finished && current.players[current.turn] === viewer.participantId,
      result: finished,
    };
  },
};
/** @param {import('../core/registry.mjs').GameRegistry} registry */
export function registerGomoku(registry) {
  return registry.register(
    gomoku,
    Object.fromEntries(
      [
        ["module.mjs", "./module.mjs"],
        ["page.mjs", "./page.mjs"],
        ["game-gomoku.js", "../../../public/game-gomoku.js"],
        ["game-gomoku.css", "../../../public/game-gomoku.css"],
        ["package-lock.json", "../../../package-lock.json"],
      ].map(([name, file]) => [
        name,
        readFileSync(new URL(file, import.meta.url)),
      ]),
    ),
  );
}
