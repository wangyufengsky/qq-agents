// @ts-check
const REST = "@subject-rest";

/** @param {any} agent */
export const subjectInboxEnabled = (agent) =>
  agent?.subject?.inboxEnabled === true &&
  (agent.subject.enabled || agent.behavior.proactive.enabled);

/** @param {any} runtime @param {string} agentId */
export function roleTurnBusy(runtime, agentId) {
  return (
    runtime.subjectExecution.busy(agentId) ||
    [...runtime.running.values()].some((ctx) => ctx.agentId === agentId)
  );
}

/** @param {any} runtime @param {any} agent */
export function roleRest(runtime, agent) {
  if (!subjectInboxEnabled(agent)) return null;
  const rest = runtime.memory.bind(agent.id).state(REST).rest;
  return rest && (rest.until == null || rest.until > runtime.now())
    ? rest
    : null;
}

/** @param {any} runtime @param {any} agent @param {{durationMs: number, earlyWake: string}} args */
export function beginRoleRest(runtime, agent, { durationMs, earlyWake }) {
  const memory = runtime.memory.bind(agent.id);
  const existing = roleRest(runtime, agent);
  if (existing) {
    if (existing.durationMs !== durationMs || existing.earlyWake !== earlyWake)
      throw Error("SUBJECT_REST_ACTIVE");
    return existing;
  }
  const rest = {
    requestedAt: runtime.now(),
    durationMs,
    earlyWake,
    until: null,
  };
  memory.setState(REST, { rest });
  return rest;
}

/** @param {any} runtime @param {any} agent */
export function settleRoleRest(runtime, agent) {
  const memory = runtime.memory.bind(agent.id);
  const rest = memory.state(REST).rest;
  if (!rest) return false;
  const now = runtime.now();
  if (
    !subjectInboxEnabled(agent) ||
    (rest.until != null && rest.until <= now)
  ) {
    memory.setState(REST, {});
    return true;
  }
  if (rest.until != null || roleTurnBusy(runtime, agent.id)) return false;
  memory.setState(REST, {
    rest: { ...rest, start: now, until: now + rest.durationMs },
  });
  return true;
}

/** @param {any} runtime @param {any} agent @param {string} conversation
 * @param {{seq: number, senderId: string|null, direct: boolean}} event */
export function interruptRoleRest(
  runtime,
  agent,
  conversation,
  { seq, senderId, direct },
) {
  const rest = roleRest(runtime, agent);
  if (
    !rest?.until ||
    !seq ||
    !senderId ||
    !runtime.writable(agent, conversation)
  )
    return false;
  const owner =
    conversation === `private:${senderId}` && agent.ownerIds.includes(senderId);
  if (!(
    (rest.earlyWake === "owner" && owner) ||
    (rest.earlyWake === "direct" && (owner || direct))
  ))
    return false;
  runtime.memory.bind(agent.id).setState(REST, {});
  return true;
}
