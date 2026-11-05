// @ts-check
// Both the interactive page and the isolated snapshot decorate the same paper objects.
/** @param {HTMLElement} node @param {{id:string}} object
 * @param {{type:string,residents:{id:string,name:string,state:string}[]}} options */
export function decorateSceneObject(node, object, { type, residents }) {
  /** @param {string} className @param {string} [text] */
  const el = (className, text) => {
    const n = document.createElement("span");
    n.className = className;
    if (text !== undefined) n.textContent = text;
    return n;
  };
  if (type !== "hall") {
    if (object.id === "nameplate")
      node.append(el("object-ink ink-nameplate", "走廊"));
    return;
  }
  const resident = residents.find((r) => r.id === object.id.slice(5));
  if (object.id.startsWith("sign-")) {
    const name = resident?.name || "房间";
    const n = el("door-name", name);
    n.title = name;
    node.append(n);
  }
  if (object.id.startsWith("door-")) {
    const state = resident?.state;
    const tag = el("door-status");
    const dot = document.createElement("i");
    dot.className = `status-dot ${state === "online" ? "" : state === "paused" ? "paused" : "offline"}`;
    tag.append(
      dot,
      document.createTextNode(
        /** @type {Record<string,string>} */ ({
          online: "在线",
          offline: "离线",
          paused: "暂停",
        })[state || ""] || "状态未知",
      ),
    );
    node.append(tag);
  }
}
