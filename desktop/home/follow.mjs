const FOLLOW_MS = 120_000;
const POINTER_SAMPLE_MS = 180;
const WINDOW_SAMPLE_MS = 650;

function closeTo(a, b, slop) {
  return (
    b &&
    Math.abs(a.x - b.x) < slop &&
    Math.abs(a.y - b.y) < slop &&
    Math.abs(a.width - b.width) < slop &&
    Math.abs(a.height - b.height) < slop
  );
}

export function geometryFailure(error) {
  if (error?.message === "DESKTOP_NATIVE_PERMISSION")
    return "follow-permission";
  if (error?.message === "DESKTOP_NATIVE_TARGET_MINIMIZED")
    return "follow-target-minimized";
  return "target-unavailable";
}

export class DesktopFollow {
  #session;

  constructor({ blocked, display, readWindow, move, changed, now = Date.now }) {
    Object.assign(this, { blocked, display, readWindow, move, changed, now });
  }

  active(entry) {
    return !!this.#session && this.#session.entry === entry;
  }

  snapshot(entry) {
    if (!this.active(entry)) return;
    const { mode, until } = this.#session;
    return { mode, until };
  }

  stop(reason, entry = this.#session?.entry) {
    const session = this.#session;
    if (!session || session.entry !== entry) return;
    this.#session = undefined;
    session.controller.abort();
    clearTimeout(session.deadline);
    clearTimeout(session.poll);
    const cancel = session.cancel;
    session.cancel = undefined;
    cancel?.();
    this.changed(entry, reason);
  }

  #current(session) {
    if (this.#session !== session) return false;
    const reason =
      this.now() >= session.until ? "follow-expired" : this.blocked(session);
    if (reason) this.stop(reason, session.entry);
    return !reason;
  }

  recheck() {
    if (this.#session) this.#current(this.#session);
  }

  start({ entry, mode, source, bounds, ...identity }) {
    this.stop("stopped");
    const until = this.now() + FOLLOW_MS;
    const session = {
      ...identity,
      entry,
      mode,
      source,
      until,
      controller: new AbortController(),
      lastSample: -Infinity,
    };
    this.#session = session;
    this.changed(entry);
    session.deadline = setTimeout(() => {
      if (this.#session === session) this.stop("follow-expired", entry);
    }, FOLLOW_MS);
    if (mode === "pointer") this.pointer(bounds);
    else {
      this.#route(session, bounds);
      this.#queueWindow(session);
    }
    return session.failure ?? "started";
  }

  pointer(point) {
    const session = this.#session;
    if (session?.mode !== "pointer") return;
    const now = this.now();
    if (now - session.lastSample < POINTER_SAMPLE_MS) return;
    session.lastSample = now;
    this.#route(session, { ...point, width: 1, height: 1 });
  }

  #queueWindow(session) {
    if (!this.#current(session)) return;
    session.poll = setTimeout(async () => {
      if (!this.#current(session)) return;
      try {
        const bounds = await this.readWindow(
          session.source,
          session.controller.signal,
        );
        this.#route(session, bounds);
        this.#queueWindow(session);
      } catch (error) {
        if (this.#current(session))
          this.stop(geometryFailure(error), session.entry);
      }
    }, WINDOW_SAMPLE_MS);
  }

  #route(session, bounds) {
    if (!this.#current(session)) return;
    const fail = (reason) => {
      if (this.#session !== session) return;
      session.failure = reason;
      this.stop(reason, session.entry);
    };
    if (!bounds) return fail("target-unavailable");
    const display = this.display(bounds);
    if (session.bounds && display !== session.display)
      return fail("target-unreachable");
    if (closeTo(bounds, session.bounds, session.mode === "pointer" ? 14 : 4))
      return;
    session.display = display;
    session.bounds = bounds;
    session.cancel?.();
    session.cancel = undefined;
    session.cancel = this.move(
      session,
      bounds,
      () => this.#current(session),
      fail,
    );
  }
}
