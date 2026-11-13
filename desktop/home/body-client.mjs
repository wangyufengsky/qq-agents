const SYNC_LEASE_MS = 1700;
const RECOVERY_WINDOW = 3000;
const RECOVERY_LIMIT = 4;

export class DesktopBodyClient {
  active = new Map();
  seen = new Map();
  terminals = new Map();

  constructor({ claim, result, execute, position }) {
    this.claim = claim;
    this.result = result;
    this.execute = execute;
    this.position = position;
  }

  recovery() {
    const now = Date.now();
    for (const [id, { finishedAt }] of this.terminals)
      if (now - finishedAt >= RECOVERY_WINDOW) this.terminals.delete(id);
    return [...this.terminals.values()];
  }

  update(value, action) {
    if (value.offline) {
      this.clear("disconnect");
      return;
    }
    if (!value.room) {
      this.clear("inactive");
      this.terminals.clear();
      return;
    }
    if (action !== "sync") return;
    const { roomEpoch } = value.room;
    const now = Date.now();
    for (const id of value.bodyResultAcks ?? []) this.terminals.delete(id);
    for (const { commandId, roomEpoch: epoch } of this.recovery())
      if (epoch !== roomEpoch) this.terminals.delete(commandId);
    for (const [id, expiresAt] of this.seen)
      if (expiresAt <= now) this.seen.delete(id);
    const requests = (value.bodyRequests ?? []).filter(
      ({ roomEpoch: epoch }) => epoch === roomEpoch,
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
        void this.run(request, value.bodyProtocol === 2 && !!request.visitId);
    }
  }

  async run(request, v2) {
    const { agentId, roomEpoch, commandId, visitId } = request;
    const identity = { roomEpoch, commandId, ...(v2 && { agentId, visitId }) };
    this.seen.set(commandId, request.expiresAt);
    const entry = { request, syncUntil: Date.now() + SYNC_LEASE_MS };
    this.active.set(agentId, entry);
    const present = () => this.active.get(agentId) === entry;
    const current = () =>
      present() &&
      !entry.stopped &&
      !entry.finished &&
      Date.now() < Math.min(entry.syncUntil, request.expiresAt);
    try {
      const claim = await this.claim(identity, current);
      if (!claim?.accepted || !present()) return;
      const finish = ({ space, ...result }) => {
        if (!present() || entry.finished) return;
        const terminal = entry.stopped
          ? { status: "cancelled", reason: entry.stopped }
          : result;
        const body = { ...this.position(agentId), ...terminal };
        if (!v2 && ["target-blocked", "stale-layout"].includes(body.reason))
          body.reason = "target-unavailable";
        const finishedAt = Date.now();
        entry.finished = true;
        if (body.status === "completed" && !body.position) {
          body.status = "failed";
          body.reason = "position-unconfirmed";
        }
        const evidence = {
          ...identity,
          ...(v2 && { finishedAt }),
          result: body,
        };
        // Retain only the terminal observation, never the command or a later position.
        if (v2 && finishedAt < request.expiresAt) {
          this.terminals.set(commandId, evidence);
          if (this.terminals.size > RECOVERY_LIMIT)
            this.terminals.delete(this.terminals.keys().next().value);
        }
        if (entry.stopped === "disconnect") return;
        const direct =
          v2 && space && body.status === "completed"
            ? { ...evidence, result: { ...body, space } }
            : evidence;
        void this.result(direct, present)
          .then((ack) => {
            if (ack?.accepted) this.terminals.delete(commandId);
          })
          .catch(() => {});
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
    if (!entry.stopped && !entry.finished) {
      entry.stopped = reason;
      entry.cancel?.(reason);
      entry.finish?.({ status: "cancelled", reason });
    }
    if (reason === "inactive" || reason === "disconnect")
      this.active.delete(agentId);
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
