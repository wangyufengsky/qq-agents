/* global document, window */
import { button, element } from "./renderer-shared.js";

export function bindBubbleComposer(container, floating = false) {
  const form = element("form", "bubble-composer");
  const input = element("input");
  input.type = "text";
  input.placeholder = "回复公开气泡";
  input.setAttribute("aria-label", "回复公开气泡");
  input.maxLength = 1000;
  input.required = true;
  const submit = button("quiet", "发送");
  submit.type = "submit";
  const cancel = button("quiet", "取消");
  cancel.type = "button";
  const status = element("small", "bubble-reply-status");
  status.setAttribute("role", "status");
  form.append(input, submit, cancel, status);
  form.hidden = true;
  container.append(form);
  let active;
  let opening;
  let room;

  function canReply(target, snapshot = room) {
    return (
      snapshot?.connected &&
      snapshot.roomEpoch === target?.roomEpoch &&
      snapshot.recentBubbles?.some(
        ({ bubbleId, canReply }) => bubbleId === target.bubbleId && canReply,
      )
    );
  }

  function close() {
    const wasOpen = active || opening;
    active = opening = undefined;
    form.hidden = true;
    input.value = "";
    status.textContent = "";
    submit.disabled = false;
    if (floating && wasOpen) {
      container.removeAttribute("data-bubble-reply");
      void window.nest.bubbleReply?.("close").catch(() => {});
    }
  }

  async function open(bubbleId, snapshot) {
    room = snapshot;
    const target = { roomEpoch: room?.roomEpoch, bubbleId };
    if (!canReply(target) || !window.nest.bubbleReply) return false;
    opening = target;
    try {
      if (!(await window.nest.bubbleReply("open", target))) return false;
      if (opening !== target || !canReply(target)) return false;
      active = target;
      if (floating) container.setAttribute("data-bubble-reply", "");
      form.hidden = false;
      input.focus();
      return true;
    } catch {
      return false;
    } finally {
      if (opening === target) opening = undefined;
    }
  }

  cancel.addEventListener("click", close);
  form.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      close();
    }
  });
  if (floating) window.addEventListener("blur", close);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const text = input.value.trim();
    const target = active;
    if (!text || !target || submit.disabled) return;
    if (!canReply(target)) return close();
    submit.disabled = true;
    try {
      if (await window.nest.bubbleReply("send", { ...target, text })) {
        if (active === target) close();
        return;
      }
    } catch {
      // A late action may meet a room or visit that has already ended.
    }
    if (active !== target) return;
    submit.disabled = false;
    status.textContent = "这条气泡暂时无法回复。";
  });

  return {
    open,
    update(snapshot) {
      room = snapshot;
      const target = active || opening;
      if (target && !canReply(target)) close();
    },
  };
}

export function bindRecentBubbles(section) {
  const list = section.querySelector("ul");
  const composer = bindBubbleComposer(section);
  const rows = new Map();
  let room;
  return (snapshot) => {
    room = snapshot;
    composer.update(room);
    const entries = room.connected ? (room.recentBubbles ?? []) : [];
    section.hidden = !entries.length;
    const ids = new Set(entries.map(({ bubbleId }) => bubbleId));
    for (const [id, row] of rows) {
      if (!ids.has(id)) {
        row.node.remove();
        rows.delete(id);
      }
    }
    for (const [index, entry] of [...entries].reverse().entries()) {
      let row = rows.get(entry.bubbleId);
      if (!row) {
        const node = element("li", "guest-activity");
        const author = element("strong");
        const text = element("p", "recent-bubble-text");
        const reply = button("quiet", "回复");
        reply.addEventListener(
          "click",
          () => void composer.open(entry.bubbleId, room),
        );
        node.append(author, text, reply);
        row = { node, author, text, reply };
        rows.set(entry.bubbleId, row);
      }
      row.author.textContent =
        room.roles.find(({ id }) => id === entry.actor)?.name ?? "来访角色";
      row.text.textContent = entry.text;
      row.reply.hidden = !entry.canReply || !window.nest.bubbleReply;
      if (list.children[index] !== row.node)
        list.insertBefore(row.node, list.children[index] ?? null);
    }
  };
}
