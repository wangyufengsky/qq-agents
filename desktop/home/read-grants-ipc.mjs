export function registerReadGrantsIpc({
  ipc,
  context,
  displayGrants,
  screenGrants,
  permissionRevision,
  verifiedWindowSurface,
  screenCaptureSupported,
  permissionPanel,
  removeObservation,
  clearManualScreen,
  systemPreferences,
  listScreenSources,
  screenCapturePermission,
  screen,
  displayFingerprint,
  observationDisplayTarget,
  randomUUID,
  geometryDriver,
  observationDriver,
  observationSources,
  ownScreenSources,
  deniedWindow,
  screenPickerVisits,
  localLabel,
  windowGeometry,
  readDisplayTarget,
  stopObservation,
  clearObservation,
  monitorObservation,
  observationError,
}) {
  async function chooseReadGrants(event, action, data, observe) {
    const roomEpoch = context.remoteState?.roomEpoch;
    const grants = observe ? displayGrants : screenGrants;
    const key = observe ? "observation" : "screenView";
    const modeRevision = permissionRevision("view");
    const remoteGrants = (room) =>
      observe ? room?.observation?.displays : room?.screenView?.grants;
    const setPicker = (picker) => {
      if (observe) context.displayPicker = picker;
      else context.screenPicker = picker;
    };
    const current = () =>
      verifiedWindowSurface &&
      screenCaptureSupported &&
      context.batchScreenGrants &&
      (!observe || context.displayObservation) &&
      modeRevision !== undefined &&
      permissionRevision("view") === modeRevision &&
      permissionPanel(event, roomEpoch);
    if (!current() || context.choosingDesktopPermission)
      return { status: "unavailable" };
    context.choosingDesktopPermission = true;
    try {
      if (action === "revoke" || action === "revoke-all") {
        const selected = (remoteGrants(context.remoteState) ?? []).filter(
          ({ agentId, grantId }) =>
            action === "revoke-all" ||
            (agentId === data?.agentId && grantId === data.grantId),
        );
        if (!selected.length) return { status: "unavailable" };
        for (const { agentId, grantId } of selected) {
          const grant = grants.get(agentId);
          if (grant?.grantId !== grantId) continue;
          if (observe) removeObservation(grant);
          else clearManualScreen(grant);
        }
        const room = await context.framework.command(
          observe ? "display-revoke-batch" : "screen-revoke-batch",
          selected.map(({ grantId }) => ({ roomEpoch, grantId })),
        );
        return {
          status:
            room &&
            selected.every(
              ({ grantId }) =>
                !remoteGrants(room)?.some((grant) => grant.grantId === grantId),
            )
              ? "revoked"
              : "failed",
        };
      }
      if (action === "list") {
        setPicker(undefined);
        if (
          process.platform === "darwin" &&
          ["denied", "restricted"].includes(
            systemPreferences.getMediaAccessStatus("screen"),
          )
        )
          return { status: "permission" };
        const sources = await listScreenSources(false, true);
        if (!current()) return { status: "unavailable" };
        if (!screenCapturePermission()) return { status: "permission" };
        const primary = screen.getPrimaryDisplay().id;
        const choices = screen.getAllDisplays().flatMap((display, index) => {
          const fingerprint = displayFingerprint(display);
          if (!fingerprint || !observationDisplayTarget(sources, display.id))
            return [];
          return [
            {
              id: randomUUID(),
              displayId: display.id,
              fingerprint,
              name:
                display.label ||
                (display.internal ? "内建显示器" : "外接显示器"),
              number: index + 1,
              primary: display.id === primary,
            },
          ];
        });
        if (!observe) {
          const windows = await listScreenSources(false);
          if (!current()) return { status: "unavailable" };
          const known = geometryDriver
            ? await observationDriver
                .observationWindows({
                  signal: AbortSignal.timeout(2500),
                })
                .catch(() => [])
            : [];
          if (!current()) return { status: "unavailable" };
          const identities = observationSources(
            windows,
            known,
            ownScreenSources(),
            process.pid,
          );
          for (const source of identities) {
            if (deniedWindow(source.identity) !== false) continue;
            choices.push({
              id: randomUUID(),
              name: source.name,
              source,
              geometrySource: source.identity,
            });
          }
        }
        setPicker({
          roomEpoch,
          choices,
          visits: screenPickerVisits(),
          limits: observe
            ? context.remoteState.observation?.displayLimits
            : undefined,
        });
        return {
          status: "listed",
          displays: choices.map(({ id, name, number, primary }) => ({
            id,
            name: localLabel(name),
            number,
            primary,
          })),
        };
      }
      if (action !== "grant") return { status: "unavailable" };
      const picker = observe ? context.displayPicker : context.screenPicker;
      const selections = data?.selections;
      const samePicker = () =>
        current() &&
        picker?.roomEpoch === roomEpoch &&
        (observe
          ? context.displayPicker === picker &&
            JSON.stringify(picker.limits) ===
              JSON.stringify(context.remoteState.observation?.displayLimits)
          : context.screenPicker === picker);
      if (
        !samePicker() ||
        !Array.isArray(selections) ||
        !selections.length ||
        selections.length > 24 ||
        selections.some(
          (item) =>
            typeof item?.agentId !== "string" ||
            typeof item.display !== "string",
        ) ||
        new Set(selections.map((item) => item?.agentId)).size !==
          selections.length
      )
        return { status: "unavailable" };
      const valid = (agentId) =>
        Boolean(picker.visits.get(agentId)) &&
        context.remoteState[key]?.eligible.includes(agentId) &&
        context.remoteState.roles.some(
          ({ id, bodyVisitId, state }) =>
            id === agentId &&
            state === "here" &&
            bodyVisitId === picker.visits.get(agentId),
        );
      const selected = [];
      let currentSources;
      for (const { agentId, display: targetId } of selections) {
        const target = picker.choices.find(({ id }) => id === targetId);
        if (!target || !valid(agentId))
          return { status: "unavailable", agentId };
        let source = target.source;
        if (source) {
          if (
            !target.geometrySource ||
            deniedWindow(target.geometrySource) !== false
          )
            return { status: "unavailable", agentId };
          currentSources ??= await listScreenSources(false);
          if (
            !currentSources.some(
              ({ id, name }) => id === source.id && name === source.name,
            )
          )
            return { status: "unavailable", agentId };
          if (
            target.geometrySource &&
            !(await windowGeometry(target.geometrySource, {
              signal: AbortSignal.timeout(2500),
            }))
          )
            return { status: "unavailable", agentId };
        } else {
          const read = await readDisplayTarget(
            target,
            AbortSignal.timeout(3000),
            false,
          );
          if (read.state !== "ready") return { status: read.state, agentId };
          source = read.source;
        }
        selected.push({ agentId, target, source, grantId: randomUUID() });
      }
      if (!samePicker()) return { status: "unavailable" };
      const ineligible = selected.find(({ agentId }) => !valid(agentId));
      if (ineligible)
        return { status: "unavailable", agentId: ineligible.agentId };
      const previous = new Map(
        selected.map(({ agentId }) => [agentId, grants.get(agentId)]),
      );
      const records = selected.map(({ agentId, grantId, target, source }) => ({
        agentId,
        grantId,
        roomEpoch,
        source: target.geometrySource
          ? { ...source, identity: target.geometrySource }
          : source,
        pending: true,
        ...(target.geometrySource && { geometrySource: target.geometrySource }),
        ...(!observe && target.fingerprint && { display: target }),
        ...(observe && {
          display: target,
          expiresAt: Date.now() + picker.limits.minutes * 60_000,
          controller: new AbortController(),
          probe: Promise.resolve(),
          digests: new Set(),
        }),
      }));
      for (const grant of records) grants.set(grant.agentId, grant);
      let room;
      try {
        room = await context.framework.command(
          observe ? "display-grant-batch" : "screen-grant-batch",
          records.map(({ agentId, grantId }) => ({
            agentId,
            grantId,
            roomEpoch,
            visitId: picker.visits.get(agentId),
            modeRevision,
            ...(observe && { scope: "display", limits: picker.limits }),
          })),
        );
      } catch {
        // Restore only locally current grants. Host validation commits the batch in one step.
        for (const grant of records) {
          if (grants.get(grant.agentId) !== grant) continue;
          const old = previous.get(grant.agentId);
          if (old) grants.set(grant.agentId, old);
          else grants.delete(grant.agentId);
        }
        return { status: "failed" };
      }
      for (const old of previous.values()) {
        if (!old) continue;
        if (observe) stopObservation(old);
        else if (context.screenCapture?.grant === old)
          context.screenCapture.controller.abort();
      }
      const confirmed = new Map(
        (remoteGrants(room) ?? []).map((grant) => [grant.grantId, grant]),
      );
      const granted =
        room?.roomEpoch === roomEpoch &&
        current() &&
        records.every(
          (grant) =>
            grants.get(grant.agentId) === grant && confirmed.has(grant.grantId),
        );
      if (!granted) {
        for (const grant of records)
          if (observe) clearObservation(grant);
          else clearManualScreen(grant);
        if (room?.roomEpoch === roomEpoch)
          await context.framework.command(
            observe ? "display-revoke-batch" : "screen-revoke-batch",
            records.map(({ grantId }) => ({ roomEpoch, grantId })),
          );
        return { status: "unavailable" };
      }
      setPicker(undefined);
      for (const grant of records) {
        grant.pending = false;
        if (observe) {
          grant.expiresAt = Math.min(
            grant.expiresAt,
            confirmed.get(grant.grantId).expiresAt,
          );
          grant.monitor = setInterval(() => monitorObservation(grant), 1300);
          monitorObservation(grant);
        }
      }
      return { status: "granted" };
    } catch (error) {
      return { status: observationError(error) };
    } finally {
      context.choosingDesktopPermission = false;
    }
  }

  ipc.handle("room:display-observation", (event, action, data) =>
    chooseReadGrants(event, action, data, true),
  );
  ipc.handle("room:screen-view", (event, action, data) =>
    chooseReadGrants(event, action, data, false),
  );
}
