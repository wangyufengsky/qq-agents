/* global document */
import {
  BrowserWindow,
  desktopCapturer,
  session,
  systemPreferences,
} from "electron";
import { fileURLToPath } from "node:url";
import { setTimeout } from "node:timers";
import { findScreenSource } from "./screen-source.mjs";

export const screenCaptureSupported = ["darwin", "win32"].includes(
  process.platform,
);

export const screenCapturePermission = () =>
  process.platform !== "darwin" ||
  systemPreferences.getMediaAccessStatus("screen") === "granted";

export function listScreenSources(windowsOnly = false, displaysOnly = false) {
  // A zero-sized thumbnail enumerates sources without capturing their pixels.
  return desktopCapturer.getSources({
    types: displaysOnly
      ? ["screen"]
      : windowsOnly
        ? ["window"]
        : ["window", "screen"],
    thumbnailSize: { width: 0, height: 0 },
  });
}

async function readFrame(maxEdge, maxBytes, observe) {
  const stream = await navigator.mediaDevices.getDisplayMedia({
    video: { frameRate: { ideal: 1 } },
    audio: false,
  });
  const video = document.createElement("video");
  try {
    video.muted = true;
    video.srcObject = stream;
    await video.play();
    if (observe) {
      const [track] = stream.getVideoTracks();
      if (
        track?.readyState !== "live" ||
        track.muted ||
        !video.videoWidth ||
        !video.videoHeight
      )
        return;
    }
    const scale = Math.min(
      1,
      maxEdge / Math.max(video.videoWidth, video.videoHeight),
    );
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
    canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
    canvas
      .getContext("2d", { alpha: false })
      .drawImage(video, 0, 0, canvas.width, canvas.height);
    return encodeFrame(canvas, maxBytes);
  } finally {
    for (const track of stream.getTracks()) track.stop();
    video.srcObject = null;
  }
}

async function captureFrame(maxEdge, maxBytes, observe) {
  if (!observe) return readFrame(maxEdge, maxBytes, observe);
  try {
    return { data: await readFrame(maxEdge, maxBytes, observe) };
  } catch (error) {
    return { permission: error.name === "NotAllowedError" };
  }
}

function encodeFrame(frame, maxBytes) {
  const prefix = "data:image/jpeg;base64,";
  const resized = document.createElement("canvas");
  for (const scale of [1, 0.75, 0.5, 0.25]) {
    resized.width = Math.max(1, Math.round(frame.width * scale));
    resized.height = Math.max(1, Math.round(frame.height * scale));
    resized
      .getContext("2d", { alpha: false })
      .drawImage(frame, 0, 0, resized.width, resized.height);
    for (const quality of [0.85, 0.65, 0.45, 0.25]) {
      const encoded = resized.toDataURL("image/jpeg", quality);
      if (!encoded.startsWith(prefix)) return;
      const data = encoded.slice(prefix.length);
      const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
      if ((data.length * 3) / 4 - padding <= maxBytes) return data;
    }
  }
}

function canCapture(maxEdge, maxBytes, signal) {
  return (
    !signal.aborted &&
    screenCapturePermission() &&
    Number.isInteger(maxEdge) &&
    maxEdge >= 1 &&
    maxEdge <= 4096 &&
    Number.isInteger(maxBytes) &&
    maxBytes >= 1 &&
    maxBytes <= 44 * 1024
  );
}

export async function captureScreen(selected, maxEdge, maxBytes, signal) {
  if (!canCapture(maxEdge, maxBytes, signal)) return;
  const target = findScreenSource(await listScreenSources(), selected);
  if (target) return captureScreenSource(target, maxEdge, maxBytes, signal);
}

export async function captureScreenSource(
  target,
  maxEdge,
  maxBytes,
  signal,
  observe = false,
) {
  if (!canCapture(maxEdge, maxBytes, signal)) return;
  const isolated = session.fromPartition("desktop-home-screen-capture");
  const win = new BrowserWindow({
    show: false,
    webPreferences: {
      session: isolated,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      backgroundThrottling: false,
    },
  });
  const contents = win.webContents;
  const destroy = () => {
    if (!win.isDestroyed()) win.destroy();
  };
  const deadline = setTimeout(destroy, 4500);
  signal.addEventListener("abort", destroy, { once: true });
  let allowed = true;
  // Only this dedicated document can receive the single selected video stream.
  isolated.setDisplayMediaRequestHandler((request, callback) => {
    if (
      !allowed ||
      signal.aborted ||
      request.frame !== contents.mainFrame ||
      !request.userGesture ||
      !request.videoRequested ||
      request.audioRequested
    )
      return callback(null);
    allowed = false;
    callback({ video: target });
  });
  contents.setWindowOpenHandler(() => ({ action: "deny" }));
  contents.on("will-navigate", (event) => event.preventDefault());
  try {
    await win.loadFile(
      fileURLToPath(new URL("./screen-capture.html", import.meta.url)),
    );
    // Electron's gesture flag applies the native picker click to this page.
    return await contents.executeJavaScript(
      `(() => {
        ${encodeFrame}
        ${readFrame}
        return (${captureFrame})(${maxEdge}, ${maxBytes}, ${observe});
      })()`,
      true,
    );
  } finally {
    clearTimeout(deadline);
    signal.removeEventListener("abort", destroy);
    isolated.setDisplayMediaRequestHandler((_, callback) => callback(null));
    destroy();
  }
}
