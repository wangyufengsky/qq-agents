/* global document */
import { element, avatar } from "./renderer-shared.js";

export function bindThread(thread, message, clock, getRoom) {
  let lastId;
  let roomEpoch;
  function line(entry) {
    const speakerType =
      entry.speakerType ??
      (entry.actor === "system"
        ? "system"
        : entry.actor === "admin"
          ? "administrator"
          : "agent");
    if (speakerType === "system")
      return element("p", "message system", entry.text);
    const role =
      speakerType === "agent" &&
      getRoom().roles.find(({ id }) => id === entry.actor);
    const row = element(
      "div",
      speakerType === "administrator" ? "message mine" : "message",
    );
    row.dataset.actor = entry.actor;
    const words = element("div", "words");
    const author = element(
      "span",
      "author",
      speakerType === "administrator"
        ? "你"
        : (entry.speaker ?? role?.name ?? entry.actor),
    );
    author.title = clock.format(entry.now);
    words.append(author);
    if (entry.text) words.append(element("p", "content", entry.text));
    for (const { name } of entry.attachments || [])
      words.append(element("p", "content attachment", `附件 · ${name}`));
    if (role) row.append(avatar(role));
    row.append(words);
    return row;
  }

  return function updateThread() {
    if (getRoom().roomEpoch !== roomEpoch) {
      roomEpoch = getRoom().roomEpoch;
      lastId = undefined;
    }
    const latest = getRoom().messages.at(-1)?.id ?? 0;
    if (latest === lastId) return;
    const pinned =
      thread.scrollHeight - thread.scrollTop - thread.clientHeight < 65;
    if (latest < (lastId ?? 0)) lastId = undefined;
    if (!lastId) thread.replaceChildren();
    if (getRoom().messages.length) {
      for (const entry of getRoom().messages) {
        if (entry.id > (lastId ?? 0)) thread.append(line(entry));
      }
      while (thread.childElementCount > getRoom().messages.length)
        thread.firstElementChild.remove();
    } else
      thread.append(
        element("p", "empty", "桌边还没有消息。邀请一位角色，就可以开聊。"),
      );
    lastId = latest;
    if (pinned || document.activeElement === message)
      thread.scrollTop = thread.scrollHeight;
  };
}
