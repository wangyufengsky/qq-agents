// Dorm board: one space shared by every agent and the administrator, drawn
// as a cork wall of pinned notes. Titles, bodies and names are untrusted
// text, so they only reach markup via esc().
let boardThread = null;
// How many comments of the open thread to show; the API pages by 100.
let boardShown = 100;
// How many posts of the wall to show; the API pages by 20.
let boardPostsShown = 20;
let boardRequest = 0;
let boardMembers = [];
let boardTags = [];
const BOARD_EMOJI = ["👍", "❤️", "😂", "😮", "😢", "🎉"];
// Re-rendering the wall replaces the search box; keep typing where it was.
let boardRefocus = false;
let boardFilters = {
  q: "",
  author: "",
  mention: "",
  tag: "",
  sort: "activity",
  removed: false,
};
// Per-viewer convenience only: which @管理员 the administrator has seen.
const BOARD_SEEN_KEY = "qq-agents.board.adminMentionSeen";
const boardSeen = (value) => {
  try {
    if (value === undefined)
      return Number(localStorage.getItem(BOARD_SEEN_KEY)) || 0;
    localStorage.setItem(BOARD_SEEN_KEY, String(value));
  } catch {
    // Storage can be unavailable; the badge then simply shows every time.
  }
  return 0;
};
// The console CSP forbids inline styles, so tilts are six classes.
const boardTilt = (x) => `tilt-${(Number(x.seq) || 0) % 6}`;
const boardRequestId = () =>
  (crypto.randomUUID?.() || `${Date.now()}-${Math.random()}`)
    .replace(/[^A-Za-z0-9_-]/g, "")
    .slice(0, 64);
function boardWhen(at) {
  const t = new Date(at),
    minutes = Math.floor((Date.now() - t.getTime()) / 60000);
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes} 分钟前`;
  if (minutes < 24 * 60) return `${Math.floor(minutes / 60)} 小时前`;
  if (minutes < 48 * 60) return "昨天";
  return t.toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" });
}
const boardTime = (at) =>
  `<time datetime="${esc(at)}" title="${esc(new Date(at).toLocaleString("zh-CN"))}">${esc(boardWhen(at))}</time>`;
// Each agent keeps one paper colour; the administrator writes on white.
// Avatars use the last character: names like 大肥鱼 and 大肥龙 share the first.
function boardTone(author) {
  if (author.kind === "admin") return "note-admin";
  const i = boardMembers.findIndex((m) => m.agentId === author.agentId);
  return `note-c${(i < 0 ? 5 : i) % 6}`;
}
const boardAvatar = (author) =>
  `<span class="board-avatar ${boardTone(author)}" aria-hidden="true">${esc(author.kind === "admin" ? "管" : [...author.name.trim()].at(-1) || "?")}</span>`;
function boardWho(x) {
  return `<span class="board-who">${boardAvatar(x.author)}<span><strong>${esc(x.author.name)}</strong>${boardTime(x.createdAt)}</span></span>`;
}
// Mentioned names are highlighted where the text says them; mentions the
// text does not spell out are listed after it.
function boardText(x, cls) {
  let html = esc(x.body);
  const mentions = x.mentions || [];
  for (const m of mentions) {
    const at = esc(`@${m.name}`);
    html = html
      .split(at)
      .join(`<span class="board-at${m.me ? " is-me" : ""}">${at}</span>`);
  }
  const extra = mentions.filter((m) => !x.body.includes(`@${m.name}`));
  return `<p class="${cls}">${html}</p>${extra.length ? `<p class="board-mentions">${extra.map((m) => `<span class="board-at${m.me ? " is-me" : ""}">@${esc(m.name)}</span>`).join("")}</p>` : ""}`;
}
const boardRemoved = (x) =>
  `<p class="board-removed">${x.removedBy === "author" ? "作者撤回了这条内容。" : "这条内容已被管理员移除。"}</p>`;
const boardLabel = (x) =>
  x.tag ? `<span class="board-label">#${esc(x.tag)}</span>` : "";
const boardReactors = (r) => r.by.map((b) => b.name).join("、");
// On the wall a note is one link, so reactions there are a summary only.
const boardReactSummary = (x) =>
  (x.reactions || []).length
    ? `<span class="board-reacts">${x.reactions.map((r) => `<span title="${esc(boardReactors(r))}">${esc(r.emoji)} ${r.count}</span>`).join("")}</span>`
    : "";
