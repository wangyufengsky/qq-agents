const transcriptSelection = new Map();
let transcriptScope =
  new URLSearchParams(location.search).get("scope") === "subject"
    ? "subject"
    : "chat";
const transcriptBackends = {
  codex: "Codex",
  antigravity: "Antigravity",
  dsh: "DSH",
};
const transcriptStatuses = {
  sent: ["已送达", "live"],
  "completed-no-send": ["已完成 · 未发送", ""],
  failed: ["回合失败", "warn"],
  cancelled: ["已取消", ""],
  interrupted: ["已中断", "warn"],
  running: ["进行中", "accent"],
  recorded: ["已记录", ""],
};
const transcriptTime = new Intl.DateTimeFormat("zh-CN", {
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});
const transcriptAt = (at) => (at ? transcriptTime.format(at) : "时间未记录");

function transcriptText(item) {
  return `<div class="transcript-text">${esc(item.text)}</div>${item.clipped ? '<p class="hint transcript-clipped">长文本已截断</p>' : ""}`;
}

function transcriptStep(item) {
  const label = {
    input: "模型输入",
    thinking: "思考",
    summary: "思考摘要",
  }[item.kind];
  if (label)
    return `<details class="transcript-fold transcript-${item.kind}">
      <summary><span>${label}</span><time>${esc(transcriptAt(item.at))}</time></summary>
      <div class="transcript-fold-body">${transcriptText(item)}</div>
    </details>`;
  if (item.kind === "output")
    return `<div class="transcript-output"><span class="transcript-label">模型输出</span>${transcriptText(item)}</div>`;
  if (item.kind === "tool" || item.kind === "tool-error")
    return `<div class="transcript-tool${item.kind === "tool-error" ? " is-error" : ""}">${icon("terminal", "sm")}<span>${item.kind === "tool-error" ? "工具异常" : "工具调用"}</span><code>${esc(item.text)}</code></div>`;
  return "";
}

function transcriptSteps(steps, errors) {
  const rows = [];
  let process = [];
  const flush = () => {
    if (!process.length) return;
    rows.push(`<details class="transcript-fold transcript-process" open>
      <summary><span>回合过程</span><small>${process.length} 步</small></summary>
      <div class="transcript-process-body">${process.join("")}</div>
    </details>`);
    process = [];
  };
  for (const step of steps) {
    if (step.kind === "input" || step.kind === "output") {
      flush();
      rows.push(transcriptStep(step));
    } else process.push(transcriptStep(step));
  }
  for (const code of errors)
    process.push(
      `<div class="transcript-tool is-error">${icon("terminal", "sm")}<span>桥接拒绝或失败</span><code>${esc(code)}</code></div>`,
    );
  flush();
  return rows.join("");
}

function transcriptTurn(turn, subject) {
  const [label, tone] =
    subject && turn.status === "completed-no-send"
      ? ["已完成", ""]
      : transcriptStatuses[turn.status] || transcriptStatuses.recorded;
  const elapsed =
    turn.endedAt > turn.startedAt
      ? `${((turn.endedAt - turn.startedAt) / 1000).toFixed(1)} 秒`
      : "";
  const usage = turn.usage
    ? `<span>${turn.usage.measured ? "上下文" : "估算上下文"} · ${Number(turn.usage.contextTokens).toLocaleString("zh-CN")} tokens</span>`
    : "";
  return `<article class="transcript-turn">
    <header class="transcript-turn-head">
      <div>${tag(label, tone)}${elapsed ? `<span class="transcript-duration">${esc(elapsed)}</span>` : ""}</div>
      <time>${esc(transcriptAt(turn.startedAt))}</time>
    </header>
    <div class="transcript-steps">
      ${transcriptSteps(turn.steps, turn.errors)}
      ${turn.delivered.map((item) => `<div class="transcript-delivered"><div><span class="dot live" aria-hidden="true"></span><strong>QQ 已确认送达</strong><time>${esc(transcriptAt(item.at))}</time></div>${transcriptText(item)}</div>`).join("")}
    </div>
    ${usage ? `<footer class="transcript-turn-foot">${usage}</footer>` : ""}
  </article>`;
}

const transcriptLabel = (item) =>
  item.scope === "subject" ? "主人格" : conversationLabel(item.conversation);

