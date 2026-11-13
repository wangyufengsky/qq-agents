const editorBridge = globalThis.spaceEditor;
const dom = globalThis.document;
const surface = dom.querySelector("#surface");
const list = dom.querySelector("#zones");
const display = dom.querySelector("#display");
const status = dom.querySelector("#status");
const save = dom.querySelector("#save");
const cancel = dom.querySelector("#cancel");
let state;
let zones = [];
let drag;
let dirty = false;
let saving = false;
let switching = false;

function element(rect, index) {
  const zone = dom.createElement("div");
  zone.className = index === undefined ? "zone draft" : "zone";
  for (const [property, value] of [
    ["left", rect.x],
    ["top", rect.y],
    ["width", rect.width],
    ["height", rect.height],
  ])
    zone.style[property] = 100 * value + "%";
  if (index !== undefined) zone.textContent = String(index + 1);
  return zone;
}

function render() {
  surface.replaceChildren(...zones.map(element));
  list.replaceChildren(
    ...zones.map((_zone, index) => {
      const item = dom.createElement("li");
      const remove = dom.createElement("button");
      remove.type = "button";
      remove.textContent = "删除禁停区 " + (index + 1);
      remove.addEventListener("click", () => {
        zones.splice(index, 1);
        dirty = true;
        render();
        (
          list.children[Math.min(index, list.children.length - 1)]
            ?.firstChild ?? save
        ).focus();
      });
      item.append(remove);
      return item;
    }),
  );
  const hint = state.unavailable
    ? state.unavailable + " 台未连接显示器的设置已保留。"
    : "";
  status.textContent = dirty ? hint + "保存或关闭后可切换显示器。" : hint;
  display.disabled = dirty || state.displays.length < 2;
  save.disabled = !dirty || saving;
  cancel.textContent = dirty ? "放弃并关闭" : "关闭";
}

function apply(next) {
  if (!next) return;
  state = next;
  zones = [...next.zones];
  display.replaceChildren(
    ...next.displays.map(({ id, label }, index) => {
      const option = dom.createElement("option");
      option.value = id;
      option.textContent = label || "显示器 " + (index + 1);
      return option;
    }),
  );
  display.value = next.displayId;
  render();
}

function point(event) {
  const clamp = (value) => Math.max(0, Math.min(1, value));
  return {
    x: clamp(event.clientX / surface.clientWidth),
    y: clamp(event.clientY / surface.clientHeight),
  };
}

function rectangle(event) {
  const end = point(event);
  return {
    x: Math.min(drag.start.x, end.x),
    y: Math.min(drag.start.y, end.y),
    width: Math.abs(drag.start.x - end.x),
    height: Math.abs(drag.start.y - end.y),
  };
}

surface.addEventListener("pointerdown", (event) => {
  if (event.button !== 0 || drag || !state || saving || switching) return;
  if (zones.length >= state.limit) {
    status.textContent = "此显示器已达到禁停区数量上限。";
    return;
  }
  drag = { id: event.pointerId, start: point(event) };
  surface.setPointerCapture(drag.id);
});
surface.addEventListener("pointermove", (event) => {
  if (event.pointerId !== drag?.id) return;
  surface.querySelector(".draft")?.remove();
  surface.append(element(rectangle(event)));
});
surface.addEventListener("pointerup", (event) => {
  if (event.pointerId !== drag?.id) return;
  const rect = rectangle(event);
  drag = undefined;
  if (
    rect.width * surface.clientWidth >= 4 &&
    rect.height * surface.clientHeight >= 4
  ) {
    zones.push(rect);
    dirty = true;
  }
  render();
});
surface.addEventListener("pointercancel", (event) => {
  if (event.pointerId !== drag?.id) return;
  drag = undefined;
  render();
});
display.addEventListener("change", async () => {
  const previous = state;
  switching = true;
  display.disabled = true;
  const next = await editorBridge
    .select(Number(display.value))
    .catch(() => undefined);
  switching = false;
  apply(next ?? previous);
});
save.addEventListener("click", async () => {
  if (saving) return;
  saving = true;
  save.disabled = true;
  const saved = await editorBridge.save(zones).catch(() => false);
  saving = false;
  if (saved) {
    dirty = false;
    render();
    status.textContent = "禁停区已保存。" + status.textContent;
  } else {
    save.disabled = false;
    status.textContent = "无法保存禁停区，请重试。";
  }
});
cancel.addEventListener("click", editorBridge.close);
dom.addEventListener("keydown", (event) => {
  if (event.key === "Escape") editorBridge.close();
});
void editorBridge.get().then(apply);
