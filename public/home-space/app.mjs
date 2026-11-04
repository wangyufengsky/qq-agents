import { catalog } from "../home-preview/catalog.mjs";
import { createTemplate } from "../home-preview/templates.mjs";
import { makeScene } from "../home-preview/scene.mjs";
import {
  renderPaperBoard,
  paperElement as el,
} from "../home-preview/paper-board.mjs";
const $ = (id) => document.getElementById(id),
  mobile = matchMedia("(max-width:640px)");
const labels = {
  living: "返回客厅",
  hall: "去房间走廊",
  back: "返回走廊",
  board: "打开留言板",
  guide: "翻开参观小册",
  intro: "查看公开介绍",
  works: "查看作品展示",
};
const hints = {
  HOME_REVISION_CONFLICT:
    "布局已有新版本，请重读后核对，旧草稿没有覆盖新布置。",
  HOME_ROSTER_CONFLICT: "居民列表已变化，请重读后再布置。",
  HOME_REQUEST_CONFLICT: "这个保存请求与已处理的内容不同，请重读后再操作。",
  HOME_LAYOUT_BOUNDS: "部分纸片超出纸板，请缩小或调整位置。",
  HOME_LAYOUT_OVERLAP: "家具重叠过多，请调整位置。",
  HOME_SCENE_INVALID: "布置不符合素材或配置规则。",
  HOME_WRITE_DENIED: "当前没有修改此空间的权限。",
  HOME_ROOM_NOT_FOUND: "房间已不存在，请返回走廊。",
  UPDATE_IN_PROGRESS: "服务维护中，请稍后重试。",
};
let overview = null,
  envelope = null,
  draft = null,
  route = null,
  dirty = false,
  blocked = false,
  selection = "",
  ticket = 0,
  epoch = 0,
  lease = 0,
  leaseTimer,
  toastTimer,
  returnHall = null,
  lastFocus = null,
  readerAction = "",
  boardView = null,
  pending = null;
