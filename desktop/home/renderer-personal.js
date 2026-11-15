/* global document, window */
// This view is separate from the shared thread and never receives room messages.
export function bindPersonal(root) {
  const reopen = document.createElement("button");
  reopen.type = "button";
  reopen.textContent = "打开私密对话";
  reopen.hidden = true;
  root.querySelector(".header-actions").prepend(reopen);
  const dialog = document.createElement("dialog");
  dialog.className = "personal-dialog";
  const title = document.createElement("h2");
  const status = document.createElement("p");
  status.setAttribute("role", "status");
  const history = document.createElement("div");
  history.className = "personal-history";
  const form = document.createElement("form");
  const input = document.createElement("textarea");
  input.maxLength = 12000;
  input.setAttribute("aria-label", "私密消息");
  const send = document.createElement("button");
  send.textContent = "私密发送";
  const close = document.createElement("button");
  close.type = "button";
  close.textContent = "关闭";
  close.addEventListener("click", () => dialog.close());
  form.append(input, send);
  dialog.append(title, status, history, form, close);
  root.append(dialog);
  let target;
  let revision = 0;
  let busy = false;
  function clear() {
    revision++;
    target = undefined;
    busy = false;
    reopen.hidden = true;
    title.textContent = "";
    status.textContent = "";
    input.value = "";
    history.replaceChildren();
    if (dialog.open) dialog.close();
  }
  function same(a, b) {
    return (
      a &&
      b &&
      a.agentId === b.agentId &&
      a.roomEpoch === b.roomEpoch &&
      a.visitId === b.visitId
    );
  }
  function render(messages) {
    history.replaceChildren();
    for (const item of messages ?? []) {
      if (
        !["user", "assistant"].includes(item.role) ||
        typeof item.text !== "string"
      )
        continue;
      const line = document.createElement("p");
      line.textContent = `${item.role === "user" ? "我" : "对方"}：${item.text}${item.attachment ? ` [图片：${item.attachment.name}]` : ""}`;
      history.append(line);
    }
  }
  reopen.addEventListener("click", async () => {
    if (!target) return;
    dialog.showModal();
    const current = revision;
    try {
      const result = await window.nest.personal("history", target);
      if (current !== revision) return;
      if (result.status === "CLOSED") return clear();
      render(result.messages);
      status.textContent = "仅你和该角色可见";
    } catch {
      if (current === revision) status.textContent = "暂时无法读取私密记录。";
    }
  });
  window.nest.onPersonal?.((value) => {
    if (value.pending && value.target) {
      revision++;
      target = value.target;
      input.value = "";
      reopen.hidden = false;
      title.textContent = `与${value.name}的私密对话`;
      render([]);
    } else if (!same(value.target, target)) return;
    busy = Boolean(value.pending);
    if (value.messages) render(value.messages);
    status.textContent =
      value.error ?? (busy ? "等待回复…" : "仅你和该角色可见");
    send.disabled = busy || !target;
    if (value.pending && !dialog.open) dialog.showModal();
  });
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const text = input.value.trim();
    if (!target || !text || busy) return;
    const current = revision;
    const issued = target;
    busy = true;
    send.disabled = true;
    status.textContent = "等待回复…";
    try {
      const result = await window.nest.personal("send", { ...issued, text });
      if (current !== revision) return;
      if (result.status === "CLOSED") return clear();
      render(result.messages);
      input.value = "";
      status.textContent = "仅你和该角色可见";
    } catch {
      if (current === revision)
        status.textContent = "发送结果未确认，请先查看私密记录。";
    } finally {
      if (current === revision) {
        busy = false;
        send.disabled = false;
      }
    }
  });
  return (room) => {
    if (
      target &&
      (!room.connected ||
        room.connectionLost ||
        room.roomEpoch !== target.roomEpoch ||
        !room.roles.some(
          (role) =>
            role.id === target.agentId &&
            role.state === "here" &&
            role.bodyVisitId === target.visitId,
        ))
    )
      clear();
  };
}