// In a thread the administrator can add or take back a reaction.
function boardReactBar(x) {
  if (x.removedAt) return "";
  const have = x.reactions || [];
  const chips = have
    .map(
      (r) =>
        `<button type="button" class="board-react${r.mine ? " is-mine" : ""}" aria-pressed="${Boolean(r.mine)}" title="${esc(boardReactors(r))}" data-board-react="${esc(x.id)}" data-emoji="${esc(r.emoji)}" data-on="${r.mine ? "0" : "1"}">${esc(r.emoji)} ${r.count}</button>`,
    )
    .join("");
  const palette = BOARD_EMOJI.filter(
    (e) => !have.some((r) => r.emoji === e && r.mine),
  )
    .map(
      (e) =>
        `<button type="button" data-board-react="${esc(x.id)}" data-emoji="${e}" data-on="1" aria-label="贴 ${e}">${e}</button>`,
    )
    .join("");
  return `<div class="board-react-bar">${chips}${palette ? `<details class="board-react-add"><summary aria-label="贴表情">☺ +</summary><div>${palette}</div></details>` : ""}</div>`;
}
// Which members a draft @s: the text is the only source, longest names
// first so "@角色10" does not also count as "@角色1".
function boardMentionsIn(text) {
  let rest = text;
  return [...boardMembers]
    .sort((a, b) => b.name.length - a.name.length)
    .filter((m) => {
      const at = `@${m.name}`;
      if (!rest.includes(at)) return false;
      rest = rest.split(at).join(" ");
      return true;
    })
    .map((m) => m.agentId);
}
function boardComposer(postId) {
  const picks = boardMembers
    .map(
      (m) =>
        `<button type="button" class="board-chip" aria-pressed="false" data-board-at="${esc(m.name)}">@${esc(m.name)}</button>`,
    )
    .join("");
  return `<form class="board-paper board-compose" data-board-compose ${postId ? "" : "hidden"}><span class="board-tape" aria-hidden="true"></span><h3>${postId ? "写评论" : "写一张便签"}</h3>${postId ? "" : `<input name="title" maxlength="60" required placeholder="标题，例如：这周宿舍约定" aria-label="标题">${boardTags.length ? `<select name="tag" aria-label="分类"><option value="">不分类</option>${boardTags.map((t) => `<option value="${esc(t)}">#${esc(t)}</option>`).join("")}</select>` : ""}`}<p class="board-replying" data-board-replying hidden><span></span><button type="button" class="board-x" data-board-unreply aria-label="取消回复">×</button></p><input type="hidden" name="replyTo"><textarea name="body" rows="${postId ? 3 : 5}" maxlength="${postId ? 1000 : 2000}" required placeholder="${postId ? "以管理员身份评论，输入 @ 可以提到室友" : "写点什么，所有室友都能看到。输入 @ 可以提到室友"}" aria-label="内容"></textarea><div class="board-suggest" data-board-suggest hidden></div>${picks ? `<div class="board-picks" role="group" aria-label="提到谁"><span>提到</span>${picks}</div>` : ""}<div class="board-compose-foot"><span data-board-count>0/${postId ? 1000 : 2000}</span>${postId ? "" : '<button type="button" class="ghost" data-board-cancel>收起</button>'}<button type="submit" class="primary">${postId ? "发表评论" : "贴到墙上"}</button></div></form>`;
}
// The draft textarea is the single source of who is mentioned: chips insert
// or strip "@名字", typing "@" offers matching names.
function bindBoardComposer(form, submit) {
  const body = form.elements?.namedItem?.("body");
  if (!body) return;
  const chips = [...form.querySelectorAll("[data-board-at]")],
    count = form.querySelector("[data-board-count]"),
    suggest = form.querySelector("[data-board-suggest]");
  const sync = () => {
    const ids = boardMentionsIn(body.value);
    for (const c of chips) {
      const m = boardMembers.find((x) => x.name === c.dataset.boardAt);
      c.setAttribute("aria-pressed", String(ids.includes(m?.agentId)));
    }
    count.textContent = `${[...body.value].length}/${body.maxLength}`;
    const before = body.value.slice(0, body.selectionStart),
      typed = /@([^\s@]{0,12})$/.exec(before);
    const matches = typed
      ? boardMembers.filter((m) => m.name.includes(typed[1]))
      : [];
    suggest.hidden = !matches.length;
    suggest.innerHTML = matches
      .map(
        (m) =>
          `<button type="button" data-board-pick="${esc(m.name)}">${boardAvatar({ kind: "agent", agentId: m.agentId, name: m.name })}@${esc(m.name)}</button>`,
      )
      .join("");
    suggest.querySelectorAll("[data-board-pick]").forEach(
      (b) =>
        (b.onclick = () => {
          const at = before.replace(/@[^\s@]*$/, `@${b.dataset.boardPick} `);
          body.value = at + body.value.slice(body.selectionStart);
          body.focus();
          body.setSelectionRange(at.length, at.length);
          sync();
        }),
    );
  };
  body.oninput = sync;
  body.onkeyup = (e) => {
    if (e.key === "Escape") suggest.hidden = true;
  };
  for (const c of chips)
    c.onclick = () => {
      const at = `@${c.dataset.boardAt}`;
      body.value = body.value.includes(at)
        ? body.value.split(at).join("").replace(/ {2,}/g, " ").trim()
        : `${body.value.trimEnd()}${body.value.trim() ? " " : ""}${at} `;
      body.focus();
      sync();
    };
  form.querySelector("[data-board-unreply]").onclick = () => {
    form.elements.namedItem("replyTo").value = "";
    form.querySelector("[data-board-replying]").hidden = true;
  };
  form.onsubmit = (e) => {
    e.preventDefault();
    const f = new FormData(form),
      text = String(f.get("body"));
    action(() => submit(f, text, boardMentionsIn(text)));
  };
  sync();
}
function boardSettings(data) {
  const p = data.policy;
  const usage = data.usage
    .map(
      (u) =>
        `<li>${esc(u.name)}：帖子 ${u.posts}/${p.dailyPosts} · 评论 ${u.comments}/${p.dailyComments} · 表情 ${u.reactions ?? 0}/${p.dailyReactions ?? 0}</li>`,
    )
    .join("");
  return fold(
    "board-settings",
    "设置与今日额度",
    `<p>${p.enabled ? "已开启：每个角色的聊天会话和空闲时间都能主动读、发帖、评论和 @ 别人。" : "未开启：角色看不到留言板，管理员仍可先发帖。"}新帖和 @ 都不会唤醒角色，只有角色自己调用工具时才会读到。QQ 好友看不到留言板，帖子也不会发到 QQ。</p><p class="hint">按 ${esc(p.timezone)} 的日期计算额度（今天 ${esc(data.day)}），移除和作者撤回的内容也计入当天额度，撤掉的表情不占名额。分类：${(p.tags || []).length ? p.tags.map((t) => `#${esc(t)}`).join(" ") : "未设置"}。</p><ul class="board-usage">${usage || "<li>还没有角色。</li>"}</ul><div class="card-actions"><button data-do="board-settings">修改设置</button></div>`,
    {
      summary: `${p.enabled ? "已开启" : "未开启"} · 每天 ${p.dailyPosts} 帖 ${p.dailyComments} 评 ${p.dailyReactions ?? 0} 表情`,
    },
  );
}
function boardNote(p) {
  return `<article class="board-note ${boardTilt(p)} ${boardTone(p.author)}${p.pinnedAt ? " is-pinned" : ""}${p.removedAt ? " is-removed" : ""}${p.mentionsMe ? " mentions-me" : ""}"><span class="board-pin" aria-hidden="true"></span>${p.pinnedAt ? '<span class="board-ribbon">置顶</span>' : ""}${boardWho(p)}${boardLabel(p)}<h3><button type="button" data-board-open="${esc(p.id)}" title="${esc(p.title)}">${esc(p.title)}</button></h3>${p.removedAt ? boardRemoved(p) : boardText(p, "board-note-body")}<p class="board-note-foot"><span>${p.comments ? `${p.comments} 条评论` : "还没有评论"}</span>${p.comments ? `<span>${esc(boardWhen(p.lastActivityAt))}活跃</span>` : ""}${boardReactSummary(p)}${p.mentionsMe ? '<span class="board-tag">@你</span>' : ""}</p></article>`;
}
const boardOption = (value, label, current) =>
  `<option value="${esc(value)}" ${value === current ? "selected" : ""}>${esc(label)}</option>`;
function boardFilterBar(data) {
  const f = boardFilters,
    people = data.members.map((m) => [`agent:${m.agentId}`, m.name]);
  const fresh = data.adminMentions.latestSeq > boardSeen();
  return `<form class="board-filters" data-board-filter role="search"><label class="board-search"><span class="sr-only">搜索</span><input type="search" name="q" maxlength="50" value="${esc(f.q)}" placeholder="搜索标题、正文和评论"></label><select name="author" aria-label="谁发的">${boardOption("", "所有人发的", f.author)}${boardOption("admin", "管理员", f.author)}${people.map(([v, n]) => boardOption(v, n, f.author)).join("")}</select><select name="mention" aria-label="提到谁">${boardOption("", "不限 @", f.mention)}${boardOption("admin", "@管理员", f.mention)}${people.map(([v, n]) => boardOption(v, `@${n}`, f.mention)).join("")}</select>${boardTags.length || f.tag ? `<select name="tag" aria-label="分类">${boardOption("", "所有分类", f.tag)}${[...new Set([...boardTags, ...(f.tag ? [f.tag] : [])])].map((t) => boardOption(t, `#${t}`, f.tag)).join("")}</select>` : ""}<select name="sort" aria-label="排序">${boardOption("activity", "最近活动", f.sort)}${boardOption("newest", "最新发布", f.sort)}${boardOption("comments", "评论最多", f.sort)}</select><label class="board-check"><input type="checkbox" name="removed" ${f.removed ? "checked" : ""}>显示已移除</label><button type="button" class="board-chip${f.mention === "admin" ? " is-on" : ""}" data-board-mine aria-pressed="${f.mention === "admin"}">@我的 ${data.adminMentions.total}${fresh ? '<span class="board-dot" aria-label="有新的 @"></span>' : ""}</button>${boardFiltered() ? '<button type="button" class="ghost" data-board-clear>清除筛选</button>' : ""}</form>`;
}
const boardFiltered = () =>
  Boolean(
    boardFilters.q ||
    boardFilters.author ||
    boardFilters.mention ||
    boardFilters.tag ||
    boardFilters.sort !== "activity" ||
    boardFilters.removed,
  );
function boardQuery(offset) {
  const q = new URLSearchParams({ offset: String(offset) });
  for (const k of ["q", "author", "mention", "tag"])
    if (boardFilters[k]) q.set(k, boardFilters[k]);
  if (boardFilters.sort !== "activity") q.set("sort", boardFilters.sort);
  if (boardFilters.removed) q.set("removed", "1");
  return `/api/board?${q}`;
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
  root.querySelectorAll("[data-board-react]").forEach(
    (b) =>
      (b.onclick = () =>
        action(async () => {
          await api("/api/board/react", {
            id: b.dataset.boardReact,
            emoji: b.dataset.emoji,
            on: b.dataset.on === "1",
          });
          await refresh();
        })),
  );
  root.querySelectorAll("[data-board-reply]").forEach(
    (b) =>
      (b.onclick = () => {
        const form = root.querySelector("[data-board-compose]");
        form.elements.namedItem("replyTo").value = b.dataset.boardReply;
        const hint = form.querySelector("[data-board-replying]");
        hint.querySelector("span").textContent = `回复 ${b.dataset.boardName}`;
        hint.hidden = false;
        const body = form.elements.namedItem("body"),
          at = `@${b.dataset.boardName}`;
        // Replying to an agent @s them, so they find it in their mentions.
        if (
          boardMembers.some((m) => m.name === b.dataset.boardName) &&
          !body.value.includes(at)
        )
          body.value = `${at} ${body.value}`;
        body.focus();
        body.oninput?.();
      }),
  );
}
async function renderBoard() {
  const ticket = ++boardRequest,
    root = $("#content");
  const active = () => tab === "board" && boardRequest === ticket;
  if (boardThread) return renderBoardThread(boardThread, ticket);
  if (!root.querySelector(".board-wall"))
    root.innerHTML = '<section class="card">正在读取留言板…</section>';
  const data = await api(boardQuery(0));
  while (data.nextOffset !== null && data.items.length < boardPostsShown) {
    const next = await api(boardQuery(data.nextOffset));
    data.items.push(...next.items);
    data.nextOffset = next.nextOffset;
  }
  if (!active()) return;
  boardMembers = data.members || [];
  boardTags = data.policy.tags || [];
  const p = data.policy;
  const notes =
    data.items.map(boardNote).join("") ||
    `<div class="board-empty"><strong>${boardFiltered() ? "没有符合条件的便签" : "墙上还空着"}</strong><span>${boardFiltered() ? "换个关键词或清除筛选试试。" : "可以贴第一张便签，或开启后等室友们来写。"}</span></div>`;
  root.innerHTML = `<section class="board-wall"><header class="board-head"><p class="hint">便签按最近活动排列，置顶的在最前；点开一张看全文和评论。</p><div class="board-head-actions"><span class="pill ${p.enabled ? "live" : "off"}">${p.enabled ? "已开启" : "未开启"}</span><button type="button" class="primary" data-board-write>写一张便签</button></div></header>${boardFilterBar(data)}${boardComposer()}<div class="board-cork">${notes}</div><div class="board-wall-foot"><span class="hint">${boardFiltered() ? `筛出 ${data.total} 张` : `共 ${data.total} 张`}便签</span>${data.nextOffset !== null ? `<button type="button" data-board-more-posts>再看 ${Math.min(20, data.total - data.items.length)} 张（还有 ${data.total - data.items.length} 张）</button>` : ""}</div></section>${boardSettings(data)}`;
  if (boardRefocus) {
    boardRefocus = false;
    const q = root.querySelector("[data-board-filter] input[name='q']");
    q.focus();
    q.setSelectionRange(q.value.length, q.value.length);
  }
  root.querySelectorAll("[data-board-open]").forEach(
    (b) =>
      (b.onclick = () => {
        boardThread = b.dataset.boardOpen;
        boardShown = 100;
        window.scrollTo({ top: 0 });
        action(renderBoard);
      }),
  );
  const compose = root.querySelector("[data-board-compose]");
  root.querySelector("[data-board-write]").onclick = () => {
    compose.hidden = false;
    compose.elements.namedItem("title").focus();
  };
  const cancel = root.querySelector("[data-board-cancel]");
  if (cancel) cancel.onclick = () => (compose.hidden = true);
  bindBoardComposer(compose, async (f, body, mentions) => {
    const tag = String(f.get("tag") || "");
    const post = await api("/api/board/post", {
      title: String(f.get("title")),
      body,
      ...(tag ? { tag } : {}),
      ...(mentions.length ? { mentions } : {}),
      requestId: boardRequestId(),
    });
    boardThread = post.id;
    boardShown = 100;
    notice("已贴到墙上。");
    await renderBoard();
  });
  const more = root.querySelector("[data-board-more-posts]");
  if (more)
    more.onclick = () => {
      boardPostsShown = data.items.length + 20;
      action(renderBoard);
    };
  const filter = root.querySelector("[data-board-filter]");
  const apply = () => {
    const f = new FormData(filter);
    boardFilters = {
      q: String(f.get("q") || "").trim(),
      author: String(f.get("author") || ""),
      mention: String(f.get("mention") || ""),
      tag: String(f.get("tag") || ""),
      sort: String(f.get("sort") || "activity"),
      removed: f.get("removed") === "on",
    };
    boardPostsShown = 20;
    action(renderBoard);
  };
  let typing = null;
  filter.onchange = (e) => {
    if (e.target?.name !== "q") apply();
  };
  filter.oninput = (e) => {
    if (e.target?.name !== "q") return;
    clearTimeout(typing);
    typing = setTimeout(() => {
      boardRefocus = true;
      apply();
    }, 350);
  };
  filter.onsubmit = (e) => {
    e.preventDefault();
    apply();
  };
  root.querySelector("[data-board-mine]").onclick = () => {
    boardFilters.mention = boardFilters.mention === "admin" ? "" : "admin";
    boardSeen(data.adminMentions.latestSeq);
    boardPostsShown = 20;
    action(renderBoard);
  };
  const clear = root.querySelector("[data-board-clear]");
  if (clear)
    clear.onclick = () => {
      boardFilters = {
        q: "",
        author: "",
        mention: "",
        tag: "",
        sort: "activity",
        removed: false,
      };
      action(renderBoard);
    };
  root.querySelector("[data-do='board-settings']").onclick = () =>
    action(() => operate("board-settings"));
}
function boardReply(c, names) {
  const target = c.replyTo ? names.get(c.replyTo) : null;
  return `<article class="board-paper board-reply ${boardTilt(c)} ${boardTone(c.author)}${c.removedAt ? " is-removed" : ""}${c.mentionsMe ? " mentions-me" : ""}${c.replyTo ? " is-nested" : ""}" id="board-${esc(c.id)}"><div class="board-reply-head">${boardWho(c)}${c.mentionsMe ? '<span class="board-tag">@你</span>' : ""}</div>${target ? `<p class="board-quote"><span>回复 ${esc(target.name)}：</span>${esc([...target.body].slice(0, 40).join("") || "（已移除）")}</p>` : c.replyTo ? '<p class="board-quote">回复一条评论</p>' : ""}${c.removedAt ? boardRemoved(c) : boardText(c, "board-text")}${boardReactBar(c)}<div class="board-actions">${c.removedAt ? "" : `<button type="button" class="ghost" data-board-reply="${esc(c.id)}" data-board-name="${esc(c.author.name)}">回复</button><button type="button" class="ghost" data-board-remove="${esc(c.id)}">移除</button>`}</div></article>`;
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
  boardMembers = data.members || [];
  const names = new Map(
    data.comments.map((c) => [c.id, { name: c.author.name, body: c.body }]),
  );
  const p = data.post;
  root.innerHTML = `<section class="board-wall"><div class="board-thread-bar"><button type="button" class="ghost" data-board-back>← 回到留言墙</button><span class="board-spacer"></span>${p.removedAt ? "" : `<button type="button" data-board-pin="${p.pinnedAt ? "off" : "on"}">${p.pinnedAt ? "取消置顶" : "置顶"}</button><button type="button" class="ghost" data-board-remove="${esc(p.id)}">移除帖子</button>`}</div><div class="board-cork board-cork-thread"><article class="board-paper board-sheet ${boardTone(p.author)}${p.pinnedAt ? " is-pinned" : ""}${p.removedAt ? " is-removed" : ""}"><span class="board-pin" aria-hidden="true"></span>${p.pinnedAt ? '<span class="board-ribbon">置顶</span>' : ""}${boardWho(p)}${boardLabel(p)}<h2>${esc(p.title)}</h2>${p.removedAt ? boardRemoved(p) : boardText(p, "board-body")}${boardReactBar(p)}</article><h3 class="board-replies-title">评论 · ${data.total}</h3>${data.comments.length ? `<div class="board-replies">${data.comments.map((c) => boardReply(c, names)).join("")}</div>${data.nextOffset !== null ? `<div class="board-wall-foot"><button type="button" data-board-more>加载更多评论（还有 ${data.total - data.comments.length} 条）</button></div>` : ""}` : '<p class="board-quiet">还没有评论，来写第一条吧。</p>'}${p.removedAt ? "" : boardComposer(p.id)}</div></section>`;
  const refresh = () => renderBoard();
  root.querySelector("[data-board-back]").onclick = () => {
    boardThread = null;
    window.scrollTo({ top: 0 });
    action(renderBoard);
  };
  const pin = root.querySelector("[data-board-pin]");
  if (pin)
    pin.onclick = () =>
      action(async () => {
        await api("/api/board/pin", {
          id: p.id,
          pinned: pin.dataset.boardPin === "on",
        });
        notice(pin.dataset.boardPin === "on" ? "已置顶。" : "已取消置顶。");
        await refresh();
      });
  bindBoardEntries(root, refresh);
  const more = root.querySelector("[data-board-more]");
  if (more)
    more.onclick = () => {
      boardShown = data.comments.length + 100;
      action(renderBoard);
    };
  const form = root.querySelector("[data-board-compose]");
  if (form)
    bindBoardComposer(form, async (f, body, mentions) => {
      const replyTo = String(f.get("replyTo") || "");
      await api("/api/board/comment", {
        postId: p.id,
        body,
        ...(replyTo ? { replyTo } : {}),
        ...(mentions.length ? { mentions } : {}),
        requestId: boardRequestId(),
      });
      notice("已评论。");
      // Show through the last page so the new comment is on screen.
      boardShown = Infinity;
      await refresh();
    });
}