const esc = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
function button(text, fn) {
  const n = el("button", "", text);
  n.type = "button";
  n.onclick = fn;
  return n;
}
function token() {
  try {
    return sessionStorage.getItem("qq-unified-token") || "";
  } catch {
    return "";
  }
}
function toast(text) {
  $("toast").textContent = text;
  $("toast").classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => $("toast").classList.remove("show"), 3500);
}
function clearView(message = "登录或连接需要重新验证。") {
  epoch++;
  ticket++;
  clearTimeout(leaseTimer);
  lease = 0;
  overview = null;
  envelope = null;
  draft = null;
  pending = null;
  dirty = false;
  blocked = false;
  boardView?.close();
  boardView = null;
  if ($("reader").open) $("reader").close();
  readerAction = "";
  for (const id of [
    "stage",
    "scene-actions",
    "breadcrumb",
    "pagination",
    "reader-content",
    "object-editor",
    "object-select",
  ])
    $(id).replaceChildren();
  for (const id of [
    "title",
    "subtitle",
    "eyebrow",
    "layout-status",
    "save-status",
  ])
    $(id).textContent = "";
  $("home-content").hidden = true;
  $("gate").hidden = false;
  $("gate").querySelector("p").textContent = message;
}
async function api(url, body, method) {
  const startEpoch = epoch,
    credential = token();
  if (!credential) {
    clearView("请先在管理台登录，再返回小窝。");
    throw Error("UNAUTHORIZED");
  }
  let response;
  try {
    response = await fetch(url, {
      method: method || (body === undefined ? "GET" : "POST"),
      headers: {
        "x-admin-token": credential,
        "content-type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      cache: "no-store",
      signal: AbortSignal.timeout(8000),
    });
  } catch {
    if (startEpoch === epoch)
      clearView("连接中断，已隐藏旧页面。连接恢复后请重新读取。");
    throw Error("HOME_CONNECTION_LOST");
  }
  if (startEpoch !== epoch || credential !== token())
    throw Error("HOME_VIEW_EXPIRED");
  if (response.status === 401 || response.status === 403) {
    clearView("登录已失效或当前没有权限，请重新登录。");
    throw Error("UNAUTHORIZED");
  }
  const value = await response.json();
  if (!response.ok) {
    const e = Error(hints[value.error] || "请求失败，请重新读取后重试。");
    e.code = value.error;
    throw e;
  }
  return value;
}
function renewLease() {
  lease = Date.now() + 15000;
  clearTimeout(leaseTimer);
  leaseTimer = setTimeout(() => {
    if (Date.now() >= lease) clearView("连接验证已到期，请重新读取。");
  }, 15050);
}
function parseRoute() {
  const parts = location.hash.slice(1).split("/");
  if (parts[0] === "room") {
    let id = "";
    try {
      id = decodeURIComponent(parts[1] || "");
    } catch {
      /* Invalid links never select another owner. */
    }
    return { type: "room", agentId: id };
  }
  if (parts[0] === "hall")
    return {
      type: "hall",
      page: Math.max(
        1,
        Math.min(
          Math.ceil(overview.residents.length / 3) || 1,
          Math.trunc(Number(parts[1]) || 1),
        ),
      ),
    };
  return { type: "living" };
}
function sceneURL(r) {
  return (
    "/api/home/scene?" +
    new URLSearchParams({
      type: r.type,
      ...(r.type === "room" ? { agentId: r.agentId } : {}),
    })
  );
}
function template() {
  return createTemplate(
    route.type,
    route.type === "hall" ? overview.residents.length : 3,
    route.page || 1,
    route.type === "hall" ? overview.residents.map((r) => r.id) : null,
  );
}
function name(id) {
  return overview?.residents.find((r) => r.id === id)?.name || "房间已不存在";
}
function actionLabel(action) {
  return action.startsWith("room:")
    ? `进入 ${overview.residents[Number(action.slice(5)) - 1]?.name || "住户"} 的房间`
    : labels[action];
}
function navigate(hash) {
  if (dirty && !confirm("离开后会放弃尚未保存的草稿，继续吗？")) return;
  if (route?.type === "hall" && hash.startsWith("room/"))
    returnHall = {
      hash: `#hall/${route.page}`,
      y: scrollY,
      id: decodeURIComponent(hash.slice(5)),
    };
  location.hash = hash;
}
function act(action) {
  if (action === "living" || action === "hall")
    navigate(action === "hall" ? "hall/1" : "living");
  else if (action === "back") {
    const at = overview.residents.findIndex((r) => r.id === route.agentId);
    navigate(`hall/${Math.max(1, Math.floor(at / 3) + 1)}`);
  } else if (action.startsWith("room:")) {
    const r = overview.residents[Number(action.slice(5)) - 1];
    if (r) navigate("room/" + encodeURIComponent(r.id));
  } else openReader(action);
}
function decorate(node, o) {
  if (route.type !== "hall") return;
  if (o.id.startsWith("sign-")) {
    const n = el("span", "door-name", name(o.id.slice(5)));
    n.style.top = "23%";
    node.append(n);
  }
  if (o.id.startsWith("door-")) {
    const state = overview.residents.find((r) => r.id === o.id.slice(5))?.state;
    const tag = el("span", "door-status");
    tag.append(
      el(
        "i",
        `status-dot ${state === "online" ? "" : state === "paused" ? "paused" : "offline"}`,
      ),
      document.createTextNode(
        { online: "在线", offline: "离线", paused: "暂停" }[state] ||
          "状态未知",
      ),
    );
    node.append(tag);
  }
}
function draw() {
  if (!overview || !envelope) return;
  const t = template(),
    stage = $("stage"),
    board = (objects, kind = "") =>
      renderPaperBoard({
        template: t,
        scene: draft,
        mobile: mobile.matches,
        objects,
        kind,
        onAction: act,
        label: actionLabel,
        decorate,
      });
  document.body.className = `palette-${draft.palette} reduce-motion`;
  stage.replaceChildren();
  if (route.type === "hall" && mobile.matches && overview.residents.length) {
    for (const door of t.objects.filter((o) => o.id.startsWith("door-")))
      stage.append(
        board(
          t.objects.filter(
            (o) =>
              o.id === door.id ||
              o.id === "sign-" + door.id.slice(5) ||
              o.id === "plant",
          ),
          "hall-board",
        ),
      );
  } else
    stage.append(
      board(
        t.objects.filter(
          (o) =>
            !(mobile.matches && route.type === "room" && o.zone === "nook"),
        ),
        route.type,
      ),
    );
  if (route.type === "hall" && !overview.residents.length) {
    const note = el("div", "board-note");
    note.append(
      el("strong", "", "走廊还很安静"),
      el("p", "", "当前尚未配置居民。"),
    );
    stage.firstChild.append(note);
  }
  if (route.type === "room" && mobile.matches) {
    const nook = el("section", "mobile-nook");
    nook.append(
      el("div", "scene-caption", "同一间房 · 休息角"),
      board(t.objects.filter((o) => o.zone === "nook")),
    );
    stage.append(nook);
  }
  stage.dataset.route = location.hash || "#living";
  $("title").textContent =
    route.type === "living"
      ? "一起坐一会儿"
      : route.type === "hall"
        ? "每扇门后，都是一页生活"
        : `${name(route.agentId)} 的房间`;
  $("eyebrow").textContent = {
    living: "第一章 / 客厅",
    hall: "第二章 / 房间走廊",
    room: "第三章 / 个人房间",
  }[route.type];
  $("subtitle").textContent =
    route.type === "hall"
      ? `${overview.residents.length} 位居民 · 离线也保留房间`
      : route.type === "room"
        ? "房间布置由主人格决定。介绍与作品发布功能尚未接入。"
        : overview.boardEnabled
          ? "翻翻留言，再去走廊逛一逛。"
          : "留言板对角色暂未开放；管理员仍可浏览和管理。";
  const crumbs = $("breadcrumb");
  crumbs.replaceChildren(button("客厅", () => act("living")));
  if (route.type !== "living")
    crumbs.append(
      el("span", "", " / "),
      button("房间走廊", () =>
        route.type === "room" ? act("back") : act("hall"),
      ),
    );
  if (route.type === "room")
    crumbs.append(el("span", "", ` / ${name(route.agentId)}`));
  const nav = $("scene-actions");
  nav.replaceChildren();
  const actions =
    route.type === "living"
      ? ["board", "guide", "hall"]
      : route.type === "hall"
        ? [
            "living",
            ...Object.values(t.hotspots).filter(
              (x, i, a) => a.indexOf(x) === i,
            ),
          ]
        : ["back", "living", "intro", "works"];
  actions.forEach((a) => nav.append(button(actionLabel(a), () => act(a))));
  $("pagination").replaceChildren();
  if (route.type === "hall") {
    const max = Math.max(1, Math.ceil(overview.residents.length / 3)),
      prev = button("← 上一段走廊", () => navigate(`hall/${route.page - 1}`)),
      next = button("下一段走廊 →", () => navigate(`hall/${route.page + 1}`));
    prev.disabled = route.page <= 1;
    next.disabled = route.page >= max;
    $("pagination").append(
      prev,
      el("span", "", `${route.page} / ${max}`),
      next,
    );
  }
  $("editor").hidden = !envelope.capabilities.write;
  $("layout-status").textContent =
    `布局版本 ${envelope.layoutRevision}${dirty ? " · 草稿尚未保存" : ""}${blocked ? " · 已有变化，请重读后核对" : ""}`;
  $("save").disabled = !dirty || blocked;
  $("undo").disabled = dirty || blocked || envelope.layoutRevision === 0;
}
function edit(key, value) {
  if (!envelope?.capabilities.write) return;
  pending = null;
  const p = (draft.objects[selection] ||= {});
  p[key] = value;
  dirty = true;
  draw();
}
function editor() {
  if (!envelope?.capabilities.write) return;
  const t = template(),
    select = $("object-select");
  select.replaceChildren();
  for (const o of t.objects) {
    const label = o.id.startsWith("door-")
      ? `房门 · ${name(o.id.slice(5))}`
      : o.id.startsWith("sign-")
        ? `门牌 · ${name(o.id.slice(5))}`
        : catalog[o.asset].name;
    const opt = el("option", "", label);
    opt.value = o.id;
    select.append(opt);
  }
  if (!t.objects.some((o) => o.id === selection))
    selection = t.objects[0]?.id || "";
  select.value = selection;
  $("palette").value = draft.palette;
  editorFields();
}
function editorFields() {
  const root = $("object-editor");
  root.replaceChildren();
  const o = template().objects.find((o) => o.id === selection);
  if (!o) return;
  const p = draft.objects[o.id] || {};
  const l = el("label", "", "款式"),
    s = el("select");
  s.id = "asset-variant";
  for (const id of o.variants) {
    const opt = el("option", "", catalog[id].name);
    opt.value = id;
    s.append(opt);
  }
  s.value = p.asset || o.asset;
  s.onchange = () => edit("asset", s.value);
  l.append(s);
  root.append(l);
  for (const [key, title, min, max, step, def] of [
    ["dx", "横向偏移", -6, 6, 1, 0],
    ["dy", "纵向偏移", -5, 5, 1, 0],
    ["scale", "大小", 0.8, 1.15, 0.05, 1],
    ["z", "前后层级", 1, 8, 1, o.z],
  ]) {
    const label = el("label", "", title),
      input = el("input"),
      out = el("output", "", String(p[key] ?? def));
    input.type = "range";
    input.min = min;
    input.max = max;
    input.step = step;
    input.value = p[key] ?? def;
    input.setAttribute("aria-label", title);
    input.onchange = () => {
      out.value = input.value;
      edit(key, Number(input.value));
    };
    label.append(input, out);
    root.append(label);
  }
  for (const [key, title] of [
    ["hidden", "隐藏这张纸片"],
    ["flip", "水平镜像"],
  ]) {
    const label = el("label", "check"),
      input = el("input");
    input.type = "checkbox";
    input.checked = !!p[key];
    input.setAttribute("aria-label", title);
    input.onchange = () => edit(key, input.checked);
    label.append(input, document.createTextNode(title));
    root.append(label);
  }
}
async function refresh() {
  const request = ++ticket,
    oldRoute = route,
    oldFocus = returnHall;
  try {
    const info = await api("/api/home/overview");
    if (request !== ticket) return;
    overview = info;
    const nextRoute = parseRoute(),
      next = await api(sceneURL(nextRoute));
    if (request !== ticket) return;
    if (next.rosterRevision !== info.rosterRevision)
      throw Error("居民列表已变化，请重试。");
    route = nextRoute;
    envelope = next;
    draft = structuredClone(next.layout);
    dirty = false;
    blocked = false;
    pending = null;
    renewLease();
    $("gate").hidden = true;
    $("home-content").hidden = false;
    draw();
    editor();
    $("save-status").textContent = "";
    if (oldRoute?.type === "room" && oldFocus?.hash === location.hash) {
      document
        .querySelector(`[data-instance="${CSS.escape("door-" + oldFocus.id)}"]`)
        ?.focus({ preventScroll: true });
      window.scrollTo(0, oldFocus.y);
    } else {
      $("title").tabIndex = -1;
      $("title").focus({ preventScroll: true });
      window.scrollTo(0, 0);
    }
  } catch (e) {
    if (request === ticket) {
      clearView(hints[e.code] || e.message);
    }
  }
}
async function save(undo = false) {
  if (!envelope?.capabilities.write || blocked) return;
  const start = ticket;
  pending ||= {
    requestId: crypto.randomUUID(),
    expectedRevision: envelope.layoutRevision,
    rosterRevision: envelope.rosterRevision,
    ...(undo
      ? { undoRevision: envelope.layoutRevision - 1 }
      : { layout: structuredClone(draft) }),
  };
  $("save").disabled = true;
  $("undo").disabled = true;
  try {
    await api(sceneURL(route), pending, "PUT");
    if (start !== ticket) return;
    pending = null;
    await refresh();
    toast(undo ? "已生成撤销后的新版本。" : "布置已保存。");
  } catch (e) {
    if (start !== ticket) return;
    if (
      [
        "HOME_REVISION_CONFLICT",
        "HOME_ROSTER_CONFLICT",
        "HOME_REQUEST_CONFLICT",
      ].includes(e.code)
    )
      blocked = true;
    else if (e.code) pending = null;
    $("save-status").textContent = e.message;
    draw();
  }
}
function openReader(action) {
  const dialog = $("reader");
  if (!dialog.open) lastFocus = document.activeElement;
  readerAction = action;
  boardView?.close();
  boardView = null;
  $("reader-content").replaceChildren();
  $("reader-title").textContent = {
    board: "客厅留言板",
    guide: "参观小册",
    intro: "公开介绍",
    works: "作品展示",
  }[action];
  if (action === "board") {
    boardView = window.createBoardView({
      getRoot: () => $("reader-content"),
      isActive: () => dialog.open && readerAction === "board" && !!overview,
      api,
      esc,
      notice: toast,
      action: (fn) =>
        Promise.resolve()
          .then(fn)
          .catch((e) => toast(e.message)),
      fold: (id, title, body, { summary }) =>
        `<details class="card"><summary>${esc(title)} · ${esc(summary)}</summary>${body}</details>`,
      operate: () => {
        location.href = "/?view=board";
      },
    });
    dialog.showModal();
    boardView.render().catch((e) => toast(e.message));
    return;
  }
  $("reader-content").append(
    el(
      "p",
      "",
      action === "guide"
        ? "这里展示本实例已配置的居民。离线和暂停不移除房间；浏览不会唤醒角色。公共布置由管理员保存，个人房间写入与内容发布将在主人格工具接入后开放。"
        : action === "intro"
          ? "尚未公开介绍。"
          : "这里还没有公开作品。",
    ),
  );
  if (!dialog.open) dialog.showModal();
}
$("reader").addEventListener("close", () => {
  boardView?.close();
  boardView = null;
  readerAction = "";
  $("reader-content").replaceChildren();
  if (lastFocus?.isConnected) lastFocus.focus();
});
$("close-reader").onclick = $("reader-back").onclick = () =>
  $("reader").close();
$("palette").onchange = () => {
  draft.palette = $("palette").value;
  dirty = true;
  pending = null;
  draw();
};
$("object-select").onchange = () => {
  selection = $("object-select").value;
  editorFields();
};
$("save").onclick = () => save();
$("undo").onclick = () => save(true);
$("reset").onclick = () => {
  draft = { ...makeScene(template(), route.type), kind: "scene-layout" };
  dirty = true;
  pending = null;
  draw();
  editor();
};
$("discard").onclick = $("refresh").onclick = () => {
  if (!dirty || confirm("放弃尚未保存的草稿并重读？")) refresh();
};
$("retry").onclick = refresh;
$("gate-hall").onclick = () => {
  if (location.hash === "#hall/1") refresh();
  else location.hash = "hall/1";
};
window.addEventListener("hashchange", () => {
  if ($("reader").open) $("reader").close();
  refresh();
});
mobile.addEventListener("change", () => {
  if (overview && envelope) draw();
});
document.querySelector(".skip").onclick = (e) => {
  e.preventDefault();
  $("scene-actions").tabIndex = -1;
  $("scene-actions").focus();
};
document.addEventListener("visibilitychange", () => {
  if (document.hidden) clearView("页面已隐藏，返回后重新验证。");
  else refresh();
});
window.addEventListener("pageshow", (event) => {
  if (event.persisted) {
    clearView();
    refresh();
  }
});
window.addEventListener("focus", () => {
  if (!document.hidden && overview && !lease) refresh();
});
setInterval(async () => {
  if (document.hidden || !overview) return;
  const currentTicket = ticket;
  try {
    const info = await api("/api/home/overview");
    if (currentTicket !== ticket) return;
    if (info.rosterRevision !== overview.rosterRevision) {
      clearView("居民列表已变化，正在重新读取。");
      await refresh();
      return;
    }
    const presentationChanged =
      JSON.stringify(info) !== JSON.stringify(overview);
    overview = info;
    if (presentationChanged) {
      draw();
      editor();
    }
    renewLease();
    if (!dirty) {
      const next = await api(sceneURL(route));
      // Editing may begin while the layout request is in flight.
      if (currentTicket !== ticket || dirty) return;
      if (next.layoutRevision !== envelope.layoutRevision) {
        envelope = next;
        draft = structuredClone(next.layout);
        draw();
        editor();
      }
    }
  } catch {
    /* api clears inaccessible content and the lease bounds stale reads. */
  }
}, 10000);
refresh();
