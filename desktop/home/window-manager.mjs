import { join } from "node:path";

export function createWindowManager({
  BrowserWindow,
  source,
  sizes,
  clampPoint,
  entries,
  send,
  snapshot,
  updateMotion,
  updatePointerPolling,
  windowVisibilityChanged,
  isHidden,
  onClosed,
}) {
  return function createWindow(id, type, point, options = {}) {
    const [width, height] = sizes[type];
    const panel = type === "panel";
    const win = new BrowserWindow({
      ...clampPoint(point, width, height, options.area),
      width,
      height,
      show: false,
      frame: false,
      transparent: true,
      hasShadow: panel,
      resizable: false,
      movable: panel,
      focusable: panel,
      fullscreenable: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      enableLargerThanScreen: false,
      webPreferences: {
        preload: join(source, "preload.cjs"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    const entry = {
      win,
      id,
      type,
      ready: false,
      section: options.section,
      bodyVisit: {},
    };
    entries.set(id, entry);
    if (panel) win.setAlwaysOnTop(true, "floating", 1);
    win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    win.webContents.on("will-navigate", (event) => event.preventDefault());
    win.webContents.on("did-finish-load", () => {
      entry.ready = true;
      entry.reportedMotion = undefined;
      entry.reportedSpeed = undefined;
      entry.pageVisible = undefined;
      send(entry, "room:update", snapshot(entry.type === "panel"));
      send(entry, "room:section", entry.section);
      if (entry.facing) send(entry, "room:facing", entry.facing);
      updateMotion(entry);
    });
    win.once("ready-to-show", () => {
      if (isHidden() && !panel) return;
      if (panel) win.show();
      else win.showInactive();
      updateMotion(entry);
      updatePointerPolling();
    });
    if (!panel)
      for (const event of ["show", "hide", "minimize", "restore"])
        win.on(event, () => windowVisibilityChanged(entry));
    win.on("closed", () => {
      onClosed(entry);
      if (entries.get(id) === entry) entries.delete(id);
      updatePointerPolling();
    });
    const url = new URL("nest://app/desktop/home/index.html");
    url.search = new URLSearchParams({ type, id });
    win.loadURL(url.href);
    return entry;
  };
}
