export function createDesktopSnapshot({
  context,
  MAX_TURNS,
  DEFAULT_MINUTES,
  room,
  places,
  screen,
  displayFingerprint,
  entries,
  clampPoint,
  screenGrants,
  windowTaskGrant,
  permissionRevision,
  verifiedWindowSurface,
  geometryDriver,
  visibleBounds,
  activeFollow,
  follow,
}) {
  function baseSnapshot() {
    if (context.frameworkRoot)
      return (
        context.remoteState ?? {
          live: true,
          framework: true,
          subjectKnocks: true,
          roles: [],
          messages: [],
          budget: MAX_TURNS,
          maxTurns: MAX_TURNS,
          minutes: DEFAULT_MINUTES,
          nextRefill: null,
          thinking: null,
          bubbles: {},
          knock: null,
          notice: "正在连接管理台…",
        }
      );
    return {
      live: Boolean(context.liveRoot),
      subjectKnocks: Boolean(context.live?.runner.subjectActor),
      doorMode: context.live?.doorMode,
      opportunity: Boolean(context.live?.opportunity),
      opportunityAt: context.live?.lastOpportunityAt,
      knock: context.live?.knock ?? null,
      roles: context.roles.map(({ id, name, title, color }) => ({
        id,
        name,
        title,
        color,
        state: room.members[id],
        available: !context.liveRoot || context.live?.supported.has(id),
      })),
      messages: room.messages,
      budget: room.budget,
      maxTurns: MAX_TURNS,
      minutes: room.minutes,
      nextRefill: room.nextRefill,
      thinking: room.turn?.actor ?? null,
      bubbles: room.bubbles,
      notice: room.notice,
    };
  }

  function savedPlace(id) {
    const place = places.get(id);
    if (!place) return;
    const display = screen
      .getAllDisplays()
      .find((display) => displayFingerprint(display) === place.display);
    const entry = entries.get(id);
    if (!display) return { state: "unavailable" };
    const { x, y } = display.workArea;
    const point = { x: x + place.x, y: y + place.y };
    const [width, height] = context.sizes.sprite;
    const size =
      entry && !entry.win.isDestroyed()
        ? entry.win.getBounds()
        : { width, height };
    const clamped = clampPoint(
      point,
      size.width,
      size.height,
      display.workArea,
    );
    if (point.x !== clamped.x || point.y !== clamped.y)
      return { state: "unavailable" };
    return { state: "saved", point, displayId: display.id };
  }

  function snapshot(panel = false) {
    const { frameReceipts, ...data } = baseSnapshot();
    const screens = panel
      ? [...screenGrants.keys()]
          .map((agentId) => windowTaskGrant("screen", agentId, data.roomEpoch))
          .filter(Boolean)
      : [];
    const screen = screens[0];
    const native =
      panel &&
      windowTaskGrant(
        "native",
        data.nativeControl?.grantedAgentId,
        data.roomEpoch,
      );
    return {
      ...data,
      ...(data.companionMode &&
        permissionRevision("view", data) === undefined && {
          screenView: undefined,
          observation: undefined,
        }),
      ...(!data.desktopUnified &&
        data.companionMode &&
        permissionRevision("control", data) === undefined && {
          nativeControl: data.nativeControl?.handoff
            ? { eligible: [], handoff: data.nativeControl.handoff }
            : undefined,
          browserControl: undefined,
        }),
      bubbles: room.bubbles,
      bodyZones: !context.hidden && !context.desktopLocked,
      windowTaskStatus:
        panel && data.interactionsAvailable
          ? (context.localWindowTaskStatus ?? data.windowTaskStatus)
          : undefined,
      ...(panel && {
        observationReviewAvailable: context.observationProtocol,
        frameReceipts,
        ...(context.frameworkRoot && {
          companion: {
            mode: context.selectedMode,
            verifiedWindowSurface,
            ready:
              data.companionMode === context.selectedMode &&
              Number.isSafeInteger(data.companionRevision) &&
              !context.syncingMode,
            applications: context.blockedApplications,
          },
        }),
        ...(screens.length && {
          windowTaskScreenGrants: screens.map(({ agentId, grantId }) => ({
            agentId,
            grantId,
          })),
        }),
        windowFollowAvailable: Boolean(geometryDriver),
        ...(screen && {
          windowTaskScreenAgentId: screen.agentId,
          windowTaskScreenGrantId: screen.grantId,
        }),
        ...(native && {
          windowTaskNativeAgentId: native.agentId,
          windowTaskNativeGrantId: native.grantId,
        }),
      }),
      ...(context.observationEnded && {
        observationEnded: context.observationEnded,
      }),
      roles: data.roles.map((role) => {
        if (panel && places.has(role.id))
          role = { ...role, place: savedPlace(role.id).state };
        const entry = entries.get(role.id);
        if (!entry || !visibleBounds(entry)) return role;
        const status = role.bodyStatus ?? { state: "idle" };
        const stopped = ["paused", "qq"].includes(status.state);
        return {
          ...role,
          ...(panel &&
            activeFollow(entry) && { follow: follow.snapshot(entry) }),
          bodyStatus: {
            ...status,
            ...entry.bodyFeedback,
            ...(status.reason && { stateReason: status.reason }),
            state: stopped
              ? status.state
              : entry.movement
                ? "moving"
                : status.state,
            facing: entry.facing ?? "right",
            pose: entry.pose ?? "sit",
            ...(entry.windowApproach && { intent: "approach-window" }),
            ...(entry.bodyAction?.intent && {
              intent: entry.bodyAction.intent,
            }),
            ...(entry.gesture && { gesture: entry.gesture }),
          },
        };
      }),
    };
  }

  return { snapshot, savedPlace };
}
