// @ts-check
import { escapeHtml } from "../core/http.mjs";

const columns = "ABCDEFGHIJKLMNO";
const stars = new Set([48, 56, 112, 168, 176]);
/** Grid lines, star points and coordinates are SVG attributes because the game CSP forbids inline styles. */
const boardLines = (() => {
  const at = (/** @type {number} */ i) => i * 10 + 5;
  const lines = Array.from(
    { length: 15 },
    (_, i) =>
      `<line x1="5" y1="${at(i)}" x2="145" y2="${at(i)}"/><line x1="${at(i)}" y1="5" x2="${at(i)}" y2="145"/>`,
  ).join("");
  const dots = [...stars]
    .map(
      (i) =>
        `<circle cx="${at(i % 15)}" cy="${at(Math.floor(i / 15))}" r="1.3"/>`,
    )
    .join("");
  const labels = Array.from(
    { length: 15 },
    (_, i) =>
      `<text x="${at(i)}" y="-1.6">${columns[i]}</text><text x="-2.6" y="${at(i) + 1.4}">${i + 1}</text>`,
  ).join("");
  return `<svg class="lines" viewBox="0 0 150 150" aria-hidden="true" focusable="false"><g class="grid-lines">${lines}</g><g class="stars">${dots}</g><g class="coords">${labels}</g></svg>`;
})();

/** Opponent identity comes from the roster label and the hash-addressed avatar path, never a QQ account.
 * @param {any|null} snapshot */
function opponent(snapshot) {
  const other = snapshot?.participants?.find(
    (/** @type {any} */ p) => p.participantId !== snapshot.viewer,
  );
  const name = other?.label || "AI 对手";
  const avatar =
    (other && snapshot?.presentation?.avatars?.[other.participantId]) || "";
  return {
    name,
    initial: Array.from(name)[0] || "AI",
    avatar: /^\/avatars\/[a-f0-9]{32}\.(?:jpg|png|gif|webp)$/.test(avatar)
      ? avatar
      : "",
  };
}

