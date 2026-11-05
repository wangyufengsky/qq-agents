// @ts-check
// Both the interactive page and the isolated snapshot decorate the same paper objects.
/** @param {HTMLElement} node @param {{id:string}} object
 * @param {{type:string,ownerAgentId?:string,residents:{id:string,name:string,state:string,tagline?:string}[]}} options */
export function decorateSceneObject(
  node,
  object,
  { type, residents, ownerAgentId },
) {
  /** @param {string} className @param {string} [text] */
  const el = (className, text) => {
    const n = document.createElement("span");
    n.className = className;
    if (text !== undefined) n.textContent = text;
    return n;
  };
  if (type !== "hall") {
    if (object.id === "nameplate") {
      const owner = residents.find((r) => r.id === ownerAgentId);
      const text =
        type === "room" ? owner?.tagline || owner?.name || "房间" : "走廊";
      const ink = el("object-ink ink-nameplate", text);
      ink.title = text;
      node.append(ink);
    }
    return;
  }
  const resident = residents.find((r) => r.id === object.id.slice(5));
  if (object.id.startsWith("sign-")) {
    const name = resident?.name || "房间";
    const n = el("door-name", resident?.tagline || name);
    n.title = name + (resident?.tagline ? " · " + resident.tagline : "");
    node.setAttribute("aria-label", n.title);
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
