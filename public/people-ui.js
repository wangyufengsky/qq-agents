// Person cards: the agent's own notes on how it addresses each person and
// how they get along. A grid gives the overview; a side panel shows one card
// read-only first, with its revisions, and edits it as a new revision.
// Card text is untrusted and always goes through esc().
let peopleOpen = null;
const peopleName = (c) => c.names?.at(-1) || c.personId;
const peopleTime = (t) =>
  new Date(t).toLocaleString([], {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
const peopleAvatar = (c) =>
  `<span class="person-avatar" aria-hidden="true">${esc([...peopleName(c)][0] || "?")}</span>`;
const peopleBy = (author) => (author === "admin" ? "管理员修改" : "角色记录");
function peopleMarkup(cards) {
  const tiles = cards
    .map(
      (c) =>
        `<button type="button" class="person-tile" data-person="${esc(c.personId)}" data-search="${esc([...(c.names || []), c.personId, c.call].join(" ").toLowerCase())}">${peopleAvatar(c)}<span class="person-who"><span class="person-name">${esc(peopleName(c))}</span><span class="person-qq">QQ ${esc(c.personId)}</span></span><span class="person-call${c.call ? "" : " is-empty"}">${c.call ? `叫「${esc(c.call)}」` : "未记称呼"}</span><span class="person-impression">${esc(c.body)}</span><span class="person-meta">v${c.revision} · ${peopleBy(c.author)} · ${peopleTime(c.updatedAt)}</span></button>`,
    )
    .join("");
  return `<section class="card people-card"><div class="people-head"><h2>人物卡${cards.length ? `<span class="people-count">${cards.length}</span>` : ""}</h2>${cards.length > 1 ? '<input type="search" id="people-search" class="people-search" placeholder="搜索名字、QQ 或称呼" aria-label="搜索人物卡">' : ""}</div><p class="hint">角色自己记下的称呼与印象，是看法不是事实；所有群和私聊共用。一次会话里，说话的人、私聊对方，以及被 @ 或被回复的人第一次出现时附上这张卡，卡改过后再附一次。最近更新的在前。</p>${cards.length ? `<div class="people-grid" id="people-grid">${tiles}</div><p class="hint" id="people-none" hidden>没有匹配的人物卡。</p>` : '<div class="people-empty"><strong>还没有人物卡</strong><p class="hint">角色会在聊天中用 person_note 记下怎么称呼一个人、和他关系怎样。</p></div>'}<dialog class="people-drawer" id="people-drawer" aria-labelledby="person-title"></dialog></section>`;
}
// The current card and its earlier revisions, newest first, each noting
// what changed from the one before it.
function personVersions(c) {
  const all = [c, ...(c.history || [])];
  return all
    .map((v, i) => {
      const older = all[i + 1],
        changes = !older
          ? ["第一次记下"]
          : [
              older.call !== v.call &&
                `称呼 ${older.call ? `「${esc(older.call)}」` : "未记"} → ${v.call ? `「${esc(v.call)}」` : "未记"}`,
              older.body !== v.body && "印象有改动",
            ].filter(Boolean);
      return `<li${i === 0 ? ' class="is-current"' : ""}><span class="person-rev">v${v.revision}</span><div><div class="person-rev-head"><strong>${changes.join(" · ") || "内容未变"}</strong><time>${peopleTime(v.updatedAt)}</time></div><p>${esc(v.body)}</p><small>${peopleBy(v.author)}${v.call ? ` · 叫「${esc(v.call)}」` : ""}</small><div class="person-rev-sent" data-rev-sent="${Number(v.revision)}" hidden></div></div></li>`;
    })
    .join("");
}
// Moods whose cited messages came from this person, and diaries that name
// them, newest first. References only; the full records stay where they are.
function personMoods(c) {
  if (!c.moods?.length) return "";
  return `<div class="person-field"><span class="person-label">相关心情</span><ol class="person-links">${c.moods.map((x) => `<li><div class="person-link-head">${x.action === "clear" ? "<strong>心情过去了</strong>" : `<strong>${esc(x.mood)}</strong><span class="person-link-meta">强度 ${Number(x.intensity)}/5</span>`}<time>${peopleTime(x.writtenAt)}</time></div><p>${esc(x.reason)}</p></li>`).join("")}</ol></div>`;
}
function personDiaries(c) {
  if (!c.diaries?.length) return "";
  return `<div class="person-field"><span class="person-label">相关日记</span><ol class="person-links">${c.diaries.map((d) => `<li><div class="person-link-head"><button type="button" class="person-link-open" data-read-diary="${esc(d.id)}" title="阅读这篇日记">${esc(d.title)}</button><time>${peopleTime(d.updatedAt)}</time></div></li>`).join("")}</ol></div>`;
}
// Filled in when the panel opens (/api/person-card/links): what was sent under
// each version of the card, and where the person spoke lately.
function personSent(group) {
  return `<details class="person-sent"><summary>这一版下发出 ${Number(group.count)} 条</summary><ol class="person-links">${group.recent.map((s) => `<li><div class="person-link-head"><span class="person-link-meta">${esc(conversationLabel(s.conversation))}</span><time>${peopleTime(s.at)}</time></div><p>${esc(s.text)}</p><button type="button" class="ghost" data-read-record="${esc(s.id)}">读原文</button></li>`).join("")}</ol>${group.count > group.recent.length ? `<p class="hint">另有 ${group.count - group.recent.length} 条更早的</p>` : ""}</details>`;
}
function personChats(chats) {
  return `<span class="person-label">最近聊天</span><ol class="person-links">${chats.map((x, i) => `<li><div class="person-link-head"><strong>${esc(conversationLabel(x.conversation))}</strong><time>${peopleTime(x.lastAt)}</time></div><p class="person-link-meta">说过 ${Number(x.messages)} 条</p><button type="button" class="ghost" data-chat="${i}">看最近一次发言的前后文</button></li>`).join("")}</ol>`;
}
function personDetail(c) {
  const names = (c.names || []).filter(Boolean);
  return `<div class="people-drawer-body"><header class="person-head">${peopleAvatar(c)}<div><h2 id="person-title">${esc(peopleName(c))}</h2><span class="person-qq">QQ ${esc(c.personId)}</span></div><button type="button" class="ghost" id="person-close" aria-label="关闭">关闭</button></header><div id="person-view" class="person-view"><div class="person-field"><span class="person-label">怎么称呼</span><span class="person-call big${c.call ? "" : " is-empty"}">${c.call ? esc(c.call) : "未记称呼"}</span></div><div class="person-field"><span class="person-label">关系与印象</span><p class="person-body">${esc(c.body)}</p></div>${names.length ? `<div class="person-field"><span class="person-label">QQ 曾用名</span><div class="person-names">${names.map((n) => `<span>${esc(n)}</span>`).join("")}</div></div>` : ""}${personMoods(c)}${personDiaries(c)}<div class="person-field" id="person-chats" hidden></div><p class="person-source">v${c.revision} · ${peopleBy(c.author)} · ${peopleTime(c.updatedAt)}${c.evidence?.length ? ` · <span title="${esc(c.evidence.join("\n"))}">来源 ${c.evidence.length} 条记录</span>` : ""}</p><div class="card-actions"><button type="button" class="primary" id="person-edit">修改</button></div></div><form id="person-form" class="person-form" hidden>${input("call", "称呼", c.call, 'maxlength="40"')}<label class="wide">关系与印象<textarea name="body" maxlength="600" required>${esc(c.body)}</textarea></label><p class="hint">保存后生成新版本；角色下次在会话里见到这个人时会看到你改过的卡，并标明是管理员修改的。</p><div class="card-actions"><button class="primary">保存新版本</button><button type="button" id="person-cancel">取消</button></div></form><div class="person-field"><span class="person-label">版本记录</span><ol class="person-versions">${personVersions(c)}</ol></div><div class="person-danger"><button type="button" class="ghost danger" id="person-delete">删除这张人物卡</button><span class="hint">连同旧版本一起删除，角色之后可以重新记下。</span></div></div>`;
}
// The mood timeline (mood-ui.js) asks for a card by its person.
document.addEventListener("open-person-card", (e) => {
  peopleOpen = e.detail;
  tab = "people";
  render();
});
// Other pages name a person and open the card from there. A page with its own
// role picker (memory, activity, contacts) may show another role than the one
// selected, so switch to the page's role first.
function openPersonCard(agentId, personId) {
  roleId = agentId;
  document.dispatchEvent(
    new CustomEvent("open-person-card", { detail: personId }),
  );
}
// "QQ 名（叫「称呼」）" for someone with a card; the call is untrusted text.
const personCallText = (call) => (call ? `叫「${esc(call)}」` : "未记称呼");
const personCardButton = (personId) =>
  `<button type="button" class="ghost person-open" data-open-person="${esc(personId)}" title="打开 QQ ${esc(personId)} 的人物卡">人物卡</button>`;
function bindPersonCards(root, agentId) {
  root
    .querySelectorAll("[data-open-person]")
    .forEach(
      (b) => (b.onclick = () => openPersonCard(agentId, b.dataset.openPerson)),
    );
}
function bindPeople(cards, agentId) {
  const drawer = $("#people-drawer");
  if (!drawer) return;
  const byId = new Map(cards.map((c) => [c.personId, c]));
  const open = (id) => {
    const c = byId.get(id);
    if (!c) {
      peopleOpen = null;
      return;
    }
    peopleOpen = id;
    drawer.innerHTML = personDetail(c);
    if (!drawer.open) drawer.showModal();
    const view = $("#person-view"),
      form = $("#person-form"),
      editing = (on) => {
        view.hidden = on;
        form.hidden = !on;
      };
    $("#person-close").onclick = () => drawer.close();
    const reads = (root) => {
      root
        .querySelectorAll("[data-read-diary]")
        .forEach(
          (b) =>
            (b.onclick = () => readMemory(b.dataset.readDiary, { agentId })),
        );
      root
        .querySelectorAll("[data-read-record]")
        .forEach(
          (b) =>
            (b.onclick = () => readMemory(b.dataset.readRecord, { agentId })),
        );
    };
    reads(drawer);
    api(
      "/api/person-card/links?" +
        new URLSearchParams({ agentId, personId: c.personId }),
    )
      .then((links) => {
        // The panel may have moved on to another card, or closed.
        if (peopleOpen !== c.personId || !drawer.open) return;
        for (const group of links.sent) {
          const slot = drawer.querySelector(
            `[data-rev-sent="${Number(group.revision)}"]`,
          );
          if (!slot) continue;
          slot.innerHTML = personSent(group);
          slot.hidden = false;
          reads(slot);
        }
        const chats = $("#person-chats");
        if (!chats || !links.chats.length) return;
        chats.innerHTML = personChats(links.chats);
        chats.hidden = false;
        chats.querySelectorAll("[data-chat]").forEach((b) => {
          const x = links.chats[Number(b.dataset.chat)];
          b.onclick = () =>
            readConversation({
              agentId,
              conversation: x.conversation,
              connectionId: x.connectionId,
              aroundId: x.lastId,
              contextSeconds: 1800,
            });
        });
      })
      // The card itself is already shown; its links are extra.
      .catch(() => {});
    $("#person-edit").onclick = () => {
      editing(true);
      form.querySelector("textarea").focus();
    };
    $("#person-cancel").onclick = () => {
      form.reset();
      editing(false);
    };
    form.onsubmit = (e) => {
      e.preventDefault();
      action(async () => {
        const f = new FormData(form);
        await api("/api/person-card", {
          agentId,
          action: "edit",
          personId: c.personId,
          expectedRevision: c.revision,
          call: f.get("call"),
          body: f.get("body"),
        });
        await renderMind();
        notice("人物卡已保存为新版本");
      });
    };
    $("#person-delete").onclick = () => {
      if (!confirm("删除这张人物卡和它的旧版本？角色之后可以重新记下。"))
        return;
      action(async () => {
        await api("/api/person-card", {
          agentId,
          action: "delete",
          personId: c.personId,
          expectedRevision: c.revision,
        });
        peopleOpen = null;
        drawer.close();
        await renderMind();
      });
    };
  };
  document
    .querySelectorAll("[data-person]")
    .forEach((tile) => (tile.onclick = () => open(tile.dataset.person)));
  // A click on the backdrop lands on the dialog itself.
  drawer.onclick = (e) => {
    if (e.target === drawer) drawer.close();
  };
  drawer.onclose = () => (peopleOpen = null);
  const search = $("#people-search");
  if (search)
    search.oninput = () => {
      const q = search.value.trim().toLowerCase();
      let shown = 0;
      document
        .querySelectorAll("#people-grid [data-person]")
        .forEach((tile) => {
          tile.hidden = !!q && !tile.dataset.search.includes(q);
          if (!tile.hidden) shown++;
        });
      $("#people-none").hidden = shown > 0;
    };
  // Reopen the card being edited after the page re-renders.
  if (peopleOpen) open(peopleOpen);
}
