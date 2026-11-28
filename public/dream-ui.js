const dreamModeLabels = {
  nap: "小憩",
  deep: "深度睡眠",
  long: "长梦",
  imaginative: "幻想梦",
};
const dreamTriggerLabels = {
  manual: "手动",
  idle: "空闲",
  "rhythm-sleep": "作息",
  rest: "自主休息",
  threshold: "阈值",
};
const dreamStatusLabels = {
  QUEUED: "排队",
  RUNNING: "运行中",
  VALIDATING: "验证中",
  COMMITTED: "已完成",
  FAILED: "失败",
  CANCELLED: "取消",
  SKIPPED: "跳过",
  RETRY_WAIT: "待重试",
};
const dreamInspirationLabels = {
  home_decor: "纸页小窝布置",
  garden: "花园",
  diary: "日记",
  project: "项目",
  chat_topic: "聊天话题",
  other: "其他",
};
const dreamPendingStatuses = new Set([
  "QUEUED",
  "RUNNING",
  "VALIDATING",
  "RETRY_WAIT",
]);
const dreamEvidenceLabels = {
  observed: "直接观察",
  reported: "转述",
  inferred: "推断",
  subjective: "主观感受",
  planned: "计划",
  disputed: "有争议",
  fictional: "虚构",
};
const dreamCategoryLabels = {
  fact: "事实归纳",
  preference: "稳定偏好",
  world_context: "场景共识",
  topic_thread: "长期主题",
  reflection: "反思",
};

