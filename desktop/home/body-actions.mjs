export function createBodyActions({
  context,
  executeWindowTask,
  localObservation,
  observationCurrent,
  probeObservation,
  reportObservationState,
  controllableResident,
  windowGrants,
  stopLocalSeat,
  update,
  recordBodyFeedback,
  windowGeometry,
  sameRectangle,
  entries,
  space,
  visibleBounds,
  screen,
  windowVisible,
  activeFollow,
  stopMovement,
  randomUUID,
  send,
  bodyPosition,
  animateTo,
}) {
  function executeVerifiedBodyAction(request, current, finish) {
    if (request.windowApproach)
      return executeWindowApproach(request, current, finish);
    if (request.windowTask) return executeWindowTask(request, current, finish);
    if (request.interaction)
      return executeInteraction(request, current, finish);
    if (request.greeting) {
      const { agentId, visitId } = request.greeting;
      const present = () =>
        current() &&
        context.remoteState?.publicWaveAvailable &&
        context.remoteState.roles.some(
          (role) =>
            role.id === agentId &&
            role.bodyVisitId === visitId &&
            role.state === "here",
        );
      if (!present())
        return finish({ status: "cancelled", reason: "target-unavailable" });
      return executeBodyAction(request, present, finish);
    }
    if (!request.observation)
      return executeBodyAction(request, current, finish);
    const grant = localObservation(request.observationGrantId);
    const allowed = () =>
      current() && observationCurrent(grant) && grant.state === "ready";
    if (
      !grant ||
      grant.agentId !== request.agentId ||
      grant.roomEpoch !== request.roomEpoch ||
      grant.grantId !== request.observationGrantId ||
      !allowed()
    )
      return finish({ status: "cancelled", reason: "target-unavailable" });
    const controller = new AbortController();
    let cancel;
    void probeObservation(
      grant,
      AbortSignal.any([controller.signal, grant.controller.signal]),
    )
      .then(({ state }) => {
        if (controller.signal.aborted) return;
        if (!allowed()) {
          finish({ status: "cancelled", reason: "target-unavailable" });
          return;
        }
        if (state !== "ready") {
          finish({ status: "cancelled", reason: "target-unavailable" });
          reportObservationState(grant, state);
          return;
        }
        cancel = executeBodyAction(request, allowed, finish);
      })
      .catch(() => finish({ status: "failed", reason: "target-unavailable" }));
    return (reason) => {
      controller.abort();
      cancel?.(reason);
    };
  }

  function executeWindowApproach(request, current, finish) {
    const { agentId, roomEpoch, visitId, inputAt, expiresAt, windowApproach } =
      request;
    const entry = controllableResident(agentId, roomEpoch, visitId, true);
    const grant = windowGrants.get(agentId);
    if (!entry || !grant || grant.grantId !== windowApproach.grantId)
      return finish({ status: "cancelled", reason: "target-unavailable" });
    const controller = new AbortController();
    const signal = AbortSignal.any([
      controller.signal,
      grant.controller.signal,
    ]);
    let cancelMove;
    const moving = () =>
      current() &&
      !signal.aborted &&
      context.bodyWindowApproach &&
      context.selectedMode === "presence" &&
      inputAt > Math.max(entry.bodyInputAfter ?? 0, context.bodyInputAfter) &&
      controllableResident(agentId, roomEpoch, visitId, true) === entry &&
      grant.roomEpoch === roomEpoch &&
      !grant.pending &&
      observationCurrent(grant) &&
      grant.state === "ready" &&
      context.remoteState.observation?.windowGrants?.some(
        ({ grantId }) => grantId === grant.grantId,
      );
    if (!moving())
      return finish({ status: "cancelled", reason: "target-unavailable" });
    const activity = {};
    entry.windowApproach = activity;
    stopLocalSeat(entry, "stopped");
    update();
    const clear = () => {
      if (entry.windowApproach !== activity) return;
      entry.windowApproach = undefined;
      update();
    };
    const complete = (result) => {
      clear();
      if (result.status === "completed")
        recordBodyFeedback(entry, "window-approached");
      finish(result);
    };
    const geometry = () =>
      windowGeometry(grant.source.identity, {
        signal: AbortSignal.any([signal, AbortSignal.timeout(1800)]),
      });
    void (async () => {
      const verified = await probeObservation(grant, signal);
      if (!moving() || verified.state !== "ready") {
        if (moving()) reportObservationState(grant, verified.state);
        return complete({ status: "cancelled", reason: "target-unavailable" });
      }
      const target = await geometry();
      if (!target || !moving())
        return complete({ status: "cancelled", reason: "target-unavailable" });
      cancelMove = moveResident(
        entry,
        { target: { type: "window", bounds: target.bounds } },
        {
          current: moving,
          expiresAt,
          crossDisplay: request.crossDisplay === true,
          local: true,
          fail: (reason, status) => complete({ status, reason }),
          finish: () => {
            cancelMove = undefined;
            void geometry()
              .then((checked) => {
                if (!moving() || !sameRectangle(target.bounds, checked?.bounds))
                  return complete({
                    status: "cancelled",
                    reason: "target-unavailable",
                  });
                complete({ status: "completed", arrivalConfirmed: true });
              })
              .catch(() =>
                complete({ status: "cancelled", reason: "target-unavailable" }),
              );
          },
        },
      );
    })().catch(() =>
      complete({ status: "cancelled", reason: "target-unavailable" }),
    );
    return (reason) => {
      controller.abort();
      cancelMove?.(reason);
      clear();
    };
  }

  function executeInteraction(request, current, finish) {
    const { agentId, interaction } = request;
    const { peerAgentId, peerVisitId, kind, step } = interaction;
    const actor = entries.get(agentId);
    const peer = entries.get(peerAgentId);
    const peerCurrent = () =>
      current() &&
      peer &&
      entries.get(peerAgentId) === peer &&
      peer.bodyVisitId === peerVisitId &&
      !peer.privatePosition &&
      controllableResident(peerAgentId, request.roomEpoch, peerVisitId) ===
        peer;
    if (!actor || !peerCurrent())
      return finish({ status: "cancelled", reason: "target-unavailable" });
    let action;
    if (step === "move") {
      const target = space.residentTarget(agentId, peerAgentId);
      if (target) action = { type: "move", ...target };
    } else {
      const a = visibleBounds(actor);
      const b = visibleBounds(peer);
      const nearby =
        a &&
        b &&
        screen.getDisplayMatching(a).id === screen.getDisplayMatching(b).id &&
        Math.hypot(
          Math.max(0, b.x - a.x - a.width, a.x - b.x - b.width),
          Math.max(0, b.y - a.y - a.height, a.y - b.y - b.height),
        ) <= 64;
      if (kind === "wave" || nearby)
        action =
          step === "wave"
            ? { type: "gesture", gesture: "wave" }
            : { type: "pose", pose: "sit" };
    }
    if (!action)
      return finish({ status: "cancelled", reason: "target-unavailable" });
    return executeBodyAction({ ...request, action }, peerCurrent, (result) => {
      if (
        result.status === "completed" &&
        kind === "together" &&
        step === "move"
      ) {
        actor.pose = "sit";
        update();
      }
      finish(result);
    });
  }

  function executeBodyAction(
    {
      agentId,
      inputAt,
      expiresAt,
      action,
      greeting,
      interaction,
      crossDisplay = false,
    },
    current,
    finish,
  ) {
    const entry = entries.get(agentId);
    const fail = (reason, status = "cancelled") => {
      if (entry && reason !== "manual-control")
        recordBodyFeedback(entry, reason);
      finish({ status, reason });
    };
    if (!entry || entry.departing || entry.win.isDestroyed())
      return fail("inactive");
    if (context.hidden || context.desktopLocked || !windowVisible(entry))
      return fail("hidden");
    if (
      entry.drag ||
      entries.get("door")?.drag ||
      activeFollow(entry) ||
      inputAt <= Math.max(entry.bodyInputAfter ?? 0, context.bodyInputAfter)
    )
      return fail("manual-control");
    if (entry.privatePosition && action.type !== "move")
      return fail("manual-control");
    if (action.type !== "state") stopLocalSeat(entry, "stopped");
    if (action.type === "state")
      return finish({
        status: "completed",
        space: space.snapshot(agentId, { crossDisplay }),
      });
    if (action.type === "gesture") {
      if (
        !(greeting
          ? context.remoteState?.publicWaveAvailable
          : interaction
            ? (context.remoteState?.socialBodyAvailable ??
              context.remoteState?.interactionsAvailable)
            : context.remoteState?.interactionsAvailable) ||
        !["jump", "climb", "land", "wave"].includes(action.gesture)
      )
        return fail("inactive");
      const gesture = { kind: action.gesture, id: randomUUID() };
      entry.gesture = gesture;
      update();
      const clear = () => {
        if (entry.gesture === gesture) {
          entry.gesture = undefined;
          update();
        }
      };
      const timer = setTimeout(() => {
        clear();
        if (current() && windowVisible(entry)) finish({ status: "completed" });
        else fail("inactive");
      }, 420);
      return () => {
        clearTimeout(timer);
        clear();
      };
    }
    if (action.type === "pose") {
      if (entry.movement) stopMovement(entry);
      if (action.facing) {
        entry.facing = action.facing;
        send(entry, "room:facing", entry.facing);
      } else entry.pose = action.pose;
      entry.bodyFeedback = { reason: "completed", at: Date.now() };
      update();
      return finish({ status: "completed" });
    }

    return moveResident(entry, action, {
      current,
      expiresAt,
      crossDisplay,
      finish,
      fail,
      intent:
        interaction?.step === "move"
          ? interaction.kind === "together"
            ? "gather"
            : "approach-peer"
          : undefined,
    });
  }

  function moveResident(
    entry,
    action,
    {
      current,
      expiresAt,
      crossDisplay,
      finish,
      fail,
      local = false,
      duration,
      intent,
    },
  ) {
    const { id: agentId } = entry;
    let plan = space.plan(agentId, action, { crossDisplay });
    if (plan.reason) return fail(plan.reason, "failed");
    entry.pose = "stand";
    if (local) entry.privatePosition = true;
    else
      entry.bodyAction = {
        kind: "move",
        state: "executing",
        destination: plan.destination,
        intent,
      };
    if (intent) update();
    let replanned = false;
    const end = (reason, status) => {
      plan.release();
      entry.bodyAction = undefined;
      if (reason) fail(reason, status);
      else {
        if (action.target === "seat") entry.pose = "sit";
        if (!local) {
          entry.privatePosition = undefined;
          entry.bodyFeedback = { reason: "completed", at: Date.now() };
        }
        update();
        finish({ status: "completed" });
      }
    };
    const next = (index) => {
      const point = plan.path[index];
      if (!point) {
        const { position } = bodyPosition(agentId);
        return position?.x === plan.destination.x &&
          position.y === plan.destination.y &&
          position.displayId === plan.displayId &&
          space.canStep(agentId, position, plan)
          ? end()
          : end("position-unconfirmed", "failed");
      }
      const [x, y] = entry.win.getPosition();
      const distance = Math.hypot(point.x - x, point.y - y);
      animateTo(entry, point, () => next(index + 1), {
        current,
        interrupted: () => end("inactive", "cancelled"),
        unconfirmed: () => end("position-unconfirmed", "failed"),
        canStep: (step, from) => space.canStep(agentId, step, plan, from),
        blocked: () => {
          if (replanned || !current())
            return end("target-blocked", "cancelled");
          replanned = true;
          const replacement = space.plan(agentId, action, {
            crossDisplay,
            replan: plan,
          });
          if (replacement.reason) return end(replacement.reason, "cancelled");
          plan.release();
          plan = replacement;
          if (!local) entry.bodyAction.destination = plan.destination;
          next(0);
        },
        duration: Math.min(
          Math.max(0, expiresAt - Date.now() - 300) /
            (plan.path.length - index),
          duration ??
            (plan.path.length === 1
              ? Math.min(2200, Math.max(900, Math.round(distance * 3)))
              : Math.min(1050, Math.max(250, Math.round(distance * 3)))),
        ),
      });
    };
    next(0);
    return (reason) => {
      plan.release();
      entry.bodyAction = undefined;
      stopMovement(entry);
      if (reason && reason !== "manual-control")
        recordBodyFeedback(entry, reason);
    };
  }

  return { executeVerifiedBodyAction, moveResident };
}
