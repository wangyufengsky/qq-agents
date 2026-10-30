let updateData,
  updateBusy = false,
  updateView = 0;
const updateErrors = {
  UPDATE_SETTINGS_INVALID:
    "更新设置无法读取，自动检查已关闭；重新保存设置可修复。",
  UPDATE_SETTINGS_SAVE_FAILED: "更新设置保存失败，请检查数据目录权限。",
  UPDATE_RATE_LIMITED: "发布服务暂时限制请求，稍后会重试。",
  UPDATE_UNAVAILABLE: "暂时无法连接官方发布服务，请检查网络后重试。",
  UPDATE_RESPONSE_INVALID: "官方发布信息格式不符合要求，请稍后重试。",
  UPDATE_RELEASE_CHANGED: "版本信息已变化，请重新检查。",
};
function renderUpdateBadge(value) {
  const button = $("#update-notice");
  if (!button) return;
  button.hidden = !value?.notify;
  button.textContent = value?.notify ? `发现新版 ${value.tag}` : "";
  button.onclick = () => {
    tab = "updates";
    render();
  };
}
function updatesMarkup(data) {
  const labels = {
    unknown:
      data.checkedAt && !data.latest ? "尚无正式发布版本" : "尚未确认版本关系",
    available: `发现新版本 ${data.latest?.tag}`,
    ahead: "当前版本号高于最新正式版",
    "same-version": "与最新正式版的版本号相同",
  };
  const current = data.installed;
  return `<section class="card updates-card"><div class="row"><h2>${esc(labels[data.comparison])}</h2>${tag(data.checking || updateBusy ? "检查中" : data.error ? "检查未完成" : "官方稳定版", data.error ? "warn" : "")}</div>
    <p>当前版本：<strong>${esc(current.version)}</strong>${current.commit ? ` · <span class="mono">${esc(current.commit.slice(0, 12))}</span>` : " · 提交未知"}</p>
    ${current.modified ? '<p class="hint">本地代码有修改，升级前需要保留并处理这些改动。</p>' : ""}
    ${data.comparison === "same-version" ? '<p class="hint">版本号相同不代表代码完全一致；开发分支不会被提示降级到同版本发布包。</p>' : ""}
    ${data.comparison === "unknown" && data.latest ? '<p class="hint">当前安装版本无法比较，请人工核对发布说明。</p>' : ""}
    ${data.error ? `<p class="alert" role="status">${esc(updateErrors[data.error] || "检查未完成")}${data.latest ? " 下方保留上次成功获取的信息。" : ""}</p>` : ""}
    <p class="hint">上次成功检查：${data.checkedAt === null ? "尚未检查" : esc(new Date(data.checkedAt).toLocaleString())}</p>
    <div class="card-actions"><button id="update-check" ${updateBusy || data.checking ? "disabled" : ""}>立即检查</button>${data.latest ? `<a class="button" href="${esc(data.latest.url)}" target="_blank" rel="noopener noreferrer">查看官方发布页</a><button class="ghost" id="update-ignore">${data.ignoredTag === data.latest.tag ? "恢复此版本提醒" : "忽略此版本提醒"}</button>` : ""}</div>
    </section>
    ${data.latest ? `<section class="card"><h2>${esc(data.latest.tag)} 更新说明</h2><p class="hint">发布于 ${esc(new Date(data.latest.publishedAt).toLocaleString())}${data.ignoredTag === data.latest.tag ? " · 已忽略提醒" : ""}</p><pre class="update-notes">${esc(data.latest.notes || "此版本没有更新说明。")}</pre></section>` : ""}
    <section class="card"><h2>自动检查</h2><label class="check"><input id="update-auto" type="checkbox" ${data.enabled ? "checked" : ""}>每 6 小时检查官方稳定版</label><p class="hint">默认关闭。开启后仅向 GitHub 请求公开发布信息，不上传配置、账号、聊天或记忆。每分钟最多检查一次，连接失败时自动延后重试。</p></section>
    <section class="card"><h2>升级方式</h2><p>本机源码安装：备份数据后切换到目标发布标签、安装依赖并重启。Docker：在宿主机备份数据卷后更新代码并重新构建容器。</p><p class="hint">保留当前代码及升级前的数据备份，升级完成后核对暂停状态、QQ 连接和 AI 后端。</p><a href="https://github.com/wangyufengsky/qq-agents/blob/main/docs/UPDATES.md" target="_blank" rel="noopener noreferrer">查看升级指南</a></section>`;
}
function paintUpdates() {
  if (tab !== "updates" || !updateData) return;
  $("#content").innerHTML = updatesMarkup(updateData);
  $("#update-check").onclick = () =>
    action(() => updateAction("/api/updates/check", {}));
  $("#update-auto").onchange = (e) =>
    action(() =>
      updateAction(
        "/api/updates/settings",
        { enabled: e.target.checked },
        "PUT",
      ),
    );
  const ignore = $("#update-ignore");
  if (ignore)
    ignore.onclick = () =>
      action(() =>
        updateAction(
          "/api/updates/settings",
          {
            ignoredTag:
              updateData.ignoredTag === updateData.latest.tag
                ? null
                : updateData.latest.tag,
          },
          "PUT",
        ),
      );
}
async function updateAction(route, body, method) {
  if (updateBusy) return;
  updateBusy = true;
  paintUpdates();
  try {
    updateData = await api(route, body, method);
  } finally {
    updateBusy = false;
    if (updateData && status)
      status.updateNotice = {
        notify: updateData.notify,
        tag: updateData.latest?.tag,
      };
    if (updateData)
      renderUpdateBadge({
        notify: updateData.notify,
        tag: updateData.latest?.tag,
      });
    paintUpdates();
  }
}
function renderUpdates() {
  const view = ++updateView;
  $("#content").innerHTML =
    '<section class="card" role="status">正在读取版本信息…</section>';
  action(async () => {
    const data = await api("/api/updates");
    if (view !== updateView || tab !== "updates") return;
    updateData = data;
    paintUpdates();
  });
}
setInterval(() => {
  if (typeof config === "undefined" || !config || updateBusy) return;
  api("/api/updates")
    .then((data) => {
      updateData = data;
      renderUpdateBadge({ notify: data.notify, tag: data.latest?.tag });
      if (status)
        status.updateNotice = { notify: data.notify, tag: data.latest?.tag };
      paintUpdates();
    })
    .catch(() => {});
}, 60000);
