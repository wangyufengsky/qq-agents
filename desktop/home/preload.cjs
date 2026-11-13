const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("nest", {
  get: () => ipcRenderer.invoke("room:get"),
  attach: () => ipcRenderer.invoke("room:attach"),
  observation: () => ipcRenderer.invoke("room:observation"),
  screenView: () => ipcRenderer.invoke("room:screen-view"),
  nativeControl: () => ipcRenderer.invoke("room:native-control"),
  browserControl: (selection) =>
    ipcRenderer.invoke("room:browser-control", selection),
  onFacing: (listener) =>
    ipcRenderer.on("room:facing", (_event, value) => listener(value)),
  act: (action, data) => ipcRenderer.send("room:action", action, data),
  onRoom: (callback) =>
    ipcRenderer.on("room:update", (_event, snapshot) => callback(snapshot)),
  onSection: (callback) =>
    ipcRenderer.on("room:section", (_event, section) => callback(section)),
});
