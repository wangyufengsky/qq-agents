import { createSocialView } from "./social.mjs";
import { decorateSceneObject } from "./scene-decoration.mjs";
import { catalog } from "../home-preview/catalog.mjs";
import { createTemplate } from "../home-preview/templates.mjs";
import { makeScene } from "../home-preview/scene.mjs";
import { paperElement as el } from "../home-preview/paper-board.mjs";
import { renderBookScene, createPageTurn, turnDirection } from "./book.mjs";
import { renderGuide, renderBoardPreferences } from "./interiors.mjs";
const pageTurn = createPageTurn(document.getElementById("stage"));
const $ = (id) => document.getElementById(id),
  mobile = matchMedia("(max-width:640px)");
const labels = {
  living: "返回客厅",
  hall: "去房间走廊",
  back: "返回走廊",
  board: "打开留言板",
  guide: "翻开参观小册",
  intro: "查看介绍卡",
  works: "查看作品展示",
  letters: "查看往来信件",
};
const hints = {
  HOME_REVISION_CONFLICT:
    "布局已有新版本，请重读后核对，旧草稿没有覆盖新布置。",
  HOME_ROSTER_CONFLICT: "居民列表已变化，请重读后再布置。",
  HOME_REQUEST_CONFLICT: "这个保存请求与已处理的内容不同，请重读后再操作。",
  HOME_LAYOUT_BOUNDS: "部分纸片超出纸板，请缩小或调整位置。",
  HOME_LAYOUT_OVERLAP: "家具重叠过多，请调整位置。",
  HOME_SCENE_INVALID: "布置不符合素材或配置规则。",
  HOME_ITEM_CONFLICT: "条目已变化，请重新读取后核对。",
  HOME_IDENTITY_CHANGED: "房间身份已变化，请重新读取。",
  HOME_WRITE_DENIED: "当前没有修改此空间的权限。",
  HOME_ROOM_NOT_FOUND: "房间已不存在，请返回走廊。",
  UPDATE_IN_PROGRESS: "服务维护中，请稍后重试。",
};
let overview = null,
  envelope = null,
  draft = null,
  route = null,
  dirty = false,
  editing = false,
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
  socialView = null,
  pending = null,
  contentTimer,
  contentTicket = 0;
