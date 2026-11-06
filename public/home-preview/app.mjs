import { catalog } from "./catalog.mjs";
import { createTemplate } from "./templates.mjs";
import { renderPaperBoard } from "./paper-board.mjs";
import { makeScene, validateScene } from "./scene.mjs";
// Preview preferences never read service credentials or role data.
(() => {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const mobile = matchMedia("(max-width:640px)");
  const KEY = "qq-agents-home-preview-v1";
  const actions = {
    board: "打开留言板",
    guide: "翻开参观小册",
    intro: "查看公开介绍",
    works: "查看作品展示",
    letters: "查看往来信件",
    hall: "去房间走廊",
    living: "返回客厅",
    back: "返回走廊",
  };
  const defaults = {
    count: 3,
    content: "empty",
    state: "ready",
    reduced: true,
    scenes: {},
  };
  let prefs;
  try {
    prefs = { ...defaults, ...JSON.parse(localStorage.getItem(KEY) || "{}") };
  } catch {
    prefs = { ...defaults };
  }
  if (![0, 1, 2, 3, 4, 7].includes(prefs.count)) prefs.count = 3;
  if (
    !prefs.scenes ||
    typeof prefs.scenes !== "object" ||
    Array.isArray(prefs.scenes)
  )
    prefs.scenes = {};
  prefs.content = prefs.content === "sample" ? "sample" : "empty";
  prefs.reduced = prefs.reduced !== false;
  prefs.state = "ready";
  let current,
    lastFocus,
    toastTimer,
    sceneHistory = {},
    selection = "",
    hallReturn = null;
  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  };
  const btn = (text, fn, cls) => {
    const n = el("button", cls, text);
    n.type = "button";
    n.addEventListener("click", fn);
    return n;
  };
  function save() {
    try {
      localStorage.setItem(KEY, JSON.stringify(prefs));
    } catch {
      toast("浏览器未允许保存；当前布置仍可预览和导出。");
    }
  }
  function toast(text) {
    $("toast").textContent = text;
    $("toast").classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => $("toast").classList.remove("show"), 2600);
  }
  function parseRoute() {
    const p = location.hash.slice(1).split("/");
    if (p[0] === "room")
      return {
        type: "room",
        resident: Math.max(1, Math.min(8, Math.trunc(Number(p[1]) || 1))),
      };
    if (p[0] === "hall")
      return {
        type: "hall",
        page: Math.max(
          1,
          Math.min(
            Math.ceil(prefs.count / 3) || 1,
            Math.trunc(Number(p[1]) || 1),
          ),
        ),
      };
    return { type: "living" };
  }
  function sceneKey() {
    return current.type === "room" ? `room-${current.resident}` : current.type;
  }
  function scenePrefs() {
    const key = sceneKey(),
      template = config();
    try {
      const value = validateScene(prefs.scenes[key], template, catalog);
      if (value.sceneId !== key) throw Error("HOME_SCENE_INVALID");
      return value;
    } catch {
      return (prefs.scenes[key] = makeScene(template, key));
    }
  }
  function record() {
    const key = sceneKey();
    (sceneHistory[key] ??= []).push(JSON.stringify(scenePrefs()));
    if (sceneHistory[key].length > 20) sceneHistory[key].shift();
  }
  function config() {
    return createTemplate(current.type, prefs.count, current.page || 1);
  }
  function board(objects, hotspots, cls = "") {
    return renderPaperBoard({
      template: { ...config(), hotspots },
      scene: scenePrefs(),
      mobile: mobile.matches,
      objects,
      kind: cls,
      onAction: act,
      label: (action) =>
        action.startsWith("room:")
          ? `进入示例住户 ${action.split(":")[1]} 的房间`
          : actions[action],
      missing: (o) =>
        prefs.state === "missing" && ["shelf", "board"].includes(o.id),
      decorate: (n, o) => {
        if (o.id.startsWith("sign-")) {
          const id = Number(o.id.slice(5));
          const name = el("span", "door-name", `示例住户 ${id}`);
          name.style.top = "23%";
          n.append(name);
        }
        if (o.id.startsWith("door-")) {
          const id = Number(o.id.slice(5));
          const status = ["在线", "离线", "暂停"][(id - 1) % 3];
          const line = el("span", "door-status");
          line.append(
            el(
              "i",
              `status-dot ${status === "离线" ? "offline" : status === "暂停" ? "paused" : ""}`,
            ),
            document.createTextNode(`${status} · 示例状态`),
          );
          n.append(line);
        }
      },
    });
  }
  function renderStage() {
    const { objects, hotspots } = config();
    const stage = $("stage");
    stage.replaceChildren();
    if (current.type === "room" && current.resident > prefs.count) {
      const b = board([], {});
      const note = el("div", "board-note");
      note.append(
        el("strong", "", "房间不可访问"),
        el("p", "", "该示例住户不在当前列表中。"),
      );
      b.append(note);
      stage.append(b);
      return;
    }
    if (current.type === "hall" && mobile.matches && prefs.count) {
      for (const door of objects.filter((o) => o.id.startsWith("door-"))) {
        const r = door.id.slice(5);
        stage.append(
          board(
            objects.filter(
              (o) =>
                o.id === door.id || o.id === `sign-${r}` || o.id === "plant",
            ),
            hotspots,
            "hall-board",
          ),
        );
      }
    } else {
      const main = board(
        mobile.matches && current.type === "room"
          ? objects.filter((o) => o.zone !== "nook")
          : objects,
        hotspots,
        current.type,
      );
      stage.append(main);
      if (current.type === "hall" && !prefs.count) {
        const note = el("div", "board-note");
        note.append(
          el("strong", "", "走廊还很安静"),
          el("p", "", "当前没有配置居民。可在预览设置中切换示例人数。"),
        );
        main.append(note);
      }
    }
    if (current.type === "room" && mobile.matches) {
      const nook = el("section", "mobile-nook");
      nook.append(
        el("div", "scene-caption", "同一间房 · 休息角"),
        board(
          objects.filter((o) => o.zone === "nook"),
          hotspots,
        ),
      );
      stage.append(nook);
    }
  }
  function actionButton(action, text) {
    return btn(
      text || actions[action],
      () => act(action),
      ["hall", "back"].includes(action) ? "primary" : "",
    );
  }
  function renderNavigation() {
    const crumb = $("breadcrumb");
    crumb.replaceChildren();
    const link = (label, hash) => {
      const a = el("a", "", label);
      a.href = hash;
      return a;
    };
    crumb.append(link("小窝", "#living"));
    if (current.type !== "living") {
      crumb.append(
        el("span", "", "/"),
        link(
          "房间走廊",
          `#hall/${current.type === "room" ? Math.ceil(current.resident / 3) : current.page}`,
        ),
      );
    }
    if (current.type === "room")
      crumb.append(
        el("span", "", "/"),
        el("span", "", `示例住户 ${current.resident}`),
      );
    const a = $("scene-actions");
    a.replaceChildren();
    const page = $("pagination");
    page.replaceChildren();
    if (current.type === "living") {
      a.append(
        actionButton("board"),
        actionButton("guide"),
        actionButton("hall"),
      );
    } else if (current.type === "hall") {
      a.append(actionButton("living"));
      for (
        let i = (current.page - 1) * 3 + 1;
        i <= Math.min(current.page * 3, prefs.count);
        i++
      )
        a.append(actionButton(`room:${i}`, `进入示例住户 ${i} 的房间`));
      const pages = Math.max(1, Math.ceil(prefs.count / 3));
      const prev = btn("← 上一段走廊", () =>
        navigate(`hall/${current.page - 1}`),
      );
      prev.disabled = current.page <= 1;
      const next = btn("下一段走廊 →", () =>
        navigate(`hall/${current.page + 1}`),
      );
      next.disabled = current.page >= pages;
      page.append(prev, el("span", "", `${current.page} / ${pages}`), next);
    } else {
      a.append(actionButton("back"), actionButton("living"));
      if (current.resident <= prefs.count)
        a.append(actionButton("intro"), actionButton("works"));
    }
  }
  function renderStatus() {
    const target = $("state-message");
    target.replaceChildren();
    const messages = {
      empty: "这里还没有公开内容。家具布置与内容发布分别保存。",
      loading: "正在加载示例内容……场景导航仍然可用。",
      denied: "当前无阅读权限。正文、标题和数量均不展示。",
      error: "示例请求失败，请重试。已有导航仍可使用。",
      missing: "部分纸片资源不可用。已显示占位，文字入口继续可用。",
    };
    if (messages[prefs.state]) {
      target.append(el("span", "", messages[prefs.state]));
      if (["loading", "error"].includes(prefs.state))
        target.append(
          btn("重试", () => {
            prefs.state = "ready";
            $("page-state").value = "ready";
            render();
          }),
        );
    }
  }
  function render() {
    current = parseRoute();
    const p = scenePrefs();
    document.body.className = `palette-${p.palette || "cream"} ${prefs.reduced ? "reduce-motion" : ""}`;
    $("title").textContent =
      current.type === "living"
        ? "一起坐一会儿"
        : current.type === "hall"
          ? "每扇门后，都是一页生活"
          : `示例住户 ${current.resident} 的房间`;
    $("eyebrow").textContent =
      current.type === "living"
        ? "第一章 / 客厅"
        : current.type === "hall"
          ? "第二章 / 房间走廊"
          : "第三章 / 个人房间";
    $("subtitle").textContent =
      current.type === "living"
        ? "翻翻留言，看看小册，再去走廊逛一逛。"
        : current.type === "hall"
          ? `${prefs.count} 位示例居民 · 每段最多三间 · 离线也保留房间`
          : "介绍与作品由房主选择公开，保持空白也很好。";
    renderNavigation();
    renderStage();
    renderStatus();
    renderSettings();
    $("stage").dataset.route = location.hash || "#living";
  }
  function navigate(hash) {
    if (current.type === "hall" && hash.startsWith("room/"))
      hallReturn = {
        hash: `#hall/${current.page}`,
        y: window.scrollY,
        resident: hash.split("/")[1],
      };
    if ($("reader").open) $("reader").close();
    location.hash = hash;
  }
  function act(action) {
    if (action === "hall") navigate("hall/1");
    else if (action === "living") navigate("living");
    else if (action === "back")
      navigate(`hall/${Math.ceil(current.resident / 3)}`);
    else if (action.startsWith("room:"))
      navigate(`room/${action.split(":")[1]}`);
    else openReader(action);
  }
  function openReader(action) {
    const dialog = $("reader"),
      content = $("reader-content");
    if (!dialog.open) lastFocus = document.activeElement;
    content.replaceChildren();
    $("reader-title").textContent =
      {
        board: "客厅留言板",
        guide: "参观小册",
        intro: "公开介绍",
        works: "作品展示",
        letters: "往来信件",
      }[action] || "阅读面板";
    if (action === "guide") {
      content.append(
        el(
          "p",
          "",
          "这是手绘立体书风格的场景预览。所有住户、状态与文字样例均为示例，没有连接实际服务。",
        ),
        el(
          "p",
          "",
          "从客厅进入走廊，再进入房间。纸片可替换、移动、缩放和隐藏，文字入口始终保留。手机会重排纸片，使用同一份布置。",
        ),
        el(
          "p",
          "",
          "正常浏览不触发 AI 回合。预览中的布置控件仅供设计评审，正式产品的房间布置权限仍属于获授权的主人格。",
        ),
      );
    } else if (prefs.state === "denied") {
      content.append(
        el("span", "empty-illustration", "⌑"),
        el("p", "", "当前无阅读权限。可以返回场景继续导航。"),
      );
    } else if (prefs.state === "error" || prefs.state === "loading") {
      content.append(
        el(
          "p",
          "",
          prefs.state === "error"
            ? "内容加载失败，请重试。"
            : "正在加载示例内容……",
        ),
        btn("重试", () => {
          prefs.state = "ready";
          $("page-state").value = "ready";
          renderStatus();
          openReader(action);
        }),
      );
    } else if (prefs.content === "empty" || prefs.state === "empty") {
      content.append(
        el("span", "empty-illustration", "▱"),
        el(
          "p",
          "",
          action === "intro"
            ? "尚未公开介绍。"
            : action === "works"
              ? "这里还没有公开作品。"
              : action === "letters"
                ? "信封里还没有示例来信。"
                : "目前没有可见留言。",
        ),
        el("p", "", "这份留白不代表房主正在创作，也不代表房间尚未布置。"),
      );
    } else {
      const card = el("article", "reading-card");
      card.append(
        el("small", "", "示例内容 · 仅用于设计评审"),
        el(
          "h3",
          "",
          action === "board"
            ? "示例留言：一页纸的小空间"
            : action === "intro"
              ? "示例介绍"
              : action === "letters"
                ? "示例信件：下次拜访再接着聊"
                : "示例作品：纸上的房间",
        ),
        el(
          "p",
          "",
          "这是用于检查字号、阅读宽度和换行效果的示例文字，不是任何真实角色的发言或作品。家具可以变化，阅读入口始终清楚。",
        ),
      );
      content.append(card);
      if (action === "works")
        content.append(el("p", "", "其余展示槽位保持空白。"));
    }
    if (!dialog.open) dialog.showModal();
  }
  function renderSettings() {
    $("palette").value = scenePrefs().palette || "cream";
    $("residents").value = String(prefs.count);
    $("page-state").value = prefs.state;
    $("sample-content").value = prefs.content;
    $("motion").checked = prefs.reduced;
    const select = $("object-select");
    const objects = config().objects;
    select.replaceChildren();
    for (const o of objects) {
      const option = el(
        "option",
        "",
        `${catalog[o.asset]?.name || o.asset} · ${o.id}`,
      );
      option.value = o.id;
      select.append(option);
    }
    if (!objects.some((o) => o.id === selection))
      selection = objects[0]?.id || "";
    select.value = selection;
    renderEditor();
    $("undo").disabled = !sceneHistory[sceneKey()]?.length;
  }
  function edit(key, value) {
    const conf = scenePrefs();
    record();
    const p = conf.objects[selection] || (conf.objects[selection] = {});
    p[key] = value;
    save();
    renderStage();
    $("undo").disabled = false;
  }
  function renderEditor() {
    const root = $("object-editor");
    root.replaceChildren();
    const o = config().objects.find((o) => o.id === selection);
    if (!o) {
      root.append(el("p", "", "当前没有可配置纸片。"));
      return;
    }
    const p = scenePrefs().objects[o.id] || {};
    const variants = o.variants;
    const label = el("label", "", "纸片款式");
    const select = el("select");
    select.id = "asset-variant";
    for (const a of variants.filter((a) => catalog[a])) {
      const opt = el("option", "", catalog[a].name);
      opt.value = a;
      select.append(opt);
    }
    select.value = p.asset || o.asset;
    select.addEventListener("change", () => edit("asset", select.value));
    label.append(select);
    root.append(label);
    for (const [key, title, min, max, step, def] of [
      ["dx", "横向偏移", -6, 6, 1, 0],
      ["dy", "纵向偏移", -5, 5, 1, 0],
      ["scale", "大小", 0.8, 1.15, 0.05, 1],
      ["z", "前后层级", 1, 8, 1, o.z],
    ]) {
      const l = el("label", "", `${title}：`);
      const output = el("output", "", String(p[key] ?? def));
      const input = el("input");
      input.type = "range";
      input.min = min;
      input.max = max;
      input.step = step;
      input.value = p[key] ?? def;
      input.setAttribute("aria-label", title);
      input.addEventListener("change", () => {
        output.value = input.value;
        edit(key, Number(input.value));
      });
      l.append(output, input);
      root.append(l);
    }
    for (const [key, text] of [
      ["hidden", "隐藏这张纸片"],
      ["flip", "水平镜像"],
    ]) {
      const l = el("label", "check");
      const input = el("input");
      input.type = "checkbox";
      input.checked = !!p[key];
      input.setAttribute("aria-label", text);
      input.addEventListener("change", () => edit(key, input.checked));
      l.append(input, document.createTextNode(text));
      root.append(l);
    }
    const note = el(
      "p",
      "",
      "此处保存本机预览；真实房间写入、占位与遮挡校验将在后续接入。",
    );
    note.style.gridColumn = "1 / -1";
    root.append(note);
  }
  document.querySelector(".skip").addEventListener("click", (event) => {
    event.preventDefault();
    const target = $("scene-actions");
    target.tabIndex = -1;
    target.focus();
    target.scrollIntoView({ block: "center" });
  });
  $("settings-toggle").addEventListener("click", () => {
    const open = $("settings").hidden;
    $("settings").hidden = !open;
    $("settings-toggle").setAttribute("aria-expanded", String(open));
  });
  $("object-select").addEventListener("change", (e) => {
    selection = e.target.value;
    renderEditor();
  });
  $("palette").addEventListener("change", (e) => {
    record();
    scenePrefs().palette = e.target.value;
    save();
    render();
  });
  $("residents").addEventListener("change", (e) => {
    prefs.count = Number(e.target.value);
    save();
    render();
  });
  $("sample-content").addEventListener("change", (e) => {
    prefs.content = e.target.value;
    save();
    render();
  });
  $("page-state").addEventListener("change", (e) => {
    prefs.state = e.target.value;
    render();
  });
  $("motion").addEventListener("change", (e) => {
    prefs.reduced = e.target.checked;
    save();
    render();
  });
  $("reset").addEventListener("click", () => {
    record();
    prefs.scenes[sceneKey()] = makeScene(config(), sceneKey());
    save();
    render();
    toast("本页已恢复默认布置。");
  });
  $("undo").addEventListener("click", () => {
    const h = sceneHistory[sceneKey()];
    if (h?.length) {
      prefs.scenes[sceneKey()] = JSON.parse(h.pop());
      save();
      render();
      toast("已恢复上次布置。");
    }
  });
  $("export").addEventListener("click", () => {
    const data = scenePrefs();
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }),
    );
    const a = el("a");
    a.href = url;
    a.download = `${sceneKey()}-scene.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
  $("close-reader").addEventListener("click", () => $("reader").close());
  $("reader-back").addEventListener("click", () => $("reader").close());
  $("reader").addEventListener("close", () => {
    if (lastFocus?.isConnected) lastFocus.focus();
  });
  window.addEventListener("hashchange", () => {
    if ($("reader").open) $("reader").close();
    const previous = current.type;
    render();
    if (previous === "room" && hallReturn?.hash === location.hash) {
      const target = document.querySelector(
        `[data-instance="door-${hallReturn.resident}"]`,
      );
      target?.focus({ preventScroll: true });
      window.scrollTo(0, hallReturn.y);
    } else {
      $("title").tabIndex = -1;
      $("title").focus({ preventScroll: true });
      window.scrollTo(0, 0);
    }
  });
  mobile.addEventListener("change", render);
  render();
})();
