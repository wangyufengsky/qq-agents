let fileAgentId;
function renderFilePermissions() {
  if (!config.agents.some((a) => a.id === fileAgentId))
    fileAgentId = config.agents[0]?.id;
  const a = config.agents.find((a) => a.id === fileAgentId);
  if (!a) {
    $("#content").innerHTML = '<div class="card">请先添加智能体。</div>';
    return;
  }
  const f = a.files,
    mib = 1024 * 1024;
  $("#content").innerHTML =
    `<div class="card toolbar"><label>智能体<select id="file-agent">${config.agents.map((row) => `<option value="${esc(row.id)}" ${row.id === a.id ? "selected" : ""}>${esc(row.name)}</option>`).join("")}</select></label>${tag(f.enabled ? "文件权限已开启" : "文件权限已关闭", f.enabled ? "live" : "")}<p class="hint">每个角色拥有独立文件库。全局、角色及会话暂停仍然生效。</p></div>
  <form id="file-permissions" class="card"><h2>自主文件收发</h2><p>开启后，AI 可在已允许的群和私聊中自主操作，无需每次确认。发送目标固定为当前会话。</p><div class="form-grid">
  ${check("enabled", "启用此 AI 的文件权限", f.enabled)}
  ${check("download", "允许下载公开链接", f.download)}${check("receive", "允许下载 QQ 附件", f.receive)}${check("send", "允许发送文件", f.send)}${check("create", "允许生成文本文件", f.create)}
  ${input("maxMiB", "单文件上限（MiB，最大 50）", f.maxBytes / mib, 'type="number" min="0.001" max="50" step="any" required')}
  ${input("totalMiB", "文件库容量（MiB）", f.maxTotalBytes / mib, 'type="number" min="0.001" max="5120" step="any" required')}
  ${input("maxFiles", "文件数量上限", f.maxFiles, 'type="number" min="1" max="10000" required')}
  ${area("localRoots", "允许导入的本机专用目录（可选，每行一个绝对路径）", f.localRoots.join("\n"))}
  </div><p class="hint">目录仅用于导入文件，保存后按从 0 开始的顺序编号；留空仍可下载和收发。下载文件不会执行内容，也不代表 AI 已读懂 PDF 或 Office 文档。关闭权限会中止此 AI 的活动回合，已开始的网关投递仍可能完成。</p><button class="primary">保存文件权限</button></form>
  <section class="card"><h2>${esc(a.name)}的文件库</h2><div class="toolbar"><label>放入文件<input id="file-upload" type="file"></label><button id="file-import">导入到此文件库</button><button id="file-refresh">刷新</button></div><p class="hint">管理员导入不会发送文件。文件权限开启后，此 AI 可以在授权会话中使用这些文件。</p><div id="file-library">正在读取…</div></section>`;
  $("#file-agent").onchange = (e) => {
    fileAgentId = e.target.value;
    renderFilePermissions();
  };
  $("#file-permissions").onsubmit = (e) => {
    e.preventDefault();
    action(async () => {
      const data = new FormData(e.target);
      await api(
        "/api/permissions/files",
        {
          agentId: a.id,
          revision,
          files: {
            ...f,
            enabled: data.has("enabled"),
            download: data.has("download"),
            receive: data.has("receive"),
            send: data.has("send"),
            create: data.has("create"),
            maxBytes: Math.round(Number(data.get("maxMiB")) * mib),
            maxTotalBytes: Math.round(Number(data.get("totalMiB")) * mib),
            maxFiles: Number(data.get("maxFiles")),
            localRoots: String(data.get("localRoots"))
              .split("\n")
              .map((s) => s.trim())
              .filter(Boolean),
          },
        },
        "PUT",
      );
      await load();
      notice("文件权限已保存；暂停状态保持不变，无需重新连接 QQ。");
    });
  };
  $("#file-refresh").onclick = () => action(() => loadFileLibrary(a.id));
  $("#file-import").onclick = () =>
    action(async () => {
      const file = $("#file-upload").files[0];
      if (!file) throw Error("请先选择文件");
      if (file.size > f.maxBytes) throw Error("文件超过当前大小上限");
      const base64 = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result).split(",")[1]);
        reader.onerror = () => reject(Error("文件读取失败"));
        reader.readAsDataURL(file);
      });
      await api("/api/files/import", {
        agentId: a.id,
        name: file.name,
        base64,
      });
      await loadFileLibrary(a.id);
      notice("文件已导入，尚未发送");
    });
  action(() => loadFileLibrary(a.id));
}
async function loadFileLibrary(agentId, offset = 0) {
  const result = await api(
    "/api/files?" + new URLSearchParams({ agentId, offset }),
  );
  if (tab !== "permissions" || fileAgentId !== agentId) return;
  $("#file-library").innerHTML =
    `<p class="hint">${result.storedFiles} 个占用条目（含损坏、孤儿文件及拦截记录） · ${(result.usedBytes / 1024 / 1024).toFixed(2)} MiB</p>${result.items.map((file) => `<article class="record"><strong>${esc(file.name)}</strong><p>${file.bytes} 字节 · ${esc(file.createdAt)}${file.protectionUnknown ? " · 保护信息不完整，发送需批准" : ""}</p><p class="mono">${esc(file.fileId)}</p><button type="button" data-file="${esc(file.fileId)}">下载到本机</button></article>`).join("") || '<p class="hint">文件库为空。</p>'}${result.nextOffset !== null || result.nextCorruptOffset !== null ? '<button id="file-more">下一页</button>' : ""}`;
  if (result.corruptCount)
    $("#file-library").insertAdjacentHTML(
      "afterbegin",
      `<div class="card"><strong>${result.corruptCount} 个损坏条目已隔离</strong><p>保留原文件并计入容量。修复会验证文件内容并保留保护限制；移除会删除损坏文件，保留同内容重新导入的拦截记录。</p>${result.corrupt.map((f) => `<div class="record"><p class="mono">${esc(f.fileId)}</p><p>${esc(f.code)}</p>${f.code === "FILE_REMOVAL_INCOMPLETE" ? "" : `<button data-repair="${esc(f.fileId)}">修复元数据</button>`}<button data-remove-damaged="${esc(f.fileId)}">移除损坏文件</button></div>`).join("")}</div>`,
    );
  if (!result.usageComplete)
    $("#file-library").insertAdjacentHTML(
      "afterbegin",
      '<p class="hint">部分占用无法安全统计，新增文件已暂停；请检查文件权限或异常目录。</p>',
    );
  $("#file-library")
    .querySelectorAll("[data-repair], [data-remove-damaged]")
    .forEach((button) => {
      button.onclick = () =>
        action(async () => {
          const repair = !!button.dataset.repair,
            fileId = button.dataset.repair || button.dataset.removeDamaged;
          let name;
          if (repair) {
            name = prompt(
              "修复后的文件名（原保护信息不完整，发送仍需批准）",
              "recovered.bin",
            );
            if (!name) return;
          } else if (
            !confirm(
              "移除该损坏条目的元数据和内容文件？将保留拦截记录，禁止同内容重新导入以清除保护。",
            )
          )
            return;
          await api("/api/files/recovery", {
            agentId,
            fileId,
            action: repair ? "repair" : "remove",
            ...(repair ? { name } : {}),
          });
          await loadFileLibrary(agentId, offset);
          notice(
            repair
              ? "元数据已修复，保护信息不完整的限制已保留"
              : "损坏文件已移除，同内容导入拦截已保留",
          );
        });
    });
  if (result.nextOffset !== null || result.nextCorruptOffset !== null)
    $("#file-more").onclick = () =>
      action(() =>
        loadFileLibrary(agentId, result.nextOffset ?? result.nextCorruptOffset),
      );
  $("#file-library")
    .querySelectorAll("[data-file]")
    .forEach((button) => {
      button.onclick = () =>
        action(async () => {
          const response = await fetch(
            "/api/files/download?" +
              new URLSearchParams({ agentId, fileId: button.dataset.file }),
            { headers: { "x-admin-token": token } },
          );
          if (!response.ok) throw Error("文件下载失败");
          const objectUrl = URL.createObjectURL(await response.blob()),
            link = document.createElement("a");
          link.href = objectUrl;
          link.download = result.items.find(
            (f) => f.fileId === button.dataset.file,
          ).name;
          link.click();
          setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
        });
    });
}
