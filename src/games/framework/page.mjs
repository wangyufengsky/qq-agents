// @ts-check
import { escapeHtml } from "../core/http.mjs";
/** @param {any|null} snapshot @param {string} roomId */
export function renderGame(snapshot, roomId) {
  const view = snapshot?.view;
  const cells = Array.from({ length: 225 }, (_, index) => {
    const stone = view?.board[index] || 0;
    const label = `${String.fromCharCode(65 + (index % 15))}${Math.floor(index / 15) + 1} ${["空位", "黑子", "白子"][stone]}`;
    return `<button class="cell stone-${stone}" data-index="${index}" aria-label="${label}" disabled>${["·", "●", "○"][stone]}</button>`;
  }).join("");
  const summary = !snapshot
    ? "请确认加入后查看棋局。"
    : snapshot.lifecycle === "finished" && !view?.result
      ? "房主已结束房间，不计胜负。"
      : !view
        ? "等待双方加入，房主开始。"
        : view.result
          ? view.result.kind === "draw"
            ? "满盘和棋。"
            : `对局结束：${view.result.winners.includes(snapshot.viewer) ? "你获胜" : "对方获胜"}。`
          : `你执${view.color === "black" ? "黑" : "白"}，当前轮到${view.turn === "black" ? "黑" : "白"}方。`;
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>五子棋 · QQ Agents</title><link rel="stylesheet" href="/game-play.css"><script src="/game-play.js" defer></script></head><body><main data-authenticated="${!!snapshot}" data-room="${escapeHtml(roomId)}"><header><p class="eyebrow">QQ AGENTS / GAME LAB</p><h1>落子有声</h1><p>五子棋 · 黑先 · 无禁手 · 五连及以上获胜</p></header><p class="notice">先在网页申请加入，再到原 QQ 会话发送下方确认口令。</p><p id="status" role="status" aria-live="polite">${snapshot ? "当前为非实时快照，开启脚本后同步。" : "请点击确认加入。"}</p><button id="join" ${snapshot ? "hidden" : ""}>确认加入</button><p id="binding" class="notice" hidden></p><button id="exchange" hidden>已在 QQ 确认，继续加入</button><p id="ai-status" role="status"></p><section id="game" ${snapshot ? "" : "hidden"}><div class="heading"><h2 id="summary">${escapeHtml(summary)}</h2><span id="revision">版本 ${snapshot?.revision ?? 0}</span></div><p id="lifecycle">${escapeHtml(snapshot?.lifecycle ?? "")}</p><div id="board" role="group" aria-label="十五乘十五棋盘">${cells}</div><section class="preview" aria-label="落点预览"><p id="selection" aria-live="polite">先点棋盘选位，再在放大区域核对，最后确认落点。</p><div id="zoom" role="group" aria-label="局部放大"></div><div class="controls"><button id="confirm" disabled>确认落点</button><button id="cancel" disabled>取消选择</button><button id="retry" hidden>查询待确认操作</button></div></section><details><summary>对局操作</summary><div class="controls" id="controls"></div><p>自己的回合可认输；房主结束房间不计作对手获胜。</p><button id="resign" disabled>我要认输</button><button id="confirm-resign" hidden>确认认输</button><button id="cancel-resign" hidden>取消认输</button></details></section><noscript><p>脚本关闭时仅显示有权查看的快照，不能提交。<a href="/rooms/${escapeHtml(roomId)}">刷新快照</a></p></noscript></main></body></html>`;
}
