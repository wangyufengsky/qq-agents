const { contextBridge, ipcRenderer, webUtils } = require("electron");

// Only the preload can convert files from a real OS drop into local paths.
for (const name of ["dragenter", "dragover"])
  window.addEventListener(name, (event) => {
    if (
      !event.isTrusted ||
      !event.target.closest?.(".door-button, .sprite-button")
    )
      return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
  });
window.addEventListener("drop", (event) => {
  if (
    !event.isTrusted ||
    !event.target.closest?.(".door-button, .sprite-button")
  )
    return;
  event.preventDefault();
  const files = [...event.dataTransfer.files];
  const path =
    files.length === 1 ? webUtils.getPathForFile(files[0]) : undefined;
  ipcRenderer.send("room:personal-drop", {
    path,
    fileCount: files.length,
    text: files.length
      ? undefined
      : event.dataTransfer.getData("text/uri-list") ||
        event.dataTransfer.getData("text/plain"),
  });
});

let statusCardGesture;
window.addEventListener(
  "click",
  (event) => {
    if (
      !event.isTrusted ||
      !event.target.closest?.(
        ".status-card, .bubble-collaboration, .collaboration-link",
      )
    )
      return;
    statusCardGesture = event;
    window.setTimeout(() => {
      if (statusCardGesture === event) statusCardGesture = undefined;
    }, 0);
  },
  true,
);

contextBridge.exposeInMainWorld("nest", {
  getSpriteSize: () => ipcRenderer.invoke("room:get-sprite-size"),
  setSpriteSize: (value) => ipcRenderer.send("room:set-sprite-size", value),
  onSpriteSize: (listener) =>
    ipcRenderer.on("room:sprite-size", (_event, value) => listener(value)),
  personal: (action, data) => ipcRenderer.invoke("room:personal", action, data),
  onPersonal: (listener) =>
    ipcRenderer.on("room:personal", (_event, value) => listener(value)),
  garden: (roomEpoch, action, journal) =>
    ipcRenderer.invoke("room:garden", roomEpoch, action, journal),
  get: () => ipcRenderer.invoke("room:get"),
  openStatusCard: (data) => {
    // A non-focusable sprite may open local content only from a real click.
    if (!statusCardGesture) return Promise.resolve(false);
    statusCardGesture = undefined;
    return ipcRenderer.invoke("room:status-card", data);
  },
  onStatusCard: (listener) =>
    ipcRenderer.on("room:status-card", (_event, value) => listener(value)),
  bubbleReply: (action, data) =>
    ipcRenderer.invoke("room:bubble-reply", action, data),
  sharedImage: (roomEpoch, messageId) =>
    ipcRenderer.invoke("room:shared-image", roomEpoch, messageId),
  attach: () => ipcRenderer.invoke("room:attach"),
  setSection: (section) => ipcRenderer.send("room:action", "section", section),
  follow: (id, mode) => ipcRenderer.invoke("room:follow", id, mode),
  displayObservation: (action, data) =>
    ipcRenderer.invoke("room:display-observation", action, data),
  observation: () => ipcRenderer.invoke("room:observation"),
  observationReview: (action, data) =>
    ipcRenderer.invoke("room:observation-review", action, data),
  companionMode: (input) => ipcRenderer.invoke("room:companion-mode", input),
  screenView: (action, data) =>
    ipcRenderer.invoke("room:screen-view", action, data),
  nativeControl: (action) => ipcRenderer.invoke("room:native-control", action),
  browserControl: (selection) =>
    ipcRenderer.invoke("room:browser-control", selection),
  onMotion: (listener) =>
    ipcRenderer.on("room:motion", (_event, value) => listener(value)),
  onGait: (listener) =>
    ipcRenderer.on("room:gait", (_event, value) => listener(value)),
  onOwnerDrag: (listener) =>
    ipcRenderer.on("room:owner-drag", (_event, value) => listener(value)),
  onMotionSpeed: (listener) =>
    ipcRenderer.on("room:motion-speed", (_event, value) => listener(value)),
  onFacing: (listener) =>
    ipcRenderer.on("room:facing", (_event, value) => listener(value)),
  act: (action, data) => ipcRenderer.send("room:action", action, data),
  onRoom: (callback) =>
    ipcRenderer.on("room:update", (_event, snapshot) => callback(snapshot)),
  onSection: (callback) =>
    ipcRenderer.on("room:section", (_event, section) => callback(section)),
});
