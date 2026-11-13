import { BrowserWindow } from "electron";
import { fileURLToPath } from "node:url";
import { displayFingerprint, MAX_EXCLUSIONS } from "./space.mjs";

const path = (name) => fileURLToPath(new URL(name, import.meta.url));

export function createSpaceEditor({ screen, store, changed }) {
  let win;
  let displayId;
  const close = () => win?.destroy();

  const displays = () => screen.getAllDisplays().filter(displayFingerprint);
  const load = () => {
    const available = displays();
    const display = available.find(({ id }) => id === displayId);
    if (!display) return;
    const saved = store.list();
    const connected = new Set(available.map(displayFingerprint));
    return {
      displayId,
      displays: available.map(({ id, label }) => ({ id, label })),
      zones:
        saved.find(
          ({ fingerprint }) => fingerprint === displayFingerprint(display),
        )?.zones ?? [],
      unavailable: saved.filter(
        ({ fingerprint }) => !connected.has(fingerprint),
      ).length,
      limit: MAX_EXCLUSIONS,
    };
  };

  return {
    open(display) {
      if (!displayFingerprint(display)) return false;
      if (win) {
        win.focus();
        return true;
      }
      displayId = display.id;
      const editor = new BrowserWindow({
        ...display.workArea,
        show: false,
        frame: false,
        transparent: true,
        hasShadow: false,
        resizable: false,
        movable: false,
        alwaysOnTop: true,
        fullscreenable: false,
        skipTaskbar: true,
        webPreferences: {
          preload: path("space-editor-preload.cjs"),
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
        },
      });
      win = editor;
      editor.setAlwaysOnTop(true, "floating", 2);
      editor.once("closed", () => {
        win = undefined;
      });
      editor.once("ready-to-show", () => editor.show());
      editor.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
      editor.webContents.on("will-navigate", (event) => event.preventDefault());
      const fromMain = (event) =>
        event.senderFrame === editor.webContents.mainFrame;
      editor.webContents.ipc.handle("space-editor:get", (event) =>
        fromMain(event) ? load() : undefined,
      );
      editor.webContents.ipc.handle("space-editor:display", (event, id) => {
        if (!fromMain(event)) return;
        const next = displays().find((candidate) => candidate.id === id);
        if (!next) return;
        displayId = id;
        editor.setBounds(next.workArea);
        return load();
      });
      editor.webContents.ipc.handle("space-editor:save", (event, zones) => {
        if (!fromMain(event)) return false;
        const current = displays().find(({ id }) => id === displayId);
        if (!current) return false;
        try {
          if (!store.save(current, zones)) return false;
        } catch {
          return false;
        }
        changed();
        return true;
      });
      editor.webContents.ipc.on("space-editor:close", (event) => {
        if (fromMain(event)) close();
      });
      void editor.loadFile(path("space-editor.html")).catch(close);
      return true;
    },
    close,
  };
}
