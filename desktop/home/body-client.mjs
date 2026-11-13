const SYNC_LEASE_MS = 1700;

export class DesktopBodyClient {
  active = new Map();
  seen = new Map();

  constructor({ claim, result, execute, position }) {
    this.claim = claim;
    this.result = result;
    this.execute = execute;
    this.position = position;
  }

  update(value, action) {
    if (value.offline || !value.room) {
      this.clear("inactive");
      return;
    }
    if (action !== "sync") return;
    const now = Date.now();
    for (const [id, expiresAt] of this.seen)
      if (expiresAt <= now) this.seen.delete(id);
    const requests = (value.bodyRequests ?? []).filter(
      ({ roomEpoch }) => roomEpoch === value.room.roomEpoch,
    );
    for (const [agentId, entry] of this.active) {
      const request = requests.find(
        ({ commandId }) => commandId === entry.request.commandId,
      );
      if (!request) this.stop(agentId, "inactive");
      else if (request.cancel) this.stop(agentId, "stopped");
      else entry.syncUntil = now + SYNC_LEASE_MS;
    }
    for (const request of requests) {
      if (
        !request.cancel &&
        !this.active.has(request.agentId) &&
        !this.seen.has(request.commandId) &&
        now < request.expiresAt
      )
        void this.run(request);
    }
  }

  async run(request) {
    const { agentId, roomEpoch, commandId } = request;
    const identity = { roomEpoch, commandId };
    this.seen.set(commandId, request.expiresAt);
    const entry = { request, syncUntil: Date.now() + SYNC_LEASE_MS };
    this.active.set(agentId, entry);
    const present = () => this.active.get(agentId) === entry;
    const current = () =>
      present() &&
      !entry.stopped &&
      Date.now() < Math.min(entry.syncUntil, request.expiresAt);
    try {
      const claim = await this.claim(identity, current);
      if (!claim?.accepted || !present()) return;
      const finish = (result) => {
        if (!present() || entry.finished) return;
        const body = { ...this.position(agentId), ...result };
        entry.finished = true;
        if (body.status === "completed" && !body.position) {
          body.status = "failed";
          body.reason = "position-unconfirmed";
        }
        void this.result({ ...identity, result: body }, present).catch(
          () => {},
        );
      };
      entry.finish = finish;
      if (!current()) {
        finish({ status: "cancelled", reason: entry.stopped ?? "inactive" });
        return;
      }
      entry.cancel = this.execute(request, current, finish);
    } catch {
      entry.finish?.({ status: "failed", reason: "position-unconfirmed" });
    }
  }

  stop(agentId, reason) {
    const entry = this.active.get(agentId);
    if (!entry) return;
    if (!entry.stopped) {
      entry.stopped = reason;
      entry.cancel?.();
      entry.finish?.({ status: "cancelled", reason });
    }
    if (reason === "inactive") this.active.delete(agentId);
  }

  stopObservation(agentId) {
    if (this.active.get(agentId)?.request.observation)
      this.stop(agentId, "inactive");
  }

  clear(reason) {
    for (const agentId of this.active.keys()) this.stop(agentId, reason);
  }
}

export function bodyDestination({
  door,
  seat,
  display,
  displayAt,
  bounds,
  target,
  clamp,
}) {
  const destination = target === "seat" ? { ...bounds, ...seat } : door;
  if (!destination || displayAt(destination).id !== display.id) return null;
  const area = display.workArea;
  if (bounds.width > area.width || bounds.height > area.height) return null;
  if (target === "seat") return clamp(seat, bounds.width, bounds.height, area);
  const gap = 12;
  const left = door.x - bounds.width - gap;
  const right = door.x + door.width + gap;
  const x = left >= area.x ? left : right;
  if (x + bounds.width > area.x + area.width) return null;
  return clamp(
    { x, y: door.y + door.height - bounds.height },
    bounds.width,
    bounds.height,
    area,
  );
}
