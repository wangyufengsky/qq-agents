import { supportsMessageImages } from "../backends/capabilities.mjs";

export const VIDEO_READ = "video_read";
// A video result has already passed the role image budget. Leave room for
// base64 and the JSON-RPC envelope on the authenticated relay.
export const MAX_VIDEO_RELAY_FRAME = 12 * 1024 * 1024;

// Native adapters that need a second request mark the image as outstanding
// until it is handed to that request. Symbols never enter the tool payload.
export const videoDelivery = Symbol("videoDelivery");
export const videoResponseGuide =
  "视频画面已准备。请结束当前模型请求，暂不回看、提交桌面决定或回复 QQ；桥接将在同一回合提供图片。";

export function videoVision(agent, config) {
  const backend = config.backends.find(({ id }) => id === agent.backendId);
  return (
    agent.behavior.imageInput.enabled &&
    backend &&
    supportsMessageImages(backend)
  );
}

export function qqVideoAvailable(agent, conversation, config) {
  return (
    /^(?:private|group):\d+$/.test(conversation) &&
    agent.tools.includes(VIDEO_READ) &&
    agent.apps?.enabled &&
    agent.apps.platforms.includes("bilibili") &&
    !!config &&
    videoVision(agent, config)
  );
}
