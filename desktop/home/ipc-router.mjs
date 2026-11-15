// Resolve the actual sender's window rather than trusting renderer-supplied identity.
export function createIpcRouter(ipcMain, entries) {
  const entryFor = (event) =>
    [...entries.values()].find(({ win }) => win.webContents === event.sender);
  return {
    handle: (channel, handler) => ipcMain.handle(channel, handler),
    on: (channel, handler) => ipcMain.on(channel, handler),
    entryFor,
    actionEntry(event) {
      const entry = entryFor(event);
      if (
        !entry ||
        entry.departing ||
        event.senderFrame !== entry.win.webContents.mainFrame
      )
        return;
      return entry;
    },
  };
}
