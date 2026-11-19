export function createFrameworkStateController({
  context,
  body,
  clearVisualPermissions,
  nativeControl,
  stopLocalWindowTask,
  follow,
  screenRequest,
  room,
  update,
  screenCaptureSupported,
  windowGrants,
  displayGrants,
  verifyObservationRequest,
  app,
  snapshot,
  animateHome,
  verifiedWindowSurface,
  localScreen,
  localObservation,
  syncCompanionMode,
  bubbles,
  entries,
  showSprite,
}) {
  function applyFramework(value, action) {
    if (action === "heartbeat") return body.heartbeat(value);
    if (action === "sync" && !value.room) {
      context.bodyCrossDisplay = false;
      context.bodyInteractions = false;
      context.bodyWindowApproach = false;
      context.publicPerception = false;
      context.displayObservation = false;
      context.batchScreenGrants = false;
    }
    if (value.offline && context.remoteState) {
      context.syncingMode = undefined;
      clearVisualPermissions();
      nativeControl?.clear();
      stopLocalWindowTask("disconnect");
      context.localWindowTaskStatus = undefined;
      follow.stop("disconnect");
      body.update(value, action);
      context.recoveryPositionPending = context.bodyProtocol;
      screenRequest(value, action);
      nativeControl?.update(value, action);
      context.remoteState = {
        ...context.remoteState,
        connected: false,
        connectionLost: true,
        screenView: undefined,
        interactionsAvailable: false,
        windowTaskStatus: undefined,
        observation: undefined,
        nativeControl: undefined,
        browserControl: undefined,
        attachmentInput: undefined,
        thinking: null,
        activityActor: null,
        knock: null,
        bubbles: {},
        notice: "与管理台断开，正在重连。若持续断开，请确认管理台正在运行。",
        roles: context.remoteState.roles.map((role) => ({
          ...role,
          activity: "idle",
          bodyStatus: { state: "idle", reason: "disconnect" },
        })),
      };
      room.bubbles = {};
      room.turn = null;
      update();
      return;
    }
    if (action === "sync" && value.room) {
      context.bodyProtocol = value.bodyProtocol === 2;
      context.bodyCrossDisplay =
        context.bodyProtocol && value.bodyCrossDisplay === true;
      context.bodyInteractions =
        context.bodyProtocol && value.bodyInteractions === true;
      context.bodyWindowApproach =
        context.bodyProtocol && value.bodyWindowApproach === true;
      context.publicPerception =
        context.bodyProtocol && value.publicPerception === true;
      context.observationProtocol = value.observationProtocol === 2;
      context.batchScreenGrants = value.batchScreenGrants === true;
      context.displayObservation =
        context.observationProtocol &&
        value.displayObservation === true &&
        screenCaptureSupported;
      context.recoveryPositionPending = false;
    }
    screenRequest(value, action);
    if (action === "sync") {
      const requests = value.observationVerifies ?? [value.observationVerify];
      for (const grant of [...windowGrants.values(), ...displayGrants.values()])
        verifyObservationRequest(
          grant,
          requests.find((request) => request?.grantId === grant.grantId),
        );
    }
    nativeControl?.update(value, action);
    if (value.closed) {
      follow.stop("inactive");
      body.clear("inactive");
      app.quit();
      return;
    }
    const state = value.room ?? {
      ...snapshot(),
      roles: [],
      messages: [],
      bubbles: {},
      knock: null,
      thinking: null,
      notice: value.offline
        ? "连接管理台失败，正在重试。"
        : value.busy
          ? "另一个桌面小窝正在使用这个实例。"
          : "请在管理台的纸页小窝里开启桌面小窝。",
    };
    const browserControl = value.room?.browserControl;
    if (value.room?.roomEpoch !== context.remoteState?.roomEpoch)
      context.localWindowTaskStatus = undefined;
    if (value.room && value.room.roomEpoch !== context.remoteState?.roomEpoch)
      context.observationEnded = undefined;
    if (
      value.room &&
      value.room.roomEpoch !== context.lastBrowserGrant?.roomEpoch
    )
      context.lastBrowserGrant = undefined;
    for (const role of context.roles)
      if (!state.roles.some(({ id }) => id === role.id)) animateHome(role);
    context.roles = state.roles;
    context.remoteState = {
      ...state,
      live: true,
      framework: true,
      subjectKnocks: true,
      connected: !!value.room,
      connectionLost: Boolean(value.offline),
      observationRevision: value.observationRevision,
      frameReceipts: value.frameReceipts,
      screenView: verifiedWindowSurface &&
        screenCaptureSupported &&
        value.room?.screenView && {
          ...value.room.screenView,
          ...(context.batchScreenGrants && {
            grants:
              value.room.screenView.grants?.map((grant) => ({
                ...grant,
                target: localScreen(grant.grantId)?.source.name,
              })) ?? [],
          }),
        },
      observation: context.observationProtocol &&
        value.room?.observation && {
          ...value.room.observation,
          eligible: verifiedWindowSurface
            ? value.room.observation.eligible
            : [],
          target: windowGrants.values().next().value?.source.name,
          ...(context.displayObservation &&
            verifiedWindowSurface && {
              displays:
                value.room.observation.displays?.map((grant) => ({
                  ...grant,
                  target: localObservation(grant.grantId)?.display?.name,
                })) ?? [],
            }),
        },
      nativeControl: (state.desktopUnified || verifiedWindowSurface) &&
        nativeControl &&
        value.room?.nativeControl && {
          ...value.room.nativeControl,
          ...(state.desktopUnified && {
            grants: value.room.nativeControl.grants?.map((grant) => {
              const source = nativeControl.target(grant.agentId, grant.grantId);
              return {
                ...grant,
                title: [source?.app, source?.title].filter(Boolean).join(" · "),
              };
            }),
          }),
          target: nativeControl.target(value.room.nativeControl.grantedAgentId)
            ?.title,
        },
      browserControl: browserControl && {
        ...browserControl,
        grantedOrigin:
          browserControl.grantedAgentId === context.lastBrowserGrant?.agentId
            ? context.lastBrowserGrant?.origin
            : undefined,
      },
    };
    void syncCompanionMode();
    room.members = Object.fromEntries(
      context.roles.map(({ id, state }) => [id, state]),
    );
    room.bubbles = { ...state.bubbles };
    room.turn = state.thinking ? { actor: state.thinking } : null;
    follow.recheck();
    const taskStatus = context.remoteState.windowTaskStatus;
    if (
      context.approachedWindowTask &&
      (taskStatus?.id !== context.approachedWindowTask.id ||
        !["approaching", "ready"].includes(taskStatus.stage) ||
        !context.approachedWindowTask.current())
    )
      stopLocalWindowTask("inactive", context.approachedWindowTask.agentId);
    syncLive();
    body.update(value, action);
  }

  function syncLive() {
    for (const role of context.roles) {
      if (room.members[role.id] === "here") {
        const message = room.bubbles[role.id];
        if (message && bubbles.get(role.id)?.id !== message.id) {
          clearTimeout(bubbles.get(role.id)?.timer);
          const timer = setTimeout(
            () => {
              if (room.bubbles[role.id]?.id === message.id)
                delete room.bubbles[role.id];
              bubbles.delete(role.id);
              update();
            },
            Math.max(0, (message.expiresAt ?? message.now + 4900) - Date.now()),
          );
          bubbles.set(role.id, { id: message.id, timer });
        }
        const entry = entries.get(role.id);
        if (!entry || entry.departing) showSprite(role);
        const resident = entries.get(role.id);
        if (resident && resident.bodyVisitId !== role.bodyVisitId) {
          resident.bodyVisitId = role.bodyVisitId;
          resident.bodyVisit = {};
          resident.bodyFeedback = undefined;
          resident.pose = "sit";
        }
      } else animateHome(role);
    }
    update();
  }

  return { applyFramework, syncLive };
}
