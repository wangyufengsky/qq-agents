export function createWindowMotion({
  context,
  sizes,
  clampPoint,
  send,
  schedulePositionReport,
  updateMotion,
  windowVisible,
}) {
  function reportSpeed(entry, speed, now) {
    const rounded = speed ? Math.max(25, Math.round(speed / 25) * 25) : 0;
    if (
      entry.reportedSpeed === rounded ||
      (rounded && entry.reportedSpeed && now - entry.speedAt < 125)
    )
      return;
    entry.reportedSpeed = rounded;
    entry.speedAt = now;
    send(entry, "room:motion-speed", rounded);
  }

  const movements = new Map();
  let movementTimer;
  function stepMovements() {
    const now = performance.now();
    // Route completion can enqueue the next leg during this tick.
    for (const [entry, motion] of [...movements])
      if (movements.get(entry) === motion) motion.step(now);
  }
  function stopMovement(entry, notify = true) {
    if (movements.has(entry)) schedulePositionReport();
    movements.delete(entry);
    entry.movement = undefined;
    if (!movements.size && movementTimer) {
      clearInterval(movementTimer);
      movementTimer = undefined;
    }
    if (notify) updateMotion(entry);
  }

  function stopLocalSeat(entry, reason) {
    const cancel = entry.localSeatCancel;
    entry.localSeatCancel = undefined;
    cancel?.(reason);
  }

  function confirmedStep(requested, actual, from, canStep) {
    if (requested.x === actual.x && requested.y === actual.y) return true;
    // Native fractional scaling can round a position by one DIP.
    return (
      Math.abs(requested.x - actual.x) <= 1 &&
      Math.abs(requested.y - actual.y) <= 1 &&
      canStep(actual, from)
    );
  }

  function animateTo(entry, point, complete, options = {}) {
    stopMovement(entry, false);
    const [width, height] = sizes[entry.type];
    const target = options.canStep ? point : clampPoint(point, width, height);
    const [x, y] = entry.win.getPosition();
    const face = (from, to) => {
      if (from === to) return;
      const facing = to < from ? "left" : "right";
      if (entry.facing === facing) return;
      entry.facing = facing;
      send(entry, "room:facing", facing);
    };
    const started = performance.now();
    let previous = { x, y, at: started };
    const validStep = (point) => !options.canStep || options.canStep(point);
    if (options.current && !options.current()) {
      updateMotion(entry);
      return options.interrupted();
    }
    const duration = Math.max(16, options.duration ?? 450);
    if (
      entry.reducedMotion ||
      context.hidden ||
      context.desktopLocked ||
      (x === target.x && y === target.y)
    ) {
      if (!validStep(target)) {
        updateMotion(entry);
        return options.blocked?.();
      }
      entry.win.setPosition(target.x, target.y);
      schedulePositionReport();
      const [actualX, actualY] = entry.win.getPosition();
      if (
        options.canStep &&
        !confirmedStep(
          target,
          { x: actualX, y: actualY },
          previous,
          options.canStep,
        )
      ) {
        updateMotion(entry);
        return options.unconfirmed();
      }
      face(x, actualX);
      complete?.();
      if (!entry.movement) updateMotion(entry);
      return;
    }
    const step = (now) => {
      if (entry.win.isDestroyed()) return stopMovement(entry);
      if (options.current && !options.current()) {
        stopMovement(entry);
        options.interrupted();
        return;
      }
      if (!windowVisible(entry) || context.hidden || context.desktopLocked) {
        stopMovement(entry);
        options.interrupted?.();
        return;
      }
      const progress = entry.reducedMotion
        ? 1
        : Math.min(1, (now - started) / duration);
      const eased = options.current
        ? progress * progress * (3 - 2 * progress)
        : 1 - (1 - progress) ** 3;
      const step = {
        x: Math.round(x + (target.x - x) * eased),
        y: Math.round(y + (target.y - y) * eased),
      };
      if (!validStep(step)) {
        stopMovement(entry);
        options.blocked?.();
        return;
      }
      entry.win.setPosition(step.x, step.y);
      const [actualX, actualY] = entry.win.getPosition();
      if (
        options.canStep &&
        !confirmedStep(
          step,
          { x: actualX, y: actualY },
          previous,
          options.canStep,
        )
      ) {
        stopMovement(entry);
        return options.unconfirmed();
      }
      face(previous.x, actualX);
      if (
        now > previous.at &&
        (actualX !== previous.x || actualY !== previous.y)
      )
        reportSpeed(
          entry,
          (Math.hypot(actualX - previous.x, actualY - previous.y) * 1000) /
            (now - previous.at),
          now,
        );
      previous = { x: actualX, y: actualY, at: now };
      if (progress === 1) {
        stopMovement(entry, false);
        complete?.();
        if (!entry.movement) updateMotion(entry);
      }
    };
    entry.movement = { step };
    movements.set(entry, entry.movement);
    movementTimer ??= setInterval(stepMovements, 16);
    updateMotion(entry);
  }

  return { reportSpeed, stopMovement, stopLocalSeat, animateTo };
}