let desktopState = null,
  desktopRequest = 0,
  desktopTimer,
  desktopChanging = false;
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
  clearTimeout(contentTimer);
  contentTicket++;
  socialView?.close();
  socialView = null;
  boardView?.close();
  boardView = null;
  if ($("reader").open) $("reader").close();
  readerAction = "";
  pageTurn.clear();
  for (const id of ["entries", "menu"]) if ($(id).open) $(id).close();
  editing = false;
  $("editor").hidden = true;
  document.body.classList.remove("editing");
  $("home-tools").hidden = true;
  $("desktop-controls").hidden = true;
  clearTimeout(desktopTimer);
  desktopRequest++;
  desktopState = null;
  desktopChanging = false;
  $("stage").inert = false;
  for (const id of [
    "stage",
    "scene-actions",
    "pagination",
    "reader-content",
    "object-editor",
    "object-strip",
    "object-select",
  ])
    $(id).replaceChildren();
  for (const id of [
    "title",
    "subtitle",
    "folio",
    "layout-status",
    "selected-object",
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
  if ([401, 403, 410].includes(response.status)) {
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
  if (`#${hash}` === location.hash) return;
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
  if ($("entries").open) $("entries").close();
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
  if (editing && envelope?.capabilities.write) {
    node.classList.add("editable-piece");
    node.classList.toggle("selected-piece", selection === o.id);
    node.tabIndex = 0;
    node.setAttribute("role", "button");
    node.setAttribute("aria-label", `布置${catalog[o.asset].name}`);
    const choose = (event) => {
      event.preventDefault();
      event.stopImmediatePropagation();
      selection = o.id;
      editor();
      draw();
      $("stage")
        .querySelector(`[data-instance="${CSS.escape(o.id)}"]`)
        ?.focus({ preventScroll: true });
    };
    node.addEventListener("click", choose, true);
    node.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") choose(event);
    });
  }
  decorateSceneObject(node, o, {
    type: route.type,
    residents: overview.residents,
    ownerAgentId: route.agentId,
  });
}
function draw(direction = 0) {
  if (!overview || !envelope) return Promise.resolve();
  const t = template(),
    stage = $("stage"),
    page = el("div", "book-page"),
    face = el("div", "book-face"),
    scene = renderBookScene({
      template: t,
      scene: draft,
      mobile: mobile.matches,
      kind: route.type,
      onAction: act,
      label: actionLabel,
      decorate,
    });
  document.body.className = `palette-${draft.palette}`;
  document.body.classList.toggle(
    "editing",
    editing && envelope.capabilities.write,
  );
  const heading = el("div", "book-heading"),
    chapter = { living: "第 一 页", hall: "第 二 页", room: "第 三 页" }[
      route.type
    ],
    title =
      route.type === "living"
        ? "客厅"
        : route.type === "hall"
          ? "走廊"
          : `${name(route.agentId)} 的房间`;
  heading.append(el("span", "", chapter), el("h2", "", title));
  const corner = button(
    route.type === "living"
      ? "去走廊"
      : route.type === "hall"
        ? "回客厅"
        : "回走廊",
    () =>
      act(
        route.type === "living"
          ? "hall"
          : route.type === "hall"
            ? "living"
            : "back",
      ),
  );
  corner.className = "page-corner";
  corner.setAttribute("aria-label", `翻页${corner.textContent}`);
  face.append(scene, heading, corner);
  page.append(face);
  if (route.type === "hall" && !overview.residents.length) {
    const note = el("div", "board-note");
    note.append(
      el("strong", "", "走廊还很安静"),
      el("p", "", "当前尚未配置居民。"),
    );
    face.append(note);
  }
  stage.dataset.route = location.hash || "#living";
  $("title").textContent = title;
  $("folio").textContent =
    `${{ living: "01", hall: "02", room: "03" }[route.type]} / ${title}`;
  for (const type of ["living", "hall"]) {
    const active =
      route.type === type || (type === "hall" && route.type === "room");
    if (active) $("bookmark-" + type).setAttribute("aria-current", "page");
    else $("bookmark-" + type).removeAttribute("aria-current");
  }
  $("page-back").hidden = route.type === "living";
  $("page-back").textContent = route.type === "hall" ? "← 客厅" : "← 走廊";
  $("subtitle").textContent =
    route.type === "hall"
      ? `${overview.residents.length} 位居民 · 离线也保留房间`
      : route.type === "room"
        ? "房间由主人格布置，介绍和作品只展示主人格明确发布的文字。"
        : overview.boardEnabled
          ? "翻翻留言，再去走廊逛一逛。"
          : "留言板对角色暂未开放；管理员仍可浏览和管理。";
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
        : ["back", "living", "intro", "works", "letters"];
  actions.forEach((a) => nav.append(button(actionLabel(a), () => act(a))));
  $("pagination").replaceChildren();
  if (route.type === "hall" && overview.residents.length > 3) {
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
  $("editor").hidden = !editing || !envelope.capabilities.write;
  $("edit-toggle").hidden = !envelope.capabilities.write;
  $("edit-toggle").textContent =
    `${editing ? "收起布置" : "布置"}${dirty ? " · 未保存" : ""}`;
  $("edit-toggle").setAttribute("aria-expanded", String(editing));
  $("layout-status").textContent = blocked
    ? "布置已有变化，请重读后核对。"
    : dirty
      ? "正在试摆，记得保存。"
      : "布置已收好。";
  $("save").disabled = !dirty || blocked;
  $("undo").disabled = dirty || blocked || envelope.layoutRevision === 0;
  return pageTurn.show(page, direction);
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
  const strip = $("object-strip");
  strip.replaceChildren();
  for (const object of t.objects) {
    const asset = catalog[draft.objects[object.id]?.asset || object.asset];
    const choice = button("", () => {
      selection = object.id;
      editor();
      draw();
      strip
        .querySelector(`[data-object="${CSS.escape(object.id)}"]`)
        ?.focus({ preventScroll: true });
    });
    choice.dataset.object = object.id;
    choice.setAttribute("aria-label", `选择${asset.name}`);
    choice.setAttribute("aria-pressed", String(selection === object.id));
    const art = el("img");
    art.src = new URL(`../home-preview/${asset.file}`, import.meta.url).href;
    art.alt = "";
    choice.append(art, el("span", "", asset.name));
    strip.append(choice);
  }
  $("palette").value = draft.palette;
  editorFields();
}
function editorFields() {
  const root = $("object-editor");
  root.replaceChildren();
  const o = template().objects.find((o) => o.id === selection);
  if (!o) return;
  $("selected-object").textContent =
    catalog[draft.objects[o.id]?.asset || o.asset].name;
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
    input.oninput = () => {
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
async function refresh(animate = false) {
  pageTurn.finish();
  $("stage").inert = true;
  $("editor").inert = true;
  $("entry-toggle").disabled = true;
  $("edit-toggle").disabled = true;
  if ($("entries").open) $("entries").close();
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
    $("home-tools").hidden = false;
    if ($("desktop-controls").hidden) {
      $("desktop-controls").hidden = false;
      void refreshDesktopControls();
    }
    if (animate || !next.capabilities.write) editing = false;
    $("editor-more").open = false;
    const drawing = draw(animate ? turnDirection(oldRoute, nextRoute) : 0);
    editor();
    await drawing;
    if (request !== ticket) return;
    $("stage").inert = false;
    $("editor").inert = false;
    $("entry-toggle").disabled = false;
    $("edit-toggle").disabled = false;
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
async function loadContent() {
  if (
    !overview ||
    route?.type !== "room" ||
    !["intro", "works"].includes(readerAction)
  )
    return;
  const request = ++contentTicket,
    pageTicket = ticket,
    owner = route.agentId,
    action = readerAction;
  try {
    const value = await api(
      "/api/home/content?" + new URLSearchParams({ agentId: owner }),
    );
    if (
      request !== contentTicket ||
      pageTicket !== ticket ||
      !$("reader").open ||
      readerAction !== action
    )
      return;
    if (value.identityGeneration !== envelope.identityGeneration) {
      clearView("房间身份已变化，请重新读取。");
      return;
    }
    clearTimeout(contentTimer);
    const root = $("reader-content");
    const openItems = new Set(
      [...root.querySelectorAll(".home-text-card")]
        .filter((card) => card.querySelector("details")?.open)
        .map((card) => card.dataset.slot),
    );
    const readingPositions = new Map(
      [...root.querySelectorAll(".home-text-card")].map((card) => [
        card.dataset.slot,
        {
          revision: card.dataset.revision,
          top: card.querySelector(".home-text")?.scrollTop || 0,
        },
      ]),
    );
    root.replaceChildren();
    if (!value.publishing)
      root.append(
        el("p", "display-note", "这里暂时安静，等主人放上新的文字。"),
      );
    const items = value.items.filter((i) =>
      action === "intro"
        ? ["intro", "tagline"].includes(i.slot)
        : i.slot.startsWith("work-"),
    );
    for (const item of items) {
      const card = el("section", "home-text-card");
      card.dataset.slot = item.slot;
      card.dataset.revision = String(item.itemRevision);
      card.append(
        el(
          "h3",
          "",
          item.visible
            ? item.title
            : item.slot === "tagline"
              ? "门牌短语"
              : item.slot === "intro"
                ? "介绍卡"
                : `作品 ${item.slot.slice(5)}`,
        ),
      );
      card.append(
        el(
          "p",
          "home-text",
          item.visible
            ? item.body
            : item.state === "hidden"
              ? "内容已被管理员隐藏。"
              : item.state === "retracted"
                ? "主人格已撤回此内容。"
                : "尚未展示文字。",
        ),
      );
      const management = el("details", "item-management");
      if (item.source)
        management.append(
          el(
            "p",
            "display-note",
            `来源：项目原稿 ${item.source.id} · 固定版本 ${item.source.revision}`,
          ),
        );
      management.open = openItems.has(item.slot);
      management.append(
        el("summary", "", "管理这张纸"),
        el("small", "", `条目版本 ${item.itemRevision}`),
      );
      if (item.state === "published" || item.state === "hidden")
        management.append(
          button(
            item.state === "hidden"
              ? "解除隐藏限制（不恢复正文）"
              : "隐藏此内容",
            async () => {
              if (
                !confirm(
                  item.state === "hidden"
                    ? "解除后仍为空白，需要主人格重新选择发布，继续吗？"
                    : "隐藏会清除当前展示正文，并阻止普通重发，继续吗？",
                )
              )
                return;
              root.replaceChildren(el("p", "", "正在更新展示状态…"));
              clearTimeout(contentTimer);
              contentTicket++;
              try {
                await api(
                  "/api/home/moderate?" +
                    new URLSearchParams({ agentId: owner }),
                  {
                    identityGeneration: value.identityGeneration,
                    slot: item.slot,
                    expectedItemRevision: item.itemRevision,
                    requestId: crypto.randomUUID(),
                    action: item.state === "hidden" ? "release" : "hide",
                  },
                );
              } catch (e) {
                toast(e.message);
              }
              await loadContent();
            },
          ),
        );
      card.append(management);
      root.append(card);
      // A lease refresh must not move the reader back to the top of unchanged text.
      const position = readingPositions.get(item.slot);
      if (position?.revision === card.dataset.revision)
        card.querySelector(".home-text").scrollTop = position.top;
    }
    contentTimer = setTimeout(() => {
      contentTicket++;
      root.replaceChildren(
        el("p", "", "内容验证已到期，已隐藏旧正文；连接恢复后重新读取。"),
      );
    }, 15000);
  } catch (e) {
    if (request === contentTicket) {
      clearTimeout(contentTimer);
      $("reader-content").replaceChildren(
        el("p", "", "无法确认内容状态，已隐藏旧正文。"),
      );
      toast(e.message);
    }
  }
}
function renderDesktopControls(loading = false) {
  const toggle = $("desktop-toggle"),
    reopen = $("desktop-reopen");
  toggle.disabled = desktopChanging || loading;
  toggle.textContent = desktopState
    ? desktopState.enabled
      ? "关闭桌面小窝"
      : "开启桌面小窝"
    : loading
      ? "桌面小窝"
      : "重试读取桌面小窝";
  toggle.dataset.enabled = String(desktopState?.enabled === true);
  reopen.hidden =
    !desktopState?.enabled ||
    !desktopState.canLaunch ||
    desktopState.window === "open";
  reopen.disabled = desktopChanging || desktopState?.window === "opening";
  reopen.textContent =
    {
      opening: "打开中…",
      failed: "重试打开",
    }[desktopState?.window] ?? "打开窗口";
}

async function refreshDesktopControls(enabled) {
  clearTimeout(desktopTimer);
  const request = ++desktopRequest;
  const changing = typeof enabled === "boolean";
  desktopChanging = changing;
  renderDesktopControls(!changing && !desktopState);
  try {
    const next = await api(
      "/api/desktop-home",
      changing ? { enabled } : undefined,
    );
    if (request !== desktopRequest) return;
    if (
      changing ||
      (desktopState?.window === "opening" && next.window !== "opening")
    ) {
      toast(
        next.enabled
          ? {
              open: "桌面窗口已打开。",
              opening: "正在打开桌面窗口…",
              failed: "桌面窗口启动失败，可以再试一次。",
              idle: "桌面小窝已开启。",
            }[next.window]
          : "桌面小窝已关闭。",
      );
    }
    desktopState = next;
  } catch (error) {
    if (changing && request === desktopRequest)
      toast(
        error.code === "DESKTOP_VISIT_UNAVAILABLE"
          ? "请先在管理台恢复运行，再打开桌面小窝。"
          : error.message,
      );
  } finally {
    if (request === desktopRequest) {
      desktopChanging = false;
      renderDesktopControls();
      desktopTimer = setTimeout(
        () => void refreshDesktopControls(),
        desktopState?.window === "opening" ? 1000 : 10000,
      );
    }
  }
}

async function desktopSettings(root, ticket) {
  const active = () => readerAction === "desktop" && contentTicket === ticket;
  root.append(el("p", "", "正在读取桌面小窝设置…"));
  try {
    const current = await api("/api/config");
    if (!active()) return;
    const policy = current.config.desktopHome;
    const form = el("form", "social-settings desktop-settings");
    function roleCheckboxes(title, enabled) {
      const group = el("fieldset", "desktop-tools");
      group.append(el("legend", "", title));
      const checkboxes = current.config.agents.map((agent) => {
        const label = el("label", "", agent.name);
        const input = document.createElement("input");
        input.type = "checkbox";
        input.value = agent.id;
        input.checked = enabled.includes(agent.id);
        label.prepend(input);
        group.append(label);
        return input;
      });
      form.append(group);
      return checkboxes;
    }
    const checkedRoles = (checkboxes) =>
      checkboxes.filter((input) => input.checked).map((input) => input.value);
    const fields = [
      ["maxTurns", "共用回合上限", 1, 24],
      ["refreshMinutes", "额度补满间隔（分钟）", 0, 1440],
    ];
    const inputs = {};
    for (const [key, title, min, max] of fields) {
      const label = el("label", "desktop-field", title);
      const input = document.createElement("input");
      input.type = "number";
      input.required = true;
      input.min = String(min);
      input.max = String(max);
      input.value = String(policy[key]);
      label.append(input);
      inputs[key] = input;
      form.append(label);
    }
    form.append(
      el(
        "p",
        "social-notice",
        "你发新消息也会补满额度。间隔设为 0 时，由新消息补满。",
      ),
    );
    const roleInputs = roleCheckboxes(
      "允许在桌面使用额外工具",
      policy.toolRoles,
    );
    form.append(
      el(
        "p",
        "social-notice",
        "角色仍受自己的工具和文件权限约束。联系 QQ 由同角色的主人格审阅，再交给目标 QQ 会话。",
      ),
    );
    const bodyInputs = roleCheckboxes(
      "允许控制自己的桌宠",
      policy.bodyControlRoles,
    );
    const activityInputs = roleCheckboxes(
      "允许在场时自主活动",
      policy.activityRoles,
    );
    const interactionsLabel = el("label", "desktop-field", "启用桌宠互动");
    const interactionsEnabled = document.createElement("input");
    interactionsEnabled.type = "checkbox";
    interactionsEnabled.checked = policy.interactionsEnabled;
    interactionsLabel.prepend(interactionsEnabled);
    const preferencesGroup = el("fieldset", "social-budget");
    preferencesGroup.append(el("legend", "", "角色生活偏好"));
    const preferenceInputs = current.config.agents.map(({ id, name }) => {
      const preference = Object.hasOwn(policy.residentPreferences, id)
        ? policy.residentPreferences[id]
        : {};
      const group = el("fieldset", "desktop-tools");
      group.append(el("legend", "", name));
      const quietLabel = el("label", "desktop-field", "安静模式");
      const quiet = document.createElement("input");
      quiet.type = "checkbox";
      quiet.checked = preference.quiet === true;
      quietLabel.prepend(quiet);
      const cadenceLabel = el("label", "desktop-field", "自主活动间隔");
      const cadence = document.createElement("select");
      const defaultOption = el("option", "", "使用小窝默认间隔");
      defaultOption.value = "";
      cadence.append(defaultOption);
      for (let minutes = 2; minutes <= 30; minutes++) {
        const option = el("option", "", `${minutes} 分钟`);
        option.value = String(minutes);
        cadence.append(option);
      }
      cadence.value = preference.activityMinutes ?? "";
      cadenceLabel.append(cadence);
      group.append(quietLabel, cadenceLabel);
      preferencesGroup.append(group);
      return { id, quiet, cadence };
    });
    preferencesGroup.append(
      el(
        "p",
        "social-notice",
        "安静模式暂停该角色的自主活动。活动仍受每小时额度和休息时段限制。",
      ),
    );
    form.append(interactionsLabel, preferencesGroup);
    const perception = policy.publicPerception;
    const perceptionGroup = el("fieldset", "social-budget");
    perceptionGroup.append(el("legend", "", "公共感知与自主唤醒"));
    const perceptionLabel = el(
      "label",
      "desktop-field",
      "启用公共感知与自主唤醒",
    );
    const perceptionEnabled = document.createElement("input");
    perceptionEnabled.type = "checkbox";
    perceptionEnabled.checked = perception.enabled;
    perceptionLabel.prepend(perceptionEnabled);
    perceptionGroup.append(
      perceptionLabel,
      el(
        "p",
        "social-notice",
        "桌边发言对所有在场角色公开。自主活动与休息仍按角色设置。",
      ),
    );
    const perceptionInputs = Object.fromEntries(
      Object.entries(current.desktopPublicFields ?? {}).map(
        ([key, [title, min, max]]) => {
          const label = el("label", "desktop-field", title);
          const input = document.createElement("input");
          input.type = "number";
          input.required = true;
          input.min = String(min);
          input.max = String(max);
          input.value = String(perception[key]);
          label.append(input);
          perceptionGroup.append(label);
          return [key, input];
        },
      ),
    );
    form.append(perceptionGroup);
    const screenLabel = el("label", "desktop-field", "允许在本机授权看桌面");
    const screenEnabled = document.createElement("input");
    screenEnabled.type = "checkbox";
    screenEnabled.checked = policy.screenView.enabled;
    screenLabel.prepend(screenEnabled);
    const nativeLabel = el("label", "desktop-field", "允许在本机授权操作窗口");
    const nativeEnabled = document.createElement("input");
    nativeEnabled.type = "checkbox";
    nativeEnabled.checked = policy.nativeControl.enabled;
    nativeLabel.prepend(nativeEnabled);
    const browserLabel = el("label", "desktop-field", "允许在本机授权浏览网页");
    const browserEnabled = document.createElement("input");
    browserEnabled.type = "checkbox";
    browserEnabled.checked = policy.browserControl.enabled;
    browserLabel.prepend(browserEnabled);
    const observationLabel = el(
      "label",
      "desktop-field",
      "允许在本机授权自主观察窗口",
    );
    const observationEnabled = document.createElement("input");
    observationEnabled.type = "checkbox";
    observationEnabled.checked = policy.autonomousObservation;
    observationLabel.prepend(observationEnabled);
    form.append(screenLabel, nativeLabel, browserLabel, observationLabel);
    const legacyObservation = policy.observationRoles === undefined;
    const separateObservation = document.createElement("input");
    separateObservation.type = "checkbox";
    if (legacyObservation) {
      const separateLabel = el(
        "label",
        "desktop-field",
        "使用独立观察角色名单",
      );
      separateLabel.prepend(separateObservation);
      form.append(separateLabel);
    }
    const observationInputs = roleCheckboxes(
      "可获窗口观察授权的角色",
      policy.observationRoles ?? policy.activityRoles,
    );
    const initialObservationRoles = JSON.stringify(
      checkedRoles(observationInputs),
    );
    const updateObservationInputs = () => {
      for (const input of observationInputs)
        input.disabled = legacyObservation && !separateObservation.checked;
    };
    if (legacyObservation) {
      separateObservation.addEventListener("change", updateObservationInputs);
      updateObservationInputs();
      form.append(
        el(
          "p",
          "social-notice",
          "当前沿用自主活动角色。勾选后可以单独选择可观察的角色。",
        ),
      );
    }
    form.append(
      el(
        "p",
        "social-notice",
        "角色须获准自主活动和看屏。每次到访仍需在桌面小窝授权一个窗口。",
      ),
    );
    const retentionLabel = el(
      "label",
      "desktop-field",
      "已保存观察摘要的保留期限",
    );
    const retention = document.createElement("select");
    for (let days = 1; days <= 30; days++) {
      const option = el("option", "", `${days} 天`);
      option.value = String(days);
      retention.append(option);
    }
    retention.value = String(policy.observationRetentionDays);
    retentionLabel.append(retention);
    form.append(retentionLabel);
    const status = el("p", "social-notice");
    status.setAttribute("role", "status");
    const save = el("button", "primary", "保存桌面设置");
    save.type = "submit";
    form.append(save, status);
    root.replaceChildren(form);
    let busy = false;
    const fieldsToLock = [
      ...Object.values(inputs),
      ...roleInputs,
      ...bodyInputs,
      ...activityInputs,
      ...observationInputs,
      ...preferenceInputs.flatMap(({ quiet, cadence }) => [quiet, cadence]),
      interactionsEnabled,
      perceptionEnabled,
      ...Object.values(perceptionInputs),
      retention,
      screenEnabled,
      observationEnabled,
      separateObservation,
      nativeEnabled,
      browserEnabled,
      save,
    ];
    form.onsubmit = async (event) => {
      event.preventDefault();
      if (!form.reportValidity() || busy) return;
      busy = true;
      for (const field of fieldsToLock) field.disabled = true;
      status.textContent = "";
      const observationRoles = checkedRoles(observationInputs);
      const residentPreferences = { ...policy.residentPreferences };
      for (const { id, quiet, cadence } of preferenceInputs) {
        delete residentPreferences[id];
        if (quiet.checked || cadence.value)
          residentPreferences[id] = {
            ...(quiet.checked && { quiet: true }),
            ...(cadence.value && { activityMinutes: Number(cadence.value) }),
          };
      }
      const limits = {
        interactionsEnabled: interactionsEnabled.checked,
        publicPerception: {
          enabled: perceptionEnabled.checked,
          ...Object.fromEntries(
            Object.entries(perceptionInputs).map(([key, field]) => [
              key,
              field.valueAsNumber,
            ]),
          ),
        },
        residentPreferences,
        maxTurns: inputs.maxTurns.valueAsNumber,
        refreshMinutes: inputs.refreshMinutes.valueAsNumber,
        screenView: { enabled: screenEnabled.checked },
        autonomousObservation: observationEnabled.checked,
        observationRetentionDays: Number(retention.value),
        ...((legacyObservation
          ? separateObservation.checked
          : JSON.stringify(observationRoles) !== initialObservationRoles) && {
          observationRoles,
        }),
        nativeControl: { enabled: nativeEnabled.checked },
        browserControl: { enabled: browserEnabled.checked },
        activityRoles: checkedRoles(activityInputs),
        bodyControlRoles: checkedRoles(bodyInputs),
        toolRoles: checkedRoles(roleInputs),
      };
      try {
        const current = await api("/api/config");
        if (!active()) return;
        const existing = current.config.desktopHome;
        if (
          existing.maxTurns !== policy.maxTurns ||
          existing.interactionsEnabled !== policy.interactionsEnabled ||
          JSON.stringify(existing.publicPerception) !==
            JSON.stringify(perception) ||
          JSON.stringify(existing.residentPreferences) !==
            JSON.stringify(policy.residentPreferences) ||
          existing.refreshMinutes !== policy.refreshMinutes ||
          existing.screenView.enabled !== policy.screenView.enabled ||
          existing.autonomousObservation !== policy.autonomousObservation ||
          existing.observationRetentionDays !==
            policy.observationRetentionDays ||
          JSON.stringify(existing.observationRoles) !==
            JSON.stringify(policy.observationRoles) ||
          existing.nativeControl.enabled !== policy.nativeControl.enabled ||
          existing.browserControl.enabled !== policy.browserControl.enabled ||
          JSON.stringify(existing.activityRoles) !==
            JSON.stringify(policy.activityRoles) ||
          JSON.stringify(existing.bodyControlRoles) !==
            JSON.stringify(policy.bodyControlRoles) ||
          JSON.stringify(existing.toolRoles) !==
            JSON.stringify(policy.toolRoles)
        ) {
          await desktopSettings(root, ticket);
          if (active()) toast("桌面小窝设置已更新，请核对后再保存。");
          return;
        }
        await api(
          "/api/config",
          {
            config: {
              ...current.config,
              desktopHome: { ...existing, ...limits },
            },
            revision: current.revision,
          },
          "PUT",
        );
        if (active()) {
          await desktopSettings(root, ticket);
          if (active()) toast("桌面小窝设置已保存。");
        }
      } catch (error) {
        if (active()) status.textContent = error.message;
      } finally {
        busy = false;
        for (const field of fieldsToLock) field.disabled = false;
        updateObservationInputs();
      }
    };
  } catch (error) {
    if (active()) root.replaceChildren(el("p", "", error.message));
  }
}

function openReader(action) {
  if (!overview || !envelope || $("stage").inert) return;
  $("reader").dataset.kind = action;
  const dialog = $("reader");
  if (!dialog.open) lastFocus = document.activeElement;
  clearTimeout(contentTimer);
  contentTicket++;
  readerAction = action;
  socialView?.close();
  socialView = null;
  boardView?.close();
  boardView = null;
  $("reader-content").replaceChildren();
  $("reader-title").textContent = {
    board: "客厅留言板",
    guide: "参观小册",
    intro: "介绍卡",
    works: "作品展示",
    social: "往来管理",
    desktop: "桌面小窝设置",
    letters: `${name(route.agentId)}的信件`,
  }[action];
  if (action === "desktop") {
    if (!dialog.open) dialog.showModal();
    void desktopSettings($("reader-content"), contentTicket);
    return;
  }
  if (action === "social" || action === "letters") {
    socialView = createSocialView({
      root: $("reader-content"),
      api,
      isActive: () => dialog.open && readerAction === action && !!overview,
      ...(action === "letters"
        ? {
            roomOwnerAgentId: route.agentId,
            presentation: "letters",
          }
        : {}),
    });
    if (!dialog.open) dialog.showModal();
    socialView.render();
    return;
  }
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
        `<details class="board-settings"><summary>留言板约定</summary><div class="board-settings-body"><p>${esc(summary)}</p>${body}</div></details>`,
      operate: () =>
        renderBoardPreferences({
          root: $("reader-content").querySelector(".board-settings-body"),
          api,
          isActive: () => dialog.open && readerAction === "board" && !!overview,
          onSaved: () => boardView?.render(),
          onError: (error) => toast(error.message),
        }),
    });
    dialog.showModal();
    boardView.render().catch((e) => toast(e.message));
    return;
  }
  if (["intro", "works"].includes(action)) {
    $("reader-content").append(el("p", "", "正在读取已发布文字…"));
    if (!dialog.open) dialog.showModal();
    loadContent();
    return;
  }
  renderGuide($("reader-content"));
  if (!dialog.open) dialog.showModal();
}
$("reader").addEventListener("close", () => {
  clearTimeout(contentTimer);
  contentTicket++;
  socialView?.close();
  socialView = null;
  boardView?.close();
  boardView = null;
  readerAction = "";
  $("reader-content").replaceChildren();
  if (lastFocus?.isConnected && lastFocus.getClientRects().length)
    lastFocus.focus();
  else if (overview) $("entry-toggle").focus();
});
$("close-reader").onclick = $("reader-back").onclick = () =>
  $("reader").close();
$("brand-home").onclick = (e) => {
  e.preventDefault();
  if (overview) act("living");
};
$("console-return").onclick = (event) => {
  if (dirty && !confirm("离开后会放弃尚未保存的草稿，继续吗？"))
    event.preventDefault();
};
$("bookmark-living").onclick = () => act("living");
$("bookmark-hall").onclick = () => act(route.type === "room" ? "back" : "hall");
$("page-back").onclick = () => act(route.type === "hall" ? "living" : "back");
$("entry-toggle").onclick = () => $("entries").showModal();
$("menu-toggle").onclick = () => $("menu").showModal();
for (const id of ["entries", "menu"]) {
  $("close-" + id).onclick = () => $(id).close();
  $(id).addEventListener("click", (event) => {
    if (event.target === $(id)) {
      const r = $(id).getBoundingClientRect();
      if (
        event.clientX < r.left ||
        event.clientX > r.right ||
        event.clientY < r.top ||
        event.clientY > r.bottom
      )
        $(id).close();
    }
  });
}
function setEditing(open) {
  editing = open && envelope?.capabilities.write === true;
  $("editor-more").open = false;
  draw();
  if (editing) {
    window.scrollTo(0, 0);
    $("editor-close").focus({ preventScroll: true });
  } else $("edit-toggle").focus({ preventScroll: true });
}
$("edit-toggle").onclick = () => setEditing(!editing);
$("editor-close").onclick = () => setEditing(false);
$("editor-more").addEventListener("click", (event) => {
  if (event.target.closest("button")) {
    $("editor-more").open = false;
    $("editor-more").querySelector("summary").focus({ preventScroll: true });
  }
});
document.addEventListener("keydown", (event) => {
  if (
    event.key !== "Escape" ||
    !editing ||
    document.querySelector("dialog[open]")
  )
    return;
  event.preventDefault();
  if ($("editor-more").open) {
    $("editor-more").open = false;
    $("editor-more").querySelector("summary").focus();
  } else setEditing(false);
});
$("palette").onchange = () => {
  draft.palette = $("palette").value;
  dirty = true;
  pending = null;
  draw();
};
$("object-select").onchange = () => {
  selection = $("object-select").value;
  editor();
  draw();
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
  if (!dirty || confirm("放弃尚未保存的草稿并重读？")) {
    if ($("menu").open) $("menu").close();
    refresh();
  }
};
$("retry").onclick = () => refresh();
$("gate-hall").onclick = () => {
  if (location.hash === "#hall/1") refresh();
  else location.hash = "hall/1";
};
window.addEventListener("hashchange", () => {
  if ($("reader").open) $("reader").close();
  refresh(true);
});
mobile.addEventListener("change", () => {
  if (overview && envelope) draw();
});
document.querySelector(".skip").onclick = (e) => {
  e.preventDefault();
  if (overview) $("entries").showModal();
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
    if (["intro", "works"].includes(readerAction)) await loadContent();
    if (currentTicket !== ticket) return;
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
refresh().then(() => {
  if (
    new URLSearchParams(location.search).get("open") === "board" &&
    overview
  ) {
    history.replaceState(null, "", "/home-space/" + location.hash);
    openReader("board");
  }
});

$("desktop-toggle").onclick = () =>
  refreshDesktopControls(desktopState ? !desktopState.enabled : undefined);
$("desktop-reopen").onclick = () => refreshDesktopControls(true);

$("desktop-open").onclick = () => {
  $("menu").close();
  openReader("desktop");
};

$("social-open").onclick = () => {
  $("menu").close();
  openReader("social");
};
