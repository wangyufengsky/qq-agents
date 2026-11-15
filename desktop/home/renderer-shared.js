/* global document */
function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

function assetPath(asset) {
  return asset === "door"
    ? "../../public/home-preview/assets/door.webp"
    : `art/${asset}-paper.webp`;
}

function image(asset) {
  const img = element("img");
  if (asset) img.src = assetPath(asset);
  img.alt = "";
  img.draggable = false;
  return img;
}

function avatar(role) {
  const node = element("span", `portrait ${role.color}`);
  node.append(image(role.art ?? role.id));
  return node;
}

function button(className, text, label = text) {
  const node = element("button", className, text);
  node.type = "button";
  if (label) node.setAttribute("aria-label", label);
  return node;
}

const activityLabels = {
  move: "正在移动",
  qq: "回复 QQ",
  chat: "桌边聊天",
  observe: "观察桌面",
  control: "操控桌面",
  idle: "待机",
  sleep: "睡觉",
};

const bodyActivities = { moving: "move", observing: "observe", qq: "qq" };
const bodyStateLabels = {
  moving: "正在移动",
  waiting: "等待自主活动",
  observing: "正在观察桌面",
  qq: "QQ 优先处理",
  paused: "已暂停",
};
const bodyPoseLabels = { stand: "站立", sit: "坐下", look: "张望" };
const bodyFacingLabels = { left: "面向左侧", right: "面向右侧" };
const bodyGestureLabels = {
  jump: "跳跃",
  climb: "攀爬",
  land: "落地",
  wave: "挥手",
  pet: "被摸了摸头",
};
const followModeLabels = { pointer: "跟随鼠标", window: "跟随窗口" };
const followResultLabels = {
  busy: "请先完成当前窗口选择。",
  "no-sources": "没有可跟随的窗口。",
  permission: "请在系统设置中允许访问窗口。",
  "target-unavailable": "窗口已失效。",
  "target-unreachable": "无法到达窗口附近。",
  "target-blocked": "窗口附近没有可用落点。",
  "follow-target-minimized": "窗口已最小化。",
};
const observationPermissionHelp =
  "请在系统设置中恢复权限。macOS 需按系统提示允许桌面小窝录制屏幕，并允许 agent-desktop 使用辅助功能。";
const observationEndLabels = {
  "target-unavailable": "观察窗口已失效。请在聊天页选择其他窗口并重新授权。",
  "target-minimized": "窗口最小化、被遮挡或覆盖范围暂无法核验，取帧已暂停。",
  permission: `观察权限已失效。${observationPermissionHelp}然后重新授权观察。`,
  unsupported: "当前后端不支持观察所需的图片输入。请在管理台检查角色的后端。",
};
const observationEligibilityLabels = {
  activity: "未开启自主活动",
  screen: "未获准查看屏幕",
  image: "未启用图片输入或后端不支持图片输入",
  blocked: "角色当前无法参与观察",
};
const bodyReasonLabels = {
  "manual-control": "拖动已打断移动",
  stopped: "动作已停止",
  "display-changed": "显示器布局已变化，请重新选择落点。",
  "target-unavailable": "移动目标已失效，请重新选择落点。",
  "target-unreachable": "没有可通行的路线，请重新选择落点。",
  "target-blocked": "落点被占用或位于禁停区，请重新选择。",
  "stale-layout": "桌面布局已变化，请重新选择落点。",
  "position-unconfirmed": "位置未确认，请检查桌宠当前所在位置。",
  disconnect: "连接中断。若持续断开，请确认管理台正在运行。",
  permission: "桌宠权限已失效，请在管理台检查该角色的桌宠控制权限。",
  qq: "已让位给 QQ",
  pause: "自主活动已暂停",
  rest: "已进入休息时段",
  hidden: "浮窗已隐藏",
  "action-unconfirmed": "窗口任务结果未确认，请先核对目标窗口。",
  "follow-expired": "临时跟随已到期",
  "follow-permission": "跟随权限已失效",
  "follow-target-minimized": "跟随窗口已最小化",
  "follow-qq": "已停止跟随，让位给 QQ",
  arrival: "已来到桌边",
  "wait-ended": "等待已结束",
  completed: "动作已完成",
  inactive: "到访已结束",
};

function activityFor(role, room) {
  if (role.bodyStatus) {
    const activity = bodyActivities[role.bodyStatus.state];
    if (Object.hasOwn(bodyActivities, role.bodyStatus.state)) return activity;
    if (role.bodyStatus.state === "paused" && role.activity !== "sleep")
      return "idle";
    if (["chat", "control", "sleep"].includes(role.activity))
      return role.activity;
  } else if (Object.hasOwn(activityLabels, role.activity)) return role.activity;
  return room.thinking === role.id || room.bubbles?.[role.id] ? "chat" : "idle";
}

export {
  element,
  assetPath,
  image,
  avatar,
  button,
  activityLabels,
  bodyActivities,
  bodyStateLabels,
  bodyPoseLabels,
  bodyFacingLabels,
  bodyGestureLabels,
  followModeLabels,
  followResultLabels,
  observationPermissionHelp,
  observationEndLabels,
  observationEligibilityLabels,
  bodyReasonLabels,
  activityFor,
};
