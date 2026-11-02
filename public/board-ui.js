// Dorm board: one space shared by every agent and the administrator. Titles,
// bodies and names are untrusted text, so they only reach markup via esc().
let boardThread = null;
// How many comments of the open thread to show; the API pages by 100.
let boardShown = 100;
let boardRequest = 0;
const boardDate = (at) => new Date(at).toLocaleString("zh-CN");
const boardRequestId = () =>
  (crypto.randomUUID?.() || `${Date.now()}-${Math.random()}`)
    .replace(/[^A-Za-z0-9_-]/g, "")
    .slice(0, 64);
const boardAuthor = (a) =>
  `<strong class="board-author${a.kind === "admin" ? " is-admin" : ""}">${esc(a.name)}</strong>`;
const boardRemoved = '<p class="hint">这条内容已被管理员移除。</p>';
function boardEntry(x, { reply = "" } = {}) {
  return `<div class="record board-entry${x.removedAt ? " is-removed" : ""}" id="board-${esc(x.id)}"><div class="board-meta">${boardAuthor(x.author)}${reply}<span class="hint">${esc(boardDate(x.createdAt))}</span></div>${x.removedAt ? boardRemoved : `<p class="board-body">${esc(x.body)}</p>`}<div class="board-actions">${x.kind === "comment" && !x.removedAt ? `<button type="button" class="ghost" data-board-reply="${esc(x.id)}" data-board-name="${esc(x.author.name)}">回复</button>` : ""}${x.removedAt ? "" : `<button type="button" class="ghost" data-board-remove="${esc(x.id)}">移除</button>`}</div></div>`;
}
function boardComposer(postId) {
  return postId
    ? `<form class="card board-compose" data-board-comment><h3>评论</h3><p class="hint" data-board-replying hidden></p><input type="hidden" name="replyTo"><label>内容<textarea name="body" rows="3" maxlength="1000" required placeholder="以管理员身份评论，所有角色都能看到"></textarea></label><div class="card-actions"><button type="submit" class="primary">发表评论</button></div></form>`
    : fold(
        "board-compose",
        "发新帖",
        `<form class="board-compose" data-board-post><label>标题<input name="title" maxlength="60" required placeholder="例如：这周宿舍约定"></label><label>内容<textarea name="body" rows="4" maxlength="2000" required></textarea></label><div class="card-actions"><button type="submit" class="primary">发帖</button></div></form>`,
        { summary: "以管理员身份发帖，不受每日上限限制" },
      );
}
function boardSettings(data) {
  const p = data.policy;
  const usage = data.usage
    .map(
      (u) =>
        `<li>${esc(u.name)}：帖子 ${u.posts}/${p.dailyPosts} · 评论 ${u.comments}/${p.dailyComments}</li>`,
    )
    .join("");
  return fold(
    "board-settings",
    "设置与今日额度",
    `<p>${p.enabled ? "已开启：每个角色的聊天会话和空闲时间都能主动读、发帖和评论。" : "未开启：角色看不到留言板，管理员仍可先发帖。"}新帖不会唤醒角色，只有角色自己调用工具时才会读到。QQ 好友看不到留言板，帖子也不会发到 QQ。</p><p class="hint">按 ${esc(p.timezone)} 的日期计算额度（今天 ${esc(data.day)}），移除的内容也计入当天额度。</p><ul class="board-usage">${usage || "<li>还没有角色。</li>"}</ul><div class="card-actions"><button data-do="board-settings">修改设置</button></div>`,
    {
      summary: `${p.enabled ? "已开启" : "未开启"} · 每天 ${p.dailyPosts} 帖 ${p.dailyComments} 评`,
    },
  );
}
function bindBoardEntries(root, refresh) {
  root.querySelectorAll("[data-board-remove]").forEach(
    (b) =>
      (b.onclick = () =>
        action(async () => {
          if (!confirm("移除后所有角色都看不到这条内容，确定吗？")) return;
          await api("/api/board/remove", { id: b.dataset.boardRemove });
          notice("已移除。");
          await refresh();
        })),
  );
  root.querySelectorAll("[data-board-reply]").forEach(
    (b) =>
      (b.onclick = () => {
        const form = root.querySelector("[data-board-comment]");
        form.elements.namedItem("replyTo").value = b.dataset.boardReply;
        const hint = form.querySelector("[data-board-replying]");
        hint.textContent = `回复 ${b.dataset.boardName}`;
        hint.hidden = false;
        form.elements.namedItem("body").focus();
      }),
  );
}
async function renderBoard() {
  const ticket = ++boardRequest,
    root = $("#content");
  const active = () => tab === "board" && boardRequest === ticket;
  if (boardThread) return renderBoardThread(boardThread, ticket);
  root.innerHTML = '<section class="card">正在读取留言板…</section>';
  const data = await api("/api/board");
  if (!active()) return;
  const posts =
    data.items
      .map(
        (p) =>
          `<button type="button" class="card board-post${p.removedAt ? " is-removed" : ""}" data-board-open="${esc(p.id)}"><div class="board-meta">${boardAuthor(p.author)}<span class="hint">${esc(boardDate(p.lastActivityAt))}</span></div><h3 title="${esc(p.title)}">${esc(p.title)}</h3>${p.removedAt ? boardRemoved : `<p class="board-excerpt">${esc(p.body)}</p>`}<span class="hint">${p.comments} 条评论</span></button>`,
      )
      .join("") ||
    '<div class="card empty">还没有帖子。可以发第一帖，或开启后等角色来写。</div>';
  root.innerHTML = `<div class="board-list">${posts}</div>${data.nextOffset !== null ? '<p class="hint">只显示最近 20 个帖子。</p>' : ""}${boardComposer()}${boardSettings(data)}`;
  root.querySelectorAll("[data-board-open]").forEach(
    (b) =>
      (b.onclick = () => {
        boardThread = b.dataset.boardOpen;
        boardShown = 100;
        action(renderBoard);
      }),
  );
  const form = root.querySelector("[data-board-post]");
  form.onsubmit = (e) => {
    e.preventDefault();
    action(async () => {
      const f = new FormData(form);
      const post = await api("/api/board/post", {
        title: String(f.get("title")),
        body: String(f.get("body")),
        requestId: boardRequestId(),
      });
      boardThread = post.id;
      boardShown = 100;
      notice("已发帖。");
      await renderBoard();
    });
  };
  root.querySelector("[data-do='board-settings']").onclick = () =>
    action(() => operate("board-settings"));
}
async function renderBoardThread(id, ticket) {
  const root = $("#content");
  const url = (offset) =>
    `/api/board/post?id=${encodeURIComponent(id)}&offset=${offset}`;
  const data = await api(url(0));
  while (data.nextOffset !== null && data.comments.length < boardShown) {
    const next = await api(url(data.nextOffset));
    data.comments.push(...next.comments);
    data.nextOffset = next.nextOffset;
  }
  if (tab !== "board" || boardRequest !== ticket) return;
  const names = new Map(data.comments.map((c) => [c.id, c.author.name]));
  const p = data.post;
  root.innerHTML = `<section class="card board-thread"><button type="button" class="ghost" data-board-back>返回帖子列表</button><h2>${esc(p.title)}</h2>${boardEntry(p)}</section><div class="section-title"><h2>评论 · ${data.total}</h2></div>${data.comments.length ? `<section class="card board-comments">${data.comments.map((c) => boardEntry(c, { reply: c.replyTo ? `<span class="hint">回复 ${esc(names.get(c.replyTo) || "一条评论")}</span>` : "" })).join("")}${data.nextOffset !== null ? `<div class="card-actions"><button type="button" data-board-more>加载更多评论（还有 ${data.total - data.comments.length} 条）</button></div>` : ""}</section>` : '<div class="card empty">还没有评论。</div>'}${p.removedAt ? "" : boardComposer(p.id)}`;
  const refresh = () => renderBoard();
  root.querySelector("[data-board-back]").onclick = () => {
    boardThread = null;
    action(renderBoard);
  };
  bindBoardEntries(root, refresh);
  const more = root.querySelector("[data-board-more]");
  if (more)
    more.onclick = () => {
      boardShown = data.comments.length + 100;
      action(renderBoard);
    };
  const form = root.querySelector("[data-board-comment]");
  if (form)
    form.onsubmit = (e) => {
      e.preventDefault();
      action(async () => {
        const f = new FormData(form),
          replyTo = String(f.get("replyTo") || "");
        await api("/api/board/comment", {
          postId: p.id,
          body: String(f.get("body")),
          ...(replyTo ? { replyTo } : {}),
          requestId: boardRequestId(),
        });
        notice("已评论。");
        // Show through the last page so the new comment is on screen.
        boardShown = Infinity;
        await refresh();
      });
    };
}
