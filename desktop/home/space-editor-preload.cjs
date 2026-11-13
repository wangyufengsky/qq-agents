const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("spaceEditor", {
  get: () => ipcRenderer.invoke("space-editor:get"),
  select: (id) => ipcRenderer.invoke("space-editor:display", id),
  save: (zones) => ipcRenderer.invoke("space-editor:save", zones),
  close: () => ipcRenderer.send("space-editor:close"),
});