function transcriptCatalogMarkup(sessions, selection, query) {
  const search = query.trim().toLocaleLowerCase();
  const shown = sessions.filter((item) =>
    `${transcriptLabel(item)} ${transcriptBackends[item.backend] || item.backend}`
      .toLocaleLowerCase()
      .includes(search),
  );
  if (!shown.length)
    return `<p class="hint transcript-list-empty">${search ? "没有匹配的会话。" : "还没有本机会话记录。"}</p>`;
  return [true, false]
    .map((active) => {
      const rows = shown.filter((item) => item.current === active);
      if (!rows.length) return "";
      return `<div class="transcript-list-group"><h3>${active ? "当前会话" : "历史会话"}</h3>
        ${rows
          .map(
            (
              item,
            ) => `<button type="button" class="transcript-option" data-transcript-key="${esc(item.key)}"${item.key === selection ? ' aria-current="true"' : ""}>
          <span class="transcript-option-title">${esc(transcriptLabel(item))}</span>
          <span class="transcript-option-meta"><span>${esc(transcriptBackends[item.backend] || item.backend)} · ${item.count} 轮</span><time>${esc(transcriptAt(item.at))}</time></span>
        </button>`,
          )
          .join("")}
      </div>`;
    })
    .join("");
}

function renderTranscripts() {
  const content = $("#content");
  const agentId = roleId;
  if (!agentId) {
    content.innerHTML =
      '<p class="hint">添加角色后，这里会显示它的本机会话。</p>';
    return;
  }
  content.innerHTML = `<div class="transcript-workspace">
    <section class="transcript-library" aria-label="会话列表">
      <div class="transcript-library-head"><h2>会话列表</h2><button type="button" class="ghost transcript-refresh" data-refresh-transcripts>刷新</button></div>
      <div class="transcript-scopes" role="group" aria-label="会话类型">
        <button type="button" data-transcript-scope="chat" aria-pressed="${transcriptScope === "chat"}">QQ 聊天</button>
        <button type="button" data-transcript-scope="subject" aria-pressed="${transcriptScope === "subject"}">主人格</button>
      </div>
      <label class="transcript-search"><span>搜索会话</span><input type="search" placeholder="${transcriptScope === "subject" ? "后端名称" : "群号、QQ 号或后端"}" data-transcript-search /></label>
      <div class="transcript-list" data-transcript-list aria-live="polite"><p class="hint transcript-list-empty">正在读取会话列表…</p></div>
    </section>
    <section class="transcript-reader" aria-label="会话记录">
      <div class="transcript-reader-head">
        <div><h2 data-transcript-title>会话记录</h2><p class="hint" data-transcript-subtitle></p></div>
        <button type="button" class="ghost transcript-latest" data-transcript-latest hidden>回到最新</button>
      </div>
      <div class="transcript-feed" data-transcript-feed tabindex="0" aria-label="回合时间线">
        <p class="hint transcript-state" data-transcript-state role="status"></p>
        <div class="transcript-older" data-transcript-older hidden><button type="button" class="ghost">加载更早回合</button></div>
        <div data-transcript-turns></div>
      </div>
    </section>
  </div>`;
  const root = content.querySelector(".transcript-workspace");
  const findPart = (name) => root.querySelector(`[data-transcript-${name}]`);
  const list = findPart("list");
  const search = findPart("search");
  const feed = findPart("feed");
  const state = findPart("state");
  const title = findPart("title");
  const subtitle = findPart("subtitle");
  const turns = findPart("turns");
  const older = findPart("older");
  const earlierButton = older.querySelector("button");
  const latest = findPart("latest");
  const refresh = root.querySelector("[data-refresh-transcripts]");
  const scopeButtons = root.querySelectorAll("[data-transcript-scope]");
  const selectionKey = () => agentId + "/" + transcriptScope;
  const scopedSessions = () =>
    sessions.filter((item) => item.scope === transcriptScope);
  const turnMarkup = (turn) =>
    transcriptTurn(turn, transcriptScope === "subject");
  const frameworkRecords = () =>
    transcriptScope === "subject" ? "框架保存的回合" : "框架保存的回合与投递";
  let sessions = [];
  let key = transcriptSelection.get(selectionKey());
  let next = null;
  let generation = 0;
  const current = () =>
    root.isConnected && tab === "transcripts" && roleId === agentId;
  const request = (params = {}) =>
    api(
      "/api/session-transcripts?" + new URLSearchParams({ agentId, ...params }),
    );
  const listMarkup = () =>
    (list.innerHTML = transcriptCatalogMarkup(
      scopedSessions(),
      key,
      search.value,
    ));
  const syncScroll = () =>
    (latest.hidden =
      feed.scrollHeight - feed.scrollTop - feed.clientHeight < 80);
  const bottom = () => {
    feed.scrollTop = feed.scrollHeight;
    syncScroll();
  };

  async function show(session) {
    const id = ++generation;
    key = session?.key;
    next = null;
    older.hidden = true;
    latest.hidden = true;
    turns.innerHTML = "";
    title.textContent = session ? transcriptLabel(session) : "会话记录";
    subtitle.textContent = session
      ? `${transcriptBackends[session.backend] || session.backend} · ${session.count} 轮`
      : "";
    state.textContent = session
      ? "正在读取本机会话…"
      : "选择一个会话查看回合。";
    listMarkup();
    if (!session) return;
    transcriptSelection.set(selectionKey(), key);
    try {
      const result = await request({ key });
      if (!current() || id !== generation) return;
      turns.innerHTML = result.turns.map(turnMarkup).join("");
      next = result.nextBefore;
      older.hidden = !next;
      state.textContent = !result.turns.length
        ? "这个会话没有可显示的回合。"
        : result.source === "unavailable"
          ? `此页的原生记录不可读，已显示${frameworkRecords()}。`
          : result.source === "partial"
            ? "此页显示可读取的原生记录，部分内容超出读取范围。"
            : "";
      bottom();
    } catch {
      if (current() && id === generation)
        state.textContent = "读取会话失败。可刷新后重试。";
    }
  }

  function showSelection() {
    const options = scopedSessions();
    return show(options.find((item) => item.key === key) || options[0]);
  }

  async function loadList() {
    const id = ++generation;
    refresh.disabled = true;
    earlierButton.disabled = true;
    for (const button of scopeButtons) button.disabled = true;
    try {
      const result = await request();
      if (!current() || id !== generation) return;
      sessions = result.sessions;
      void showSelection();
    } catch {
      if (current() && id === generation)
        list.innerHTML =
          '<p class="hint transcript-list-empty">读取列表失败。可刷新后重试。</p>';
    } finally {
      if (current()) {
        refresh.disabled = false;
        earlierButton.disabled = false;
        for (const button of scopeButtons) button.disabled = false;
      }
    }
  }

  earlierButton.onclick = async () => {
    if (!next || earlierButton.disabled) return;
    const id = generation;
    earlierButton.disabled = true;
    try {
      const result = await request({ key, before: next });
      if (!current() || id !== generation) return;
      const height = feed.scrollHeight;
      turns.insertAdjacentHTML(
        "afterbegin",
        result.turns.map(turnMarkup).join(""),
      );
      next = result.nextBefore;
      older.hidden = !next;
      feed.scrollTop += feed.scrollHeight - height;
      if (result.source !== "available")
        state.textContent = `部分原生记录不可读，${frameworkRecords()}仍可查看。`;
      syncScroll();
    } catch {
      if (current() && id === generation)
        state.textContent = "加载更早回合失败。可重试。";
    } finally {
      if (current() && id === generation) earlierButton.disabled = false;
    }
  };
  list.onclick = (event) => {
    const button = event.target.closest("[data-transcript-key]");
    const session =
      button &&
      scopedSessions().find(
        (item) => item.key === button.dataset.transcriptKey,
      );
    if (session) {
      earlierButton.disabled = false;
      void show(session);
    }
  };
  for (const button of scopeButtons)
    button.onclick = () => {
      const scope = button.dataset.transcriptScope;
      if (scope === transcriptScope) return;
      transcriptScope = scope;
      for (const option of scopeButtons)
        option.setAttribute("aria-pressed", String(option === button));
      search.value = "";
      search.placeholder =
        scope === "subject" ? "后端名称" : "群号、QQ 号或后端";
      key = transcriptSelection.get(selectionKey());
      earlierButton.disabled = false;
      void showSelection();
    };
  search.oninput = listMarkup;
  refresh.onclick = loadList;
  latest.onclick = bottom;
  feed.onscroll = syncScroll;
  void loadList();
}
