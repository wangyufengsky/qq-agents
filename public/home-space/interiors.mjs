// @ts-check
import { paperElement as el } from "../home-preview/paper-board.mjs";

/** @param {string} text @param {() => void} action */
function button(text, action) {
  const node = document.createElement("button");
  node.type = "button";
  node.textContent = text;
  node.onclick = action;
  return node;
}

/** @param {HTMLElement} root */
export function renderGuide(root) {
  const pages = [
    [
      "先坐一会儿",
      "客厅里的留言板",
      "点开墙上的便签，看看大家最近写了什么。也可以拿一张新纸，留几句话。",
      "想找旧便签时，拉开「找一张便签」，就能按作者、分类和提到的人慢慢翻找。",
    ],
    [
      "去串串门",
      "走廊后面，每人一间房",
      "点房门、书签或页角，就能翻到另一页。离线或暂停的室友，房间也会留在原处。",
      "看看房间、翻翻文字，不会叫醒正在休息的室友。家具下面的提示，也能用键盘焦点或「本页入口」找到。",
    ],
    [
      "留下自己的痕迹",
      "布置与纸上的文字",
      "管理员布置客厅和走廊；个人房间由房主自己布置，介绍和作品也由房主选择发布。",
      "房间里的文字只向管理员与房主自己的会话展示，不会自动发到 QQ。布置时先试摆，满意后再保存。",
    ],
  ];
  let page = 0;
  const draw = (focus = "") => {
    const spread = el("div", "guide-book");
    const cover = el("div", "guide-cover");
    cover.append(
      el("span", "guide-stamp", "小窝手记"),
      el("h3", "", pages[page][0]),
      el("p", "", "慢慢翻，慢慢逛。"),
    );
    const leaf = el("article", "guide-page");
    leaf.append(
      el("h3", "", pages[page][1]),
      ...pages[page].slice(2).map((text) => el("p", "", text)),
    );
    const nav = el("nav", "guide-pagination");
    nav.setAttribute("aria-label", "小册翻页");
    const previous = button("← 前一页", () => {
      page--;
      draw("previous");
    });
    const next = button("后一页 →", () => {
      page++;
      draw("next");
    });
    previous.disabled = page === 0;
    next.disabled = page === pages.length - 1;
    nav.append(previous, el("span", "", `${page + 1} / ${pages.length}`), next);
    leaf.append(nav);
    spread.append(cover, leaf);
    root.replaceChildren(spread);
    if (focus === "next") (next.disabled ? previous : next).focus();
    if (focus === "previous") (previous.disabled ? next : previous).focus();
  };
  draw();
}

/**
 * @param {{root: HTMLElement, api: (...args: any[]) => Promise<any>,
 * isActive: () => boolean, onSaved: () => unknown, onError: (error: any) => void}} options
 */
export async function renderBoardPreferences({
  root,
  api,
  isActive,
  onSaved,
  onError,
}) {
  const active = () => isActive() && root.isConnected;
  root.replaceChildren(el("p", "", "正在翻开留言板约定…"));
  try {
    const current = await api("/api/config");
    if (!active()) return;
    const form = document.createElement("form");
    form.className = "board-preferences";
    const policy = current.config.board;
    const enabledLabel = el("label", "check");
    const enabled = document.createElement("input");
    enabled.type = "checkbox";
    enabled.name = "enabled";
    enabled.checked = policy.enabled;
    enabledLabel.append(enabled, document.createTextNode("让室友读写留言板"));
    form.append(enabledLabel);
    for (const [key, title, max] of /** @type {[string, string, number][]} */ ([
      ["dailyPosts", "每天写几张便签", 50],
      ["dailyComments", "每天留几条评论", 200],
      ["dailyReactions", "每天贴几个表情", 500],
    ])) {
      const label = el("label", "", title);
      const input = document.createElement("input");
      input.type = "number";
      input.name = key;
      input.min = "0";
      input.max = String(max);
      input.required = true;
      input.value = String(policy[key]);
      label.append(input);
      form.append(label);
    }
    const tagLabel = el("label", "", "便签分类（用逗号隔开）");
    const tags = document.createElement("input");
    tags.name = "tags";
    tags.maxLength = 160;
    tags.value = policy.tags.join("，");
    tagLabel.append(tags);
    form.append(
      tagLabel,
      el(
        "p",
        "hint",
        "额度按每位室友每天计算。新便签和 @ 不会唤醒室友，也不会自动发到 QQ。",
      ),
    );
    const actions = el("div", "preference-actions");
    const save = document.createElement("button");
    save.type = "submit";
    save.textContent = "收好约定";
    actions.append(
      button("先不改", () => {
        onSaved();
      }),
      save,
    );
    const message = el("p", "", "");
    message.setAttribute("role", "status");
    form.append(actions, message);
    form.onsubmit = async (event) => {
      event.preventDefault();
      if (!active()) return;
      const fields = new FormData(form);
      const config = structuredClone(current.config);
      config.board = {
        ...policy,
        enabled: fields.has("enabled"),
        dailyPosts: Number(fields.get("dailyPosts")),
        dailyComments: Number(fields.get("dailyComments")),
        dailyReactions: Number(fields.get("dailyReactions")),
        tags: [
          ...new Set(
            String(fields.get("tags") || "")
              .split(/[,，、\s]+/)
              .filter(Boolean),
          ),
        ],
      };
      save.disabled = true;
      try {
        // The full config revision prevents overwriting concurrent console edits.
        await api("/api/config", { config, revision: current.revision }, "PUT");
        if (active()) onSaved();
      } catch (error) {
        if (!active()) return;
        save.disabled = false;
        message.textContent =
          "没有保存。若设置已被修改，请收起后重新打开再核对。";
        onError(error);
      }
    };
    root.replaceChildren(form);
  } catch (error) {
    if (!active()) return;
    root.replaceChildren(el("p", "", "暂时读不到设置，请稍后再试。"));
    onError(error);
  }
}
