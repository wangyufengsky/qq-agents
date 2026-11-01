// @ts-check
/** Derived exclusively from a participant's public projection, never authoritative state.
 * @param {{board:number[],color?:string,lastMove?:{x:number,y:number}|null}|null} view */
export function describeGomokuView(view) {
  if (!view || view.board.length !== 225) return null;
  const columns = "ABCDEFGHIJKLMNO".split("");
  const board = Array.from({ length: 15 }, (_, y) =>
    view.board.slice(y * 15, (y + 1) * 15),
  );
  return {
    coordinates:
      "列 A–O 对应 x=0–14；行 1–15 对应 y=0–14。board[y][x]：0 空位，1 黑子，2 白子；文本中 . 为空位，X 为黑子，O 为白子。",
    ownColor:
      view.color === "black"
        ? "黑子 X"
        : view.color === "white"
          ? "白子 O"
          : null,
    lastMove: view.lastMove
      ? `${columns[view.lastMove.x]}${view.lastMove.y + 1} (x=${view.lastMove.x}, y=${view.lastMove.y})`
      : null,
    text: [
      "   " + columns.join(" "),
      ...board.map(
        (row, y) =>
          String(y + 1).padStart(2, " ") +
          " " +
          row.map((stone) => [".", "X", "O"][stone]).join(" "),
      ),
    ].join("\n"),
    board,
  };
}
