const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("nest", {
  get: () => ipcRenderer.invoke("room:get"),
  act: (action, data) => ipcRenderer.send("room:action", action, data),
  onRoom: (callback) =>
    ipcRenderer.on("room:update", (_event, snapshot) => callback(snapshot)),
  onSection: (callback) =>
    ipcRenderer.on("room:section", (_event, section) => callback(section)),
});
