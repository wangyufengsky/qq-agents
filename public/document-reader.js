// A deliberately small Markdown vocabulary. Every source character is escaped;
// only our own tags are emitted. Images/HTML never load resources or execute.
function documentInline(text) {
  const pattern =
    /(`[^`\n]+`|\*\*[^*\n]+\*\*|\[[^\]\n]+\]\(https?:\/\/[^\s)]+\))/g;
  let html = "",
    at = 0;
  for (const m of text.matchAll(pattern)) {
    html += esc(text.slice(at, m.index));
    const value = m[0];
    if (value.startsWith("`"))
      html += `<code>${esc(value.slice(1, -1))}</code>`;
    else if (value.startsWith("**"))
      html += `<strong>${esc(value.slice(2, -2))}</strong>`;
    else {
      const split = value.indexOf("](");
      html += `<a href="${esc(value.slice(split + 2, -1))}" target="_blank" rel="noopener noreferrer">${esc(value.slice(1, split))}</a>`;
    }
    at = m.index + value.length;
  }
  return html + esc(text.slice(at));
}
function documentMarkdown(text, { codeFence = false } = {}) {
  const lines = text.split(/\r?\n/),
    out = [];
  let code = codeFence ? [] : null,
    list = null;
  const closeList = () => {
    if (list) {
      out.push(`</${list}>`);
      list = null;
    }
  };
  const cells = (line) =>
    line
      .trim()
      .replace(/^\||\|$/g, "")
      .split("|");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*```/.test(line)) {
      closeList();
      if (code !== null) {
        out.push(`<pre><code>${esc(code.join("\n"))}</code></pre>`);
        code = null;
      } else code = [];
      continue;
    }
    if (code !== null) {
      code.push(line);
      continue;
    }
    const item = /^\s*(?:([-*])|\d+\.)\s+(.+)$/.exec(line);
    if (item) {
      const kind = item[1] ? "ul" : "ol";
      if (list !== kind) {
        closeList();
        list = kind;
        out.push(`<${kind}>`);
      }
      out.push(`<li>${documentInline(item[2])}</li>`);
      continue;
    }
    closeList();
    if (
      line.includes("|") &&
      /^\s*\|?\s*:?-{3,}/.test(lines[i + 1] || "") &&
      cells(lines[i + 1]).every((c) => /^\s*:?-{3,}:?\s*$/.test(c))
    ) {
      out.push(
        `<div class="document-table"><table><thead><tr>${cells(line)
          .map((c) => `<th>${documentInline(c.trim())}</th>`)
          .join("")}</tr></thead><tbody>`,
      );
      i++;
      while (
        i + 1 < lines.length &&
        lines[i + 1].includes("|") &&
        lines[i + 1].trim()
      )
        out.push(
          `<tr>${cells(lines[++i])
            .map((c) => `<td>${documentInline(c.trim())}</td>`)
            .join("")}</tr>`,
        );
      out.push("</tbody></table></div>");
      continue;
    }
    const heading = /^(#{1,6})\s+(.+)$/.exec(line);
    if (heading)
      out.push(
        `<h${heading[1].length}>${documentInline(heading[2])}</h${heading[1].length}>`,
      );
    else if (/^>\s?/.test(line))
      out.push(
        `<blockquote>${documentInline(line.replace(/^>\s?/, ""))}</blockquote>`,
      );
    else if (/^\s*---+\s*$/.test(line)) out.push("<hr>");
    else if (line.trim()) out.push(`<p>${documentInline(line)}</p>`);
  }
  closeList();
  if (code !== null)
    out.push(`<pre><code>${esc(code.join("\n"))}</code></pre>`);
  return out.join("");
}
async function downloadDocument(agentId, fileId, name) {
  const response = await fetch(
    "/api/files/download?" + new URLSearchParams({ agentId, fileId }),
    { headers: { "x-admin-token": token } },
  );
  if (!response.ok) throw Error("文件下载失败");
  const url = URL.createObjectURL(await response.blob()),
    link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function documentDialog(title) {
  const dialog = document.createElement("dialog");
  dialog.className = "document-reader";
  dialog.setAttribute("aria-label", title);
  dialog.innerHTML = `<header class="document-head"><h2>${esc(title)}</h2><button type="button" data-close>关闭</button></header><div data-document-body>正在读取…</div>`;
  document.body.append(dialog);
  dialog.querySelector("[data-close]").onclick = () => dialog.close();
  dialog.addEventListener("close", () => dialog.remove(), { once: true });
  dialog.showModal();
  return dialog;
}
async function openDocument(agentId, fileId) {
  const dialog = documentDialog("文档阅读");
  let raw = false,
    current,
    request = 0,
    query = "";
  const show = async (offset = 0) => {
    const ticket = ++request;
    let data;
    try {
      data = await api(
        "/api/files/read?" +
          new URLSearchParams({ agentId, fileId, offset, query }),
      );
    } catch (error) {
      if (dialog.isConnected && ticket === request)
        dialog.querySelector("[data-document-body]").textContent =
          error.message;
      return;
    }
    if (!dialog.isConnected || ticket !== request) return;
    current = data;
    dialog.querySelector("h2").textContent = data.name;
    dialog.querySelector("[data-document-body]").innerHTML = `
      <div class="toolbar"><button type="button" data-mode ${data.format === "markdown" ? "" : "hidden"}>${raw ? "排版阅读" : "查看原文"}</button><button type="button" data-copy>复制本页原文</button><button type="button" data-download>下载全文</button></div>
      <form class="toolbar" data-search><label>查找全文<input name="query" value="${esc(query)}" maxlength="200" placeholder="输入关键词"></label><button>查找</button></form>
      ${query ? `<p class="hint">${data.matches.length}${data.matchesLimited ? "+" : ""} 处匹配${data.matches.length ? "，点击跳转：" : ""}</p><div class="document-matches">${data.matches.map((at, i) => `<button type="button" data-match="${at}">${i + 1}</button>`).join("")}</div>` : ""}
      <p class="hint">${data.offset + (data.text ? 1 : 0)}–${data.offset + data.text.length} / ${data.totalChars} 字符${data.totalChars > data.text.length ? " · 分页显示，段落可能跨页" : ""}</p>
      <article class="document-content">${!raw && data.format === "markdown" ? documentMarkdown(data.text, data) : `<pre>${esc(data.text)}</pre>`}</article>
      <div class="toolbar"><button type="button" data-previous ${data.offset ? "" : "disabled"}>上一页</button><button type="button" data-next ${data.nextOffset === null ? "disabled" : ""}>下一页</button></div>
      ${data.projects.length ? `<footer><h3>所属项目</h3>${data.projects.map((p) => `<button type="button" data-project="${esc(p.id)}">${esc(p.title)} · ${p.shared ? "共同活动" : "个人项目"}</button>`).join("")}</footer>` : ""}
      <details><summary>文件详情</summary><p class="mono">${esc(fileId)}</p><p>${esc(data.createdAt)}</p></details>`;
    const bind = (selector, fn) => {
      dialog.querySelector(selector).onclick = () => action(fn);
    };
    bind("[data-mode]", () => {
      raw = !raw;
      return show(data.offset);
    });
    bind("[data-copy]", async () => {
      await navigator.clipboard.writeText(current.text);
      notice("已复制本页原文");
    });
    bind("[data-download]", () => downloadDocument(agentId, fileId, data.name));
    bind("[data-previous]", () => show(Math.max(0, data.offset - 8000)));
    bind("[data-next]", () => show(data.nextOffset));
    dialog.querySelector("[data-search]").onsubmit = (e) => {
      e.preventDefault();
      query = String(new FormData(e.target).get("query") || "");
      action(() => show(0));
    };
    dialog
      .querySelectorAll("[data-match]")
      .forEach(
        (b) =>
          (b.onclick = () =>
            action(() => show(Math.max(0, Number(b.dataset.match) - 200)))),
      );
    dialog
      .querySelectorAll("[data-project]")
      .forEach(
        (b) =>
          (b.onclick = () =>
            action(() => openProjectOverview(agentId, b.dataset.project))),
      );
  };
  await show();
}
async function openProjectOverview(agentId, id) {
  const { project: p, files } = await api(
    "/api/project/files?" + new URLSearchParams({ agentId, id }),
  );
  const dialog = documentDialog(p.title);
  dialog.querySelector("[data-document-body]").innerHTML =
    `<p>${esc(p.why)}</p><p>下一步：${esc(p.next || "尚未记录")}</p><h3>作品与文件</h3>${files.map((f) => `<p>${f.readable ? `<button type="button" data-read="${esc(f.fileId)}">${esc(f.name)}</button>` : esc(f.name)}</p>`).join("") || "<p>尚无文件</p>"}<h3>最近进展</h3>${p.steps.map((s) => `<p>${esc(s.did)}</p>`).join("")}`;
  dialog
    .querySelectorAll("[data-read]")
    .forEach(
      (b) =>
        (b.onclick = () => action(() => openDocument(agentId, b.dataset.read))),
    );
}