/** @param {any|null} snapshot @param {string} roomId */
export function renderGame(snapshot, roomId) {
  const view = snapshot?.view;
  const cells = Array.from({ length: 225 }, (_, index) => {
    const stone = view?.board[index] || 0;
    const label = `${columns[index % 15]}${Math.floor(index / 15) + 1} ${["空位", "黑子", "白子"][stone]}`;
    return `<button class="pt s${stone}" data-index="${index}" aria-label="${label}" disabled></button>`;
  }).join("");
  const summary = !snapshot
    ? "请确认加入后查看棋局。"
    : snapshot.lifecycle === "finished" && !view?.result
      ? "房主已结束房间，不计胜负。"
      : !view
        ? snapshot.owner
          ? snapshot.readyToStart
            ? "双方已就绪，点击开始对局。"
            : "你是房主，等待对方就绪后开始对局。"
          : "已加入，等待房主开始对局。"
        : view.result
          ? view.result.kind === "draw"
            ? "满盘和棋。"
            : `对局结束：${view.result.winners.includes(snapshot.viewer) ? "你获胜" : "对方获胜"}。`
          : `你执${view.color === "black" ? "黑" : "白"}，当前轮到${view.turn === "black" ? "黑" : "白"}方。`;
  const ai = opponent(snapshot);
  const lifecycle =
    new Map(
      Object.entries({
        waiting: "等待开始",
        active: "对局进行中",
        paused: "已暂停",
        finished: "已结束",
        expired: "已过期",
      }),
    ).get(snapshot?.lifecycle) || "";
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><title>五子棋 · QQ Agents</title><link rel="stylesheet" href="/game-play.css"><script src="/game-play.js" defer></script></head><body><main class="app" data-ui-version="4" data-authenticated="${!!snapshot}" data-room="${escapeHtml(roomId)}"><section class="play"><header class="topbar"><h1>落子有声</h1><p>五子棋 · 黑先 · 无禁手 · 五连获胜</p></header><div class="match" aria-label="对局双方"><div class="side" id="me-side"><span class="avatar me" aria-hidden="true">你<span class="chip" id="me-chip"></span></span><span class="who"><span class="nm">你</span><span class="sub" id="me-sub">玩家</span></span></div><div class="vs" aria-hidden="true"><strong>对</strong><span id="revision">版本 ${snapshot?.revision ?? 0}</span></div><div class="side r" id="ai-side"><span class="avatar" aria-hidden="true"><img id="opponent-avatar" alt="" src="${escapeHtml(ai.avatar)}"${ai.avatar ? "" : " hidden"}><span id="opponent-initial"${ai.avatar ? " hidden" : ""}>${escapeHtml(ai.initial)}</span><span class="chip" id="ai-chip"></span></span><span class="who"><span class="nm" id="opponent-name">${escapeHtml(ai.name)}</span><span class="sub" id="ai-sub">AI 对手</span></span></div></div><div class="say" id="say" hidden><p class="bubble" id="say-text" aria-live="polite"></p></div><p class="status" id="status" role="status" aria-live="polite">${snapshot ? "当前为非实时快照，开启脚本后同步。" : "请点击确认加入。"}</p><section class="dock" id="join-panel"${snapshot ? " hidden" : ""} aria-label="加入对局"><h2>三步加入对局</h2><ol class="steps"><li>点击“确认加入”，生成本浏览器的确认口令。</li><li>私聊原 QQ 角色发送下方口令；群游戏也须私聊。</li><li>输入 QQ 回执中的 8 位验证码，继续加入。</li></ol><button id="join" class="btn primary big"${snapshot ? " hidden" : ""}>确认加入</button><p id="binding" class="phrase" hidden></p><label id="code-label" class="code" hidden>QQ 回执中的 8 位验证码 <input id="binding-code" inputmode="numeric" autocomplete="one-time-code" maxlength="8"></label><button id="exchange" class="btn primary" hidden>已在 QQ 确认，继续加入</button></section><p id="identity" class="identity">${snapshot ? "已验证原 QQ 身份 · 仅本浏览器有效" : "尚未验证身份 · 请在本人网页完成 QQ 双端确认"}</p><section id="game" class="game"${snapshot ? "" : " hidden"}><div class="board">${boardLines}<div id="board" class="grid" role="group" aria-label="十五乘十五棋盘">${cells}</div></div><section class="dock" aria-label="当前操作"><div class="dock-head"><h2 id="summary">${escapeHtml(summary)}</h2><span class="tag" id="lifecycle">${escapeHtml(lifecycle)}</span></div><p id="ai-status" role="status"></p><p id="selection" aria-live="polite">点棋盘选位，在放大区核对后落子。</p><div id="zoom" class="loupe" role="group" aria-label="局部放大"></div><div class="row"><button id="confirm" class="btn primary big" disabled>落子</button><button id="cancel" class="btn" disabled>取消</button></div><div class="row"><button id="retry" class="btn" hidden>查询待确认操作</button><button id="ai-retry" class="btn" hidden>请 AI 重试</button></div><div class="row" id="controls"></div></section></section></section><aside class="panel"><section class="card"><div class="card-head"><h3>对手说的话</h3><button id="mute" class="mute" type="button" aria-pressed="false">不看台词</button></div><ol id="remarks" class="chatlog"></ol><p class="hint" id="remarks-empty">对手落子时说的话会显示在这里。</p></section><details class="card"><summary>对局操作</summary><p id="resign-help">自己的回合可认输；房主结束房间不计作对手获胜。</p><div class="row"><button id="resign" class="btn danger" disabled>我要认输</button><button id="confirm-resign" class="btn danger" hidden>确认认输</button><button id="cancel-resign" class="btn" hidden>取消认输</button></div></details><details class="card"><summary>规则</summary><p>15×15 棋盘，黑方先行，无禁手。横、竖、斜任一方向连成五子或以上即获胜；满盘无人连五为和棋。</p></details></aside><noscript><p>脚本关闭时仅显示有权查看的快照，不能提交。<a href="/rooms/${escapeHtml(roomId)}">刷新快照</a></p></noscript></main></body></html>`;
}
