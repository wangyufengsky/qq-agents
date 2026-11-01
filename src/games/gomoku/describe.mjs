// @ts-check
/** Derived exclusively from a participant's public projection, never authoritative state.
 * @param {{board:number[]}|null} view */
export function describeGomokuView(view) {
  if (!view || view.board.length !== 225) return null;
  return {
    coordinates:
      "x 为列，y 为行，均从 0 到 14；board[y][x]：0 空位，1 黑子，2 白子。",
    board: Array.from({ length: 15 }, (_, y) =>
      view.board.slice(y * 15, (y + 1) * 15),
    ),
  };
}
