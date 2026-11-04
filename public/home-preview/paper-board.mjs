import { catalog } from "./catalog.mjs";
import { resolveScene } from "./scene.mjs";
export function paperElement(tag, className = "", text) {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
export function renderPaperBoard({
  template,
  scene,
  mobile = false,
  objects = template.objects,
  kind = "",
  onAction = () => {},
  label = (action) => action,
  decorate = () => {},
  missing = () => false,
}) {
  const el = paperElement,
    board = el("div", `board ${kind}`),
    base = el("img", "board-base");
  base.src = new URL(catalog[template.boardAssetId].file, import.meta.url).href;
  base.alt = "暖纸纹房间纸板";
  base.draggable = false;
  board.append(base);
  const resolved = new Map(
    resolveScene(scene, template, catalog, mobile).map((o) => [o.id, o]),
  );
  for (const o of objects) {
    const v = resolved.get(o.id);
    if (v.hidden) continue;
    const action = template.hotspots[o.id],
      node = el(action ? "button" : "div", "paper-object");
    if (action) {
      node.type = "button";
      node.addEventListener("click", () => onAction(action));
      node.setAttribute("aria-label", label(action));
    }
    node.dataset.instance = o.id;
    node.dataset.asset = v.asset;
    node.style.left = `${v.x}%`;
    node.style.bottom = `${100 - v.y}%`;
    node.style.width = `${v.w}%`;
    node.style.zIndex = String(v.z);
    const a = catalog[v.asset],
      art = el("span", "cutout");
    if (!a || missing(o)) {
      art.className = "missing-object";
      art.textContent = "素材缺失，文字入口仍可用";
    } else {
      const [x, y, w, h] = a.bounds,
        img = el("img");
      art.style.aspectRatio = `${w}/${h}`;
      img.alt = "";
      img.src = new URL(a.file, import.meta.url).href;
      img.draggable = false;
      img.style.width = `${(a.width / w) * 100}%`;
      img.style.height = `${(a.height / h) * 100}%`;
      img.style.left = `${(-x / w) * 100}%`;
      img.style.top = `${(-y / h) * 100}%`;
      img.addEventListener("error", () =>
        art.replaceChildren(el("span", "missing-object", "纸片加载失败")),
      );
      art.append(img);
    }
    if (v.flip) art.style.transform = "scaleX(-1)";
    node.append(art);
    if (action) node.append(el("span", "label", label(action)));
    decorate(node, o);
    board.append(node);
  }
  return board;
}
