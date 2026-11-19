import { randomUUID } from "node:crypto";

export function createOwnerInput({ newId = randomUUID } = {}) {
  const pending = new Map();
  let roomEpoch;
  let currentVisits = new Map();

  function update(value, { heartbeat = false } = {}) {
    const input = value.desktopOwnerInput;
    if (heartbeat || value.offline) {
      if (input?.roomEpoch === roomEpoch)
        for (const eventId of input.acknowledged ?? []) pending.delete(eventId);
      return;
    }
    const nextEpoch = input?.roomEpoch;
    if (roomEpoch !== nextEpoch) {
      pending.clear();
      roomEpoch = nextEpoch;
    }
    currentVisits = new Map(
      (value.room?.roles ?? [])
        .filter(({ state, bodyVisitId }) => state === "here" && bodyVisitId)
        .map(({ id, bodyVisitId }) => [id, bodyVisitId]),
    );
    for (const [eventId, { agentId, visitId }] of pending)
      if (currentVisits.get(agentId) !== visitId) pending.delete(eventId);
    for (const eventId of input?.acknowledged ?? []) pending.delete(eventId);
  }

  function record({ id: agentId, bodyVisitId: visitId }, input) {
    if (!roomEpoch || !visitId || currentVisits.get(agentId) !== visitId)
      return false;
    const eventId = newId();
    pending.set(eventId, { eventId, roomEpoch, agentId, visitId, ...input });
    return true;
  }

  function batch() {
    return [...pending.values()].slice(0, 48);
  }

  return { update, record, batch, enabled: () => Boolean(roomEpoch) };
}
