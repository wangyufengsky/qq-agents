export function startDesktopLifecycle({
  context,
  app,
  showDoor,
  follow,
  spaceEditor,
  clearVisualPermissions,
  body,
  nativeControl,
  nativeDriver,
  observationDriver,
  geometryDriver,
  protocol,
  desktopResourcePath,
  source,
  net,
  pathToFileURL,
  screen,
  displayGrants,
  clearObservation,
  screenGrants,
  clearManualScreen,
  restoreWindowLayout,
  powerMonitor,
  invalidatePermissions,
  stopLocalMotion,
  updatePointerPolling,
  entries,
  updateMotion,
  frameworkRoot,
  createFrameworkClient,
  applyFramework,
  frameworkPort,
  manuallyMoved,
  manualTouches,
  visibleBounds,
  bodyPosition,
  windowVisible,
  publicSpace,
  liveRoot,
  LiveRoom,
  room,
  startModelClient,
  syncLive,
  nativeImage,
  join,
  Tray,
  Menu,
  showPanel,
  hideAll,
  refreshIfDue,
  update,
}) {
  if (!app.requestSingleInstanceLock()) app.quit();
  else {
    app.on("second-instance", showDoor);
    app.on("window-all-closed", () => {});
    app.on("before-quit", (event) => {
      if ((!context.live && !context.framework) || context.shuttingDown) return;
      event.preventDefault();
      context.shuttingDown = true;
      follow.stop("inactive");
      spaceEditor.close();
      clearVisualPermissions();
      body.clear("inactive");
      nativeControl?.clear();
      void Promise.allSettled([
        (context.framework ?? context.live).close(),
        nativeDriver?.close(),
        observationDriver?.close(),
        geometryDriver?.close(),
      ]).then(() => app.quit());
    });
    app.whenReady().then(() => {
      protocol.handle("nest", (request) => {
        const resource = desktopResourcePath(request.url, source);
        return resource
          ? net.fetch(pathToFileURL(resource).href)
          : new Response(null, { status: 404 });
      });
      if (process.platform === "darwin") app.setActivationPolicy("accessory");
      for (const event of [
        "display-added",
        "display-removed",
        "display-metrics-changed",
      ])
        screen.on(event, (_event, display) => {
          context.displayPicker = undefined;
          context.screenPicker = undefined;
          if (event === "display-removed") {
            for (const grant of displayGrants.values())
              if (grant.display.displayId === display.id)
                clearObservation(grant);
            for (const grant of screenGrants.values()) {
              if (grant.display?.displayId !== display.id) continue;
              clearManualScreen(grant);
              context.framework?.act("screen-revoke", {
                roomEpoch: grant.roomEpoch,
                grantId: grant.grantId,
              });
            }
          }
          restoreWindowLayout();
        });
      powerMonitor.on("lock-screen", () => {
        spaceEditor.close();
        context.desktopLocked = true;
        invalidatePermissions("lock");
        context.framework?.sync();
        body.clear("hidden");
        stopLocalMotion("hidden");
        updatePointerPolling();
      });
      powerMonitor.on("unlock-screen", () => {
        context.desktopLocked = false;
        context.bodyInputAfter = Date.now();
        for (const entry of entries.values()) updateMotion(entry);
        updatePointerPolling();
      });
      powerMonitor.on("suspend", () => {
        spaceEditor.close();
        context.desktopLocked = true;
        invalidatePermissions("sleep");
        context.framework?.sync();
        body.clear("hidden");
        stopLocalMotion("hidden");
        updatePointerPolling();
      });
      powerMonitor.on("resume", () => {
        context.desktopLocked = powerMonitor.getSystemIdleState(1) === "locked";
        context.bodyInputAfter = Date.now();
        restoreWindowLayout();
        for (const entry of entries.values()) updateMotion(entry);
        updatePointerPolling();
      });
      if (frameworkRoot) {
        context.roles = [];
        context.framework = createFrameworkClient(
          frameworkRoot,
          applyFramework,
          frameworkPort,
          () => {
            const dragged = [...manuallyMoved].slice(0, 24);
            for (const id of dragged) manuallyMoved.delete(id);
            const ownerTouches = [...manualTouches.values()];
            manualTouches.clear();
            const results = body.recovery();
            const bodyPositions =
              context.recoveryPositionPending && context.remoteState?.roomEpoch
                ? [...entries.values()]
                    .flatMap((entry) => {
                      const position =
                        entry.type === "sprite" &&
                        !entry.privatePosition &&
                        visibleBounds(entry)
                          ? bodyPosition(entry.id).position
                          : undefined;
                      return position
                        ? [{ agentId: entry.id, ...position }]
                        : [];
                    })
                    .slice(0, 24)
                : undefined;
            return {
              visible:
                !context.hidden &&
                !context.desktopLocked &&
                [...entries.values()].some(
                  (entry) =>
                    entry.type === "sprite" &&
                    !entry.departing &&
                    windowVisible(entry),
                ),
              dragged,
              ...(context.batchScreenGrants &&
                ownerTouches.length && { ownerTouches }),
              ...(context.observationProtocol &&
                (observationDriver || context.displayObservation) && {
                  observationProtocol: 2,
                  ...(context.displayObservation && {
                    displayObservation: true,
                  }),
                }),
              ...(context.bodyProtocol && {
                bodyProtocol: 2,
                ...(context.bodyCrossDisplay && { bodyCrossDisplay: true }),
                ...(context.bodyInteractions && { bodyInteractions: true }),
                ...(context.bodyWindowApproach && { bodyWindowApproach: true }),
                ...(context.publicPerception && {
                  bodyPublic: true,
                  publicSpace: publicSpace(),
                }),
                ...(results.length && { bodyResults: results }),
                ...(bodyPositions && {
                  bodyPositions: {
                    roomEpoch: context.remoteState.roomEpoch,
                    positions: bodyPositions,
                  },
                }),
              }),
            };
          },
        );
      } else if (liveRoot) {
        context.live = new LiveRoom(
          room,
          startModelClient(liveRoot, process.env.DESKTOP_HOME_NODE),
          syncLive,
        );
      }
      const trayImage = nativeImage.createFromPath(
        join(source, "art", "trayTemplate.png"),
      );
      if (process.platform === "darwin") trayImage.setTemplateImage(true);
      context.tray = new Tray(trayImage.resize({ width: 16, height: 16 }));
      context.tray.setToolTip(
        context.framework
          ? "桌面小窝"
          : context.live
            ? "桌面小窝 · 隔离试聊"
            : "桌面小窝 · 模拟样机",
      );
      context.tray.setContextMenu(
        Menu.buildFromTemplate([
          { label: "显示小门", click: showDoor },
          { label: "打开聊天", click: () => showPanel("chat") },
          { label: "隐藏小窝", click: hideAll },
          { type: "separator" },
          { label: "退出桌面小窝", click: () => app.quit() },
        ]),
      );
      showDoor();
      setInterval(() => {
        if (context.live) context.live.tick();
        else if (!context.framework && refreshIfDue(room)) update();
      }, 500);
    });
  }
}