async function renderDreams() {
  const agentId = roleId;
  const content = $("#content");
  if (!agentId) {
    content.textContent = "请先到「角色」添加角色。";
    return;
  }
  content.innerHTML = `<article class="dream-journal" role="tabpanel" id="dream-panel" aria-labelledby="dream-role-${esc(agentId)}">
    <header class="dream-cover"><span class="dream-owner">${icon("moon", "sm")}${esc(find("agents", agentId).name)}</span><h2>月下手记</h2><p id="dream-cover-status" role="status">正在读取…</p></header>
    <div class="dream-spread">
      <section class="dream-column dream-cognitions" aria-labelledby="dream-cognitions-title">
        <div class="dream-heading"><h2 id="dream-cognitions-title">${icon("book")}长期认知</h2><small id="dream-count" aria-live="polite"></small></div>
        <details class="dream-filter" data-fold="dream-filters" ${foldOpen("dream-filters", false) ? "open" : ""}><summary>${icon("filter", "sm")}筛选</summary><form id="dream-filters" class="toolbar">
      <label>类别<select name="category"><option value="">全部类别</option>${Object.entries(
        dreamCategoryLabels,
      )
        .map(
          ([value, name]) =>
            `<option value="${esc(value)}">${esc(name)}</option>`,
        )
        .join("")}</select></label>
      <label>状态<select name="status"><option value="active">有效</option><option value="disputed">有争议</option><option value="archived">已归档</option></select></label>
      <label>作用域<input name="scopeId" placeholder="global 或 group:20000"></label>
      <label>关键词<input name="query" type="search"></label>
      <button type="submit">筛选</button>
    </form></details>
        <div id="dream-list">正在读取…</div><div id="dream-pagination"></div>
      </section>
      <section class="dream-column dream-fiction" aria-labelledby="dream-fiction-title">
        <div class="dream-heading"><h2 id="dream-fiction-title">${icon("moon")}幻想梦境</h2><small id="dream-story-count"></small></div>
        <div id="dream-stories">正在读取…</div>
      </section>
    </div>
    ${fold("dream-recent-runs", `${icon("clock")}最近运行`, '<div id="dream-runs">正在读取…</div>', { cls: "dream-fold", summary: '<span id="dream-run-summary"></span>' })}
    ${fold("dream-settings", `${icon("settings")}梦境设置`, '<div id="dream-overview">正在读取…</div><p id="dream-trigger-status" class="hint" role="status"></p>', { cls: "dream-fold", summary: '<span id="dream-settings-summary"></span>' })}
  </article>`;
  const active = () =>
    tab === "dreams" && roleId === agentId && content.contains(form);
  const form = $("#dream-filters");
  const roleQuery = new URLSearchParams({ agentId });
  const pageSize = 5;
  let currentOffset = 0;
  let listRequest = 0;
  let selectedButton;
  let appliedFilters = new URLSearchParams(new FormData(form));
  let currentRunId;
  async function overview() {
    const data = await api("/api/dreams/overview?" + roleQuery);
    if (!active()) return;
    const blocker =
      data.mode === "isolated"
        ? "隔离模式"
        : data.globalPaused
          ? "全局暂停"
          : data.rolePaused
            ? "角色暂停"
            : data.paused
              ? "梦境暂停"
              : data.busy
                ? "已有梦境待运行或正在运行"
                : data.used >= data.limit
                  ? "今日总预算已用完"
                  : "";
    const imaginativeBlocker =
      blocker ||
      (data.imaginative.used >= data.imaginative.limit
        ? "今日幻想梦配额已用完"
        : "");
    const trackStatus = (profile, reason) =>
      profile.enabled ? reason || "可以运行" : "未开启";
    const duration = (ms) =>
      ms % 60000 === 0 ? `${ms / 60000} 分钟` : `${ms / 1000} 秒`;
    $("#dream-cover-status").innerHTML = [
      `<span class="${data.cognitive.enabled ? "enabled" : ""}">认知梦${data.cognitive.enabled ? "已开启" : "未开启"}</span>`,
      `<span class="${data.imaginative.enabled ? "enabled" : ""}">幻想梦${data.imaginative.enabled ? "已开启" : "未开启"}</span>`,
      blocker ? `<span class="blocked">${esc(blocker)}</span>` : "",
    ].join("");
    $("#dream-settings-summary").innerHTML = [
      `认知梦 ${duration(data.cognitive.timeoutMs)}`,
      `幻想梦 ${duration(data.imaginative.timeoutMs)}`,
      `今日 ${data.used} / ${data.limit} 次`,
      `幻想梦最多 ${data.imaginative.limit} 次`,
    ]
      .map((label) => `<span>${esc(label)}</span>`)
      .join("");
    const backend = (profile) =>
      profile.enabled
        ? ` · 后端 ${esc(profile.backendId || "—")}${profile.dedicated ? "（专用）" : ""}${profile.model ? ` · 模型 ${esc(profile.model)}` : ""}`
        : "";
    $("#dream-overview").innerHTML =
      `<p>今日运行 ${data.used} / ${data.limit}</p>
      <p>认知梦：${esc(trackStatus(data.cognitive, blocker))}${backend(data.cognitive)}</p>
      <p>幻想梦：${esc(trackStatus(data.imaginative, imaginativeBlocker))}${backend(data.imaginative)} · 今日 ${data.imaginative.used} / ${data.imaginative.limit}</p>
      ${data.cognitive.enabled ? `<p>待整理：事件 ${data.lag.events} · 日记 ${data.lag.diaries} · 更正 ${data.lag.corrections}</p>` : ""}
      <div class="card-actions"><button type="button" id="dream-refresh">刷新</button><button type="button" id="dream-pause">${data.paused ? "恢复梦境" : "暂停梦境"}</button>
      <button type="button" data-dream-run="nap" ${!data.cognitive.enabled || blocker ? "disabled" : ""}>立即小憩</button>
      <button type="button" data-dream-run="deep" ${!data.cognitive.enabled || blocker ? "disabled" : ""}>立即深度睡眠</button>
      <button type="button" data-dream-run="long" ${!data.cognitive.enabled || blocker ? "disabled" : ""}>立即做长梦</button>
      <button type="button" data-dream-run="imaginative" ${!data.imaginative.enabled || imaginativeBlocker ? "disabled" : ""}>立即做幻想梦</button></div>`;
    $("#dream-refresh").onclick = () =>
      action(() =>
        Promise.all([overview(), list(currentOffset), stories(), runs()]),
      );
    $("#dream-pause").onclick = () =>
      action(async () => {
        await api("/api/dreams/pause", { agentId, paused: !data.paused });
        await Promise.all([overview(), runs()]);
      });
    content.querySelectorAll("[data-dream-run]").forEach((button) => {
      button.onclick = () =>
        action(async () => {
          const mode = button.dataset.dreamRun;
          const receipt = await api("/api/dreams/trigger", { agentId, mode });
          if (!active()) return;
          currentRunId = receipt.runId;
          showTriggerStatus(mode, receipt.status);
          await refreshRun(receipt.runId);
        });
    });
  }
  async function list(offset = 0) {
    const request = ++listRequest;
    const query = new URLSearchParams({ agentId, offset, limit: pageSize });
    for (const [key, value] of appliedFilters)
      if (typeof value === "string" && value.trim())
        query.set(key, value.trim());
    const data = await api("/api/dreams/cognitions?" + query);
    if (!active() || request !== listRequest) return;
    const pages = Math.max(1, Math.ceil(data.total / pageSize));
    if (offset >= pages * pageSize) return list((pages - 1) * pageSize);
    currentOffset = offset;
    selectedButton = undefined;
    $("#dream-count").textContent = `${data.total} 条`;
    const target = $("#dream-list");
    target.innerHTML = data.items.length
      ? data.items
          .map(
            (row, index) =>
              `<article class="dream-entry"><span class="dream-tag">${esc(dreamCategoryLabels[row.category] || row.category)}</span>
              <p class="dream-thought" title="${esc(row.content)}">${esc(row.content)}</p>
              <p class="hint">${esc(row.scope_id)} · ${esc(dreamEvidenceLabels[row.epistemic_status] || row.epistemic_status)}${row.from_private ? " · 含私聊来源" : ""}</p>
              <button type="button" class="dream-link" data-dream-detail="${index}" aria-expanded="false">证据与版本 <span aria-hidden="true">→</span></button><div class="dream-detail"></div></article>`,
          )
          .join("")
      : '<p class="empty">暂无符合条件的认知。</p>';
    target.querySelectorAll("[data-dream-detail]").forEach((button) => {
      button.onclick = () =>
        action(() =>
          detail(data.items[Number(button.dataset.dreamDetail)], button),
        );
    });
    const pagination = $("#dream-pagination");
    pagination.innerHTML =
      pages > 1
        ? `<div class="dream-pager" role="group" aria-label="长期认知分页">
      <button type="button" id="dream-prev" ${offset === 0 ? "disabled" : ""}>上一页</button>
      <span role="status">第 ${offset / pageSize + 1} / ${pages} 页</span>
      <button type="button" id="dream-next" ${data.nextOffset === null ? "disabled" : ""}>下一页</button></div>`
        : "";
    if (pages > 1) {
      $("#dream-prev").onclick = () => action(() => list(offset - pageSize));
      $("#dream-next").onclick = () => action(() => list(data.nextOffset));
    }
  }
  async function detail(row, button) {
    const previous = selectedButton;
    if (previous) {
      previous.setAttribute("aria-expanded", "false");
      previous.nextElementSibling.replaceChildren();
    }
    selectedButton = previous === button ? undefined : button;
    if (!selectedButton) return;
    const path = "/api/dreams/cognitions/" + encodeURIComponent(row.id);
    const data = await api(path + "/revisions?" + roleQuery);
    if (!active() || selectedButton !== button) return;
    button.setAttribute("aria-expanded", "true");
    const target = button.nextElementSibling;
    target.innerHTML = `<h3>版本记录</h3><p>${esc(data.cognition.content)}</p>
      ${data.items
        .map((version) => {
          const snapshot = JSON.parse(version.after_json);
          return `<div class="record"><strong>v${version.version} · ${esc(version.op)}</strong><p>${esc(snapshot.content)}</p><p class="hint">${esc(version.reason)} · ${esc(version.created_at)}</p>
          ${data.evidence.map((source, index) => (source.cognition_version === version.version ? `<button type="button" class="ghost" data-dream-source="${index}" ${source.source_type === "diary" && !source.source_revision ? "disabled" : ""}>${esc(source.source_type)}${source.source_type === "diary" ? (source.source_revision ? " v" + esc(source.source_revision) : "（历史版本未知）") : ""} · ${esc(source.scope_id)}</button>` : "")).join("")}
          ${version.version !== data.cognition.version ? `<button type="button" data-dream-rollback="${version.version}">回滚到此版本</button>` : ""}</div>`;
        })
        .join("")}
      <div id="dream-evidence"></div><button type="button" id="dream-delete">彻底删除认知</button>`;
    target.scrollIntoView({ block: "nearest" });
    target.querySelectorAll("[data-dream-source]").forEach((button) => {
      button.onclick = () =>
        action(async () => {
          const source = data.evidence[Number(button.dataset.dreamSource)];
          const query = new URLSearchParams({ agentId, id: source.source_id });
          if (source.source_type !== "correction")
            return readMemory(source.source_id, {
              agentId,
              revision:
                source.source_type === "diary"
                  ? source.source_revision
                  : undefined,
            });
          const entry = await api("/api/dreams/correction?" + query);
          if (active() && target.contains(button)) {
            const evidence = $("#dream-evidence");
            evidence.innerHTML = `<h4>原始证据</h4><pre>${esc(entry.body || entry.text || JSON.stringify(entry, null, 2))}</pre>`;
            evidence.scrollIntoView({ block: "nearest" });
          }
        });
    });
    target.querySelectorAll("[data-dream-rollback]").forEach((button) => {
      button.onclick = () =>
        action(async () => {
          await api(path + "/rollback", {
            agentId,
            version: Number(button.dataset.dreamRollback),
            expectedVersion: data.cognition.version,
          });
          await list(currentOffset);
        });
    });
    $("#dream-delete").onclick = () =>
      action(async () => {
        if (
          !window.confirm(
            "彻底删除这条认知、全部版本和证据索引？原始消息与日记仍会保留。",
          )
        )
          return;
        await api(
          path,
          { agentId, expectedVersion: data.cognition.version },
          "DELETE",
        );
        await list(currentOffset);
      });
  }
  async function stories() {
    const data = await api("/api/dreams/stories?" + roleQuery);
    if (!active()) return;
    $("#dream-story-count").textContent =
      data.items.length === 20 ? "最近 20 篇" : `${data.items.length} 篇`;
    $("#dream-stories").innerHTML =
      data.items
        .map((story) => {
          const themes = JSON.parse(story.themes_json);
          const inspirations = JSON.parse(story.inspirations_json);
          const published = story.published_room_slot
            ? `<p class="hint">纸页小窝槽位 ${esc(story.published_room_slot)}${story.published_at ? ` · ${esc(story.published_at)}` : ""}</p>`
            : "";
          return `<details class="dream-story"><summary>
            <span class="dream-tag">虚构梦境 · 非现实事件</span><strong class="dream-story-title" title="${esc(story.title)}">${esc(story.title)}</strong>
            <span class="dream-excerpt">${esc(story.narrative)}</span>
            <span class="dream-link"><span class="dream-read">展开梦境</span><span class="dream-close">收起梦境</span> <span aria-hidden="true">→</span></span>
            ${themes.length ? `<span class="dream-themes">主题 · ${esc(themes.join("、"))}</span>` : ""}
          </summary><div class="dream-story-body">
          <p class="hint">${esc(story.created_at)}</p>
          <h4>故事</h4><p>${esc(story.narrative)}</p>
          <h4>感想</h4><p>${esc(story.reflection)}</p>
          ${inspirations.length ? `<h4>梦里的灵感</h4><ul>${inspirations.map(({ kind, content }) => `<li><strong>${esc(dreamInspirationLabels[kind] || kind)}</strong> · ${esc(content)}</li>`).join("")}</ul>` : ""}
          ${published}</div></details>`;
        })
        .join("") || '<p class="empty">暂无幻想梦境。</p>';
  }
  function showTriggerStatus(mode, status, errorCode) {
    const label = dreamStatusLabels[status] || status || "已提交";
    $("#dream-trigger-status").textContent =
      `${dreamModeLabels[mode] || mode} · ${label}${errorCode ? ` · ${errorCode}` : ""}`;
  }
  async function refreshRun(runId) {
    if (!active() || runId !== currentRunId) return;
    const [items] = await Promise.all([runs(), overview()]);
    if (!active() || runId !== currentRunId) return;
    const run = items.find((item) => item.run_id === runId);
    if (!run) return;
    showTriggerStatus(run.mode, run.status, run.error_code);
    if (dreamPendingStatuses.has(run.status)) {
      setTimeout(() => action(() => refreshRun(runId)), 2000);
    } else if (run.status === "COMMITTED") {
      if (run.mode === "imaginative") await stories();
      else await list(currentOffset);
    }
  }
  async function runs() {
    const data = await api("/api/dreams/runs?" + roleQuery);
    if (!active()) return;
    const latest = data.items[0];
    $("#dream-run-summary").textContent = latest
      ? `${dreamModeLabels[latest.mode] || latest.mode} · ${dreamStatusLabels[latest.status] || latest.status}`
      : "暂无记录";
    $("#dream-runs").innerHTML =
      data.items
        .map((run) => {
          const elapsed =
            run.finished_at && run.started_at
              ? (Date.parse(run.finished_at) - Date.parse(run.started_at)) /
                1000
              : null;
          const usage = run.usage_json ? JSON.parse(run.usage_json) : null;
          const usageLabel = usage
            ? `${usage.source === "measured" ? "后端实测" : "后端估算"} · ${usage.contextTokens} 上下文 token`
            : "用量未记录";
          return `<div class="record"><strong>${esc(dreamModeLabels[run.mode] || run.mode)} · ${esc(dreamStatusLabels[run.status] || run.status)}</strong><p>${esc(dreamTriggerLabels[run.trigger] || run.trigger)} · ${esc(run.created_at)} · ${run.changes_count} 项变更${elapsed === null ? "" : ` · ${elapsed}s`}</p><p class="hint">${esc(usageLabel)}${run.error_code ? " · " + esc(run.error_code) : ""}</p></div>`;
        })
        .join("") || '<p class="empty">暂无运行记录。</p>';
    return data.items;
  }
  form.onsubmit = (event) => {
    event.preventDefault();
    appliedFilters = new URLSearchParams(new FormData(form));
    action(() => list());
  };
  await Promise.all([overview(), list(), stories(), runs()]);
}
