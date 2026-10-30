let projectAgentId = null;
let projectSelection = null;
let projectFilters = { kind: "all", status: "all", query: "" };
let projectRequest = 0;
const projectDraftRequests = new WeakMap();
const projectStateLabels = {
  active: "进行中",
  paused: "暂停",
  done: "已完成",
  dropped: "已结束",
};
const projectDate = (at) => new Date(at).toLocaleString("zh-CN");
const projectActor = (id) =>
  id === "agent" ? "角色" : id === "administrator" ? "管理员" : id;

function openProject(agentId, id) {
  document.querySelectorAll("dialog.document-reader").forEach((d) => d.close());
  roleId = agentId;
  projectSelection = { agentId, id };
  tab = "projects";
  render();
}
function projectFileButtons(files) {
  return (
    files
      .map(
        (f) =>
          `<div class="project-file"><span>${esc(f.name)}</span>${f.unavailable ? '<span class="hint">文件暂不可用</span>' : `<button type="button" data-project-file="${esc(f.fileId)}" ${f.readable ? "" : "hidden"}>在线阅读</button><button type="button" class="ghost" data-project-download="${esc(f.fileId)}">下载</button>`}</div>`,
      )
      .join("") || '<p class="hint">尚未关联文件。</p>'
  );
}
function bindProjectFiles(root, agentId, files) {
  root
    .querySelectorAll("[data-project-file]")
    .forEach(
      (b) =>
        (b.onclick = () =>
          action(() => openDocument(agentId, b.dataset.projectFile))),
    );
  root
    .querySelectorAll("[data-project-download]")
    .forEach(
      (b) =>
        (b.onclick = () =>
          action(() =>
            downloadDocument(
              agentId,
              b.dataset.projectDownload,
              files.find((f) => f.fileId === b.dataset.projectDownload).name,
            ),
          )),
    );
}
async function renderProjects(offset = 0) {
  const agentId = projectAgentId,
    ticket = ++projectRequest;
  const active = () =>
    tab === "projects" &&
    projectAgentId === agentId &&
    projectRequest === ticket;
  const root = $("#content");
  if (!agentId) {
    root.innerHTML = '<section class="card">请先添加角色。</section>';
    return;
  }
  root.innerHTML = '<section class="card">正在读取项目…</section>';
  if (projectSelection?.agentId === agentId) {
    root.innerHTML =
      '<section class="card"><button type="button" data-project-cancel>返回项目列表</button><p>正在读取项目…</p></section>';
    root.querySelector("[data-project-cancel]").onclick = () => {
      projectSelection = null;
      action(() => renderProjects());
    };
    await action(async () => {
      const data = await api(
        "/api/project/files?" +
          new URLSearchParams({ agentId, id: projectSelection.id }),
      );
      if (active()) await showProjectDetail(root, agentId, data, active);
    });
    return;
  }
  await action(async () => {
    const data = await api(
      "/api/projects?" +
        new URLSearchParams({ agentId, ...projectFilters, offset }),
    );
    if (!active()) return;
    root.innerHTML = `<section class="card"><div class="project-head"><h2>项目与活动</h2><span class="hint">个人项目 ${data.counts.personal} · 共同活动 ${data.counts.shared}</span></div><form id="project-filter" class="toolbar">${select(
      "kind",
      "类型",
      projectFilters.kind,
      [
        ["all", "全部"],
        ["shared", "共同活动"],
        ["personal", "个人项目"],
      ],
    )}${select("status", "状态", projectFilters.status, [["all", "全部"], ...Object.entries(projectStateLabels)])}<label>查找项目<input name="query" maxlength="100" value="${esc(projectFilters.query)}" placeholder="标题或目标"></label><button>筛选</button></form><div class="project-grid">${data.items.map((p) => `<article class="project-card"><div class="project-head"><h3 title="${esc(p.title)}">${esc(p.title)}</h3>${tag(projectStateLabels[p.status])}</div><p class="hint">${p.activity ? "共同活动" : "个人项目"} · ${esc(projectDate(p.updatedAt))}</p><p class="project-clamp" title="${esc(p.why)}">${esc(p.why)}</p>${p.latest ? `<p class="project-clamp">最近：${esc(p.latest)}</p>` : ""}${p.activity ? `<p>轮到 ${esc(projectActor(p.activity.turn))} · 待决定 ${p.activity.pending.length} 项</p>` : ""}<p class="hint">${p.fileCount} 个关联文件</p><button type="button" data-project-open="${esc(p.id)}">打开项目</button></article>`).join("") || '<p class="hint">没有符合条件的项目。角色通过 project 工具记录持续推进的事情。</p>'}</div><div class="toolbar"><span>${data.total} 个项目</span><button type="button" data-project-prev ${offset ? "" : "disabled"}>上一页</button><button type="button" data-project-next ${data.nextOffset === null ? "disabled" : ""}>下一页</button></div></section>`;
    root.querySelector("#project-filter").onsubmit = (e) => {
      e.preventDefault();
      projectFilters = Object.fromEntries(new FormData(e.target));
      action(() => renderProjects());
    };
    root
      .querySelectorAll("[data-project-open]")
      .forEach(
        (b) => (b.onclick = () => openProject(agentId, b.dataset.projectOpen)),
      );
    root.querySelector("[data-project-prev]").onclick = () =>
      action(() => renderProjects(Math.max(0, offset - 20)));
    root.querySelector("[data-project-next]").onclick = () =>
      action(() => renderProjects(data.nextOffset));
  });
}
async function showProjectDetail(root, agentId, { project: p, files }, active) {
  root.innerHTML = `<div class="toolbar"><button type="button" data-project-back>所有项目</button><button type="button" data-project-refresh>刷新</button></div><section class="card"><div class="project-head"><h2>${esc(p.title)}</h2>${tag(projectStateLabels[p.status])}</div><p>${esc(p.why)}</p><p class="hint">${p.activity ? "共同活动" : "个人项目"} · 修订 ${p.revision} · ${esc(projectDate(p.updatedAt))}</p>${p.activity ? `<p>参与者：${p.activity.participants.map((id) => esc(projectActor(id))).join("、")} · 轮到 ${esc(projectActor(p.activity.turn))}</p><p class="hint">${esc(conversationLabel(p.activity.conversation))}</p>` : ""}<p>下一步：${esc(p.next || "尚未记录")}</p>${p.blocker ? `<p>卡点：${esc(p.blocker)}</p>` : ""}${p.outcome ? `<p>结果：${esc(p.outcome)}</p>` : ""}<div id="project-participation"></div></section><div class="project-columns"><section class="card"><h2>${p.activity ? "活动原稿与版本" : "作品与文件"}</h2>${p.activity ? '<div id="project-draft">正在读取…</div>' : `<div id="project-current-work"></div>${projectFileButtons(files)}`}${!p.activity && files.filter((f) => f.readable).length > 1 ? '<div id="project-compare"></div>' : ""}</section><section class="card"><h2>进展时间线</h2>${
    p.steps
      .map(
        (s) =>
          `<article class="project-step"><p class="hint">${esc(projectDate(s.at))}</p><p>${esc(s.did)}</p>${(
            s.files || []
          )
            .map((id) => {
              const f = files.find((f) => f.fileId === id);
              return f?.readable
                ? `<button type="button" data-project-file="${esc(id)}">${esc(f.name)}</button>`
                : "";
            })
            .join("")}</article>`,
      )
      .join("") || '<p class="hint">尚无进展记录。</p>'
  }<p class="hint">最近 ${p.steps.length} 步${p.activity ? "；活动完整版本见左侧历史。" : "；文件保持原始内容，不按名称推断版本。"}</p>${p.activity ? `<h3>待决定事项</h3>${p.activity.pending.map((x) => `<p>${esc(x.question)}</p><p class="hint">${x.options.map(esc).join(" / ")}</p>`).join("") || '<p class="hint">暂无。</p>'}` : ""}</section></div>${p.activity && files.length ? `<section class="card"><h2>关联文件</h2>${projectFileButtons(files)}</section>` : ""}`;
  root.querySelector("[data-project-back]").onclick = () => {
    projectSelection = null;
    action(() => renderProjects());
  };
  root.querySelector("[data-project-refresh]").onclick = () =>
    action(() => renderProjects());
  bindProjectFiles(root, agentId, files);
  const currentWork = !p.activity && files.find((f) => f.readable);
  if (currentWork) {
    try {
      const text = await api(
        "/api/files/read?" +
          new URLSearchParams({ agentId, fileId: currentWork.fileId }),
      );
      if (!active()) return;
      root.querySelector("#project-current-work").innerHTML =
        `<h3 class="project-clamp" title="${esc(currentWork.name)}">最近关联：${esc(currentWork.name)}</h3><article class="document-content">${text.format === "markdown" ? documentMarkdown(text.text, text) : `<pre>${esc(text.text)}</pre>`}</article>${text.nextOffset !== null ? '<p class="hint">此处显示开头，点击在线阅读查看全文。</p>' : ""}`;
    } catch {
      if (active())
        root.querySelector("#project-current-work").textContent =
          "暂时无法预览，请打开作品查看详情。";
    }
  }
  if (!active()) return;
  if (p.activity)
    await loadProjectDraft(
      root.querySelector("#project-draft"),
      agentId,
      p,
      active,
    );
  else if (files.filter((f) => f.readable).length > 1)
    bindProjectComparison(
      root.querySelector("#project-compare"),
      agentId,
      p.id,
      files.filter((f) => f.readable).map((f) => ["file:" + f.fileId, f.name]),
    );
}
async function loadProjectDraft(
  container,
  agentId,
  project,
  active,
  revision,
  offset = 0,
  historyOffset = 0,
) {
  const ticket = (projectDraftRequests.get(container) || 0) + 1;
  projectDraftRequests.set(container, ticket);
  const query = new URLSearchParams({
    agentId,
    id: project.id,
    offset,
    historyOffset,
  });
  if (revision) query.set("revision", revision);
  const data = await api("/api/project?" + query);
  if (
    !active() ||
    !container.isConnected ||
    projectDraftRequests.get(container) !== ticket
  )
    return;
  const author =
    data.draft?.author === "administrator"
      ? "管理员"
      : data.draft?.author === "source-file"
        ? "来源文件"
        : "角色";
  container.innerHTML = `${data.draft ? `<h3>${esc(data.draft.title)} · 原稿修订 ${data.draft.revision}</h3><p class="hint">${esc(author)}编写 · ${data.draft.offset + 1}–${data.draft.offset + data.draft.text.length} / ${data.draft.totalChars} 字符</p><article class="document-content"><pre>${esc(data.draft.text)}</pre></article><div class="toolbar"><button type="button" data-draft-prev ${offset ? "" : "disabled"}>原稿上一页</button><button type="button" data-draft-next ${data.draft.nextOffset === null ? "disabled" : ""}>原稿下一页</button></div>` : '<p class="hint">尚未保存原稿。</p>'}${data.version.contribution ? `<details><summary>参与者原始贡献</summary><pre>${esc(data.version.contribution.text)}</pre>${data.version.contribution.truncated ? '<button type="button" data-contribution-read>阅读完整贡献</button>' : ""}</details>` : ""}<h3>完整版本历史 · ${data.historyTotal}</h3><div class="project-versions">${data.history.map((v) => `<button type="button" data-draft-version="${v.revision}">修订 ${v.revision} · ${esc(v.progress || "保存记录")}</button>`).join("")}</div><div class="toolbar"><button type="button" data-history-prev ${historyOffset ? "" : "disabled"}>较新记录</button><button type="button" data-history-next ${data.nextHistoryOffset === null ? "disabled" : ""}>更早记录</button></div><div data-draft-compare></div>`;
  const show = (rev = data.version.revision, off = 0, hist = historyOffset) =>
    action(() =>
      loadProjectDraft(container, agentId, project, active, rev, off, hist),
    );
  container
    .querySelectorAll("[data-draft-version]")
    .forEach((b) => (b.onclick = () => show(Number(b.dataset.draftVersion))));
  const next = container.querySelector("[data-draft-next]");
  if (next) {
    next.onclick = () => show(data.version.revision, data.draft.nextOffset);
    container.querySelector("[data-draft-prev]").onclick = () =>
      show(data.version.revision, Math.max(0, offset - 8000));
  }
  container.querySelector("[data-history-prev]").onclick = () =>
    show(data.version.revision, offset, Math.max(0, historyOffset - 10));
  container.querySelector("[data-history-next]").onclick = () =>
    show(data.version.revision, offset, data.nextHistoryOffset);
  const contribution = container.querySelector("[data-contribution-read]");
  if (contribution)
    contribution.onclick = () =>
      readMemory(data.version.contribution.read.id, { agentId });
  if (data.historyTotal > 1)
    bindProjectComparison(
      container.querySelector("[data-draft-compare]"),
      agentId,
      project.id,
      [
        ...new Set([
          project.revision,
          data.version.revision,
          ...data.history.map((h) => h.revision),
        ]),
      ].map((revision) => ["draft:" + revision, "修订 " + revision]),
    );
}
function bindProjectComparison(root, agentId, id, options) {
  root.innerHTML = `<details><summary>比较作品或原稿</summary><p class="hint">按完整正文比较；每份文件上限 2 MiB。变化较长时仅显示区段开头。</p><form data-compare-form class="toolbar">${select("before", "之前", options[1]?.[0] || options[0]?.[0], options)}${select("after", "之后", options[0]?.[0], options)}<button>比较变化</button></form><div data-comparison></div></details>`;
  let ticket = 0;
  root.querySelector("form").onsubmit = (event) => {
    event.preventDefault();
    const request = ++ticket;
    action(async () => {
      const values = Object.fromEntries(new FormData(event.target));
      const data = await api(
        "/api/projects/compare?" +
          new URLSearchParams({ agentId, id, ...values }),
      );
      if (!root.isConnected || ticket !== request) return;
      root.querySelector("[data-comparison]").innerHTML = data.identical
        ? "<p>两份正文完全相同。</p>"
        : `<p class="hint">变化区段：从第 ${data.before.start + 1} 个字符开始。相同的开头与结尾已省略。</p><div class="project-columns">${[
            ["之前", data.before],
            ["之后", data.after],
          ]
            .map(
              ([label, part]) =>
                `<section><h4>${label}</h4><pre class="project-diff">${esc(part.text) || "（空）"}</pre>${part.truncated ? '<p class="hint">变化区段较长，此处仅显示前 16000 字符，请打开原文继续阅读。</p>' : ""}</section>`,
            )
            .join("")}</div>`;
    });
  };
}
