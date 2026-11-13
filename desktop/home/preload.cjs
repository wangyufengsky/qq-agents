const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("nest", {
  get: () => ipcRenderer.invoke("room:get"),
  attach: () => ipcRenderer.invoke("room:attach"),
  follow: (id, mode) => ipcRenderer.invoke("room:follow", id, mode),
  observation: () => ipcRenderer.invoke("room:observation"),
  observationReview: (action, data) =>
    ipcRenderer.invoke("room:observation-review", action, data),
  screenView: () => ipcRenderer.invoke("room:screen-view"),
  nativeControl: () => ipcRenderer.invoke("room:native-control"),
  browserControl: (selection) =>
    ipcRenderer.invoke("room:browser-control", selection),
  onMotion: (listener) =>
    ipcRenderer.on("room:motion", (_event, value) => listener(value)),
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
