let updateData,
  updateBusy = false,
  updateView = 0;
let upgradeTimer;
const upgradePhases = {
  idle: "等待操作",
  preparing: "核对官方发布",
  downloading: "下载新版本",
  installing: "安装依赖",
  stopping: "正在停止运行",
  "backing-up": "备份数据",
  starting: "启动新版本",
  checking: "检查连接与后端",
  resuming: "恢复运行",
  completed: "升级完成",
  "rolling-back": "恢复旧版本",
  "rolled-back": "已恢复旧版本，保持暂停",
  failed: "升级未完成",
  "recovery-required": "需要检查恢复状态",
};
const upgradeErrorText = {
  UPDATE_BACKUP_INVALID: "备份完整性检查未通过，已停止升级。",
  UPDATE_LOCAL_CHANGES:
    "当前代码有改动或提交未知，请先保留改动并确认安装来源。",
  UPDATE_DIVERGED: "当前提交不在目标正式版历史中，需要人工处理分支差异。",
  UPDATE_SOURCE_UNSUPPORTED: "安装来源不支持自动升级，请按指南手动升级。",
  UPDATE_IMAGE_REBUILD_REQUIRED: "新版改变了容器构建要求，请在宿主机重建镜像。",
  UPDATE_RUNTIME_UNSUPPORTED:
    "新版要求不同的 Node.js 或升级协议，请按发布说明升级运行环境。",
  UPDATE_DATA_LINK_UNSUPPORTED:
    "关键数据文件存在链接，或数据中存在硬链接、特殊文件，需要按指南处理。",
  UPDATE_DISK_SPACE: "磁盘空间不足，无法同时保留备份和恢复副本。",
  UPDATE_HEALTH_FAILED: "新版启动后的连接或后端检查没有通过。",
  UPDATE_STOP_FAILED: "进程未确认正常退出，已停止自动切换。",
  UPDATE_PROCESS_STILL_RUNNING:
    "检测到进程或数据锁，已停止切换以避免并发写入。",
  UPDATE_COMMAND_FAILED: "下载或依赖安装未完成，请检查 Git、npm 和网络。",
  UPDATE_RECOVERY_REQUIRED: "上次升级中断，已保留现场，需要检查后再恢复发言。",
  UPDATE_STATE_INVALID: "升级状态无法可靠保存或读取，请按恢复指南处理。",
};
const upgradeActive = (value) =>
  value &&
  !["idle", "completed", "failed", "rolled-back", "recovery-required"].includes(
    value.phase,
  );
function upgradeMarkup(data) {
  const state = data.upgrade || { managed: false, phase: "idle" };
  const active = upgradeActive(state);
  const canInstall =
    state.managed &&
    !active &&
    state.phase !== "recovery-required" &&
    data.comparison === "available" &&
    data.installed.modified === false &&
    data.installed.commit;
  return `<section class="card"><h2>一键升级</h2><p role="status">${esc(upgradePhases[state.phase] || "读取升级状态")}${state.tag ? ` · ${esc(state.tag)}` : ""}</p>
    ${state.error ? `<p class="alert">${esc(upgradeErrorText[state.error] || updateErrors[state.error] || "升级未完成，请检查启动器日志和升级指南。")}</p>` : ""}
    ${state.phase === "rolled-back" ? "<p>旧版本和升级前数据已恢复，角色保持暂停。失败版本的数据保留在备份旁，核对后再手动恢复参与。</p>" : ""}
    ${state.phase === "recovery-required" ? "<p>可能已产生新的发送记录，自动回退已停止。请保留现场，检查运行状态；不要直接覆盖发送账本。</p>" : ""}
    ${state.managed ? '<p class="hint">升级前自动备份，检查通过后恢复原有参与状态。升级期间管理台会短暂断开；失败恢复后保持暂停。</p>' : "<p>当前使用普通启动方式。正常停止后，用 <code>npm run managed -- --data &lt;原数据目录&gt;</code> 启动以启用一键升级；运行模式保留原有 <code>--live</code> 参数。</p>"}
    <div class="card-actions">${canInstall ? '<button id="update-install">备份并升级</button>' : ""}${state.phase === "completed" ? '<button id="update-reload">刷新管理台</button>' : ""}<a href="https://github.com/wangyufengsky/qq-agents/blob/main/docs/UPDATES.md" target="_blank" rel="noopener noreferrer">升级与恢复指南</a></div>
    </section>`;
}
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
    ${upgradeMarkup(data)}`;
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
  const install = $("#update-install");
  if (install)
    install.onclick = () =>
      action(async () => {
        if (
          !confirm(
            `将升级到 ${updateData.latest.tag}，自动备份并短暂停机。检查通过后恢复原先的参与状态；失败回退后保持暂停。继续？`,
          )
        )
          return;
        install.disabled = true;
        try {
          updateData.upgrade = await api("/api/updates/install", {
            tag: updateData.latest.tag,
          });
        } finally {
          paintUpdates();
        }
        pollUpgrade();
      });
  const reload = $("#update-reload");
  if (reload) reload.onclick = () => location.reload();
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
    if (upgradeActive(data.upgrade)) pollUpgrade();
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

function pollUpgrade() {
  clearTimeout(upgradeTimer);
  upgradeTimer = setTimeout(async () => {
    try {
      updateData = await api("/api/updates");
      paintUpdates();
      if (upgradeActive(updateData.upgrade)) pollUpgrade();
    } catch {
      if (tab === "updates") {
        const box = $("#content");
        box.innerHTML =
          '<section class="card" role="status">管理台正在重启，等待恢复连接…<p class="hint">如果启动器已停止，请按升级指南检查本机日志和恢复状态。</p></section>';
      }
      pollUpgrade();
    }
  }, 2000);
}
