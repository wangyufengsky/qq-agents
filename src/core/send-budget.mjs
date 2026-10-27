// Persist alongside conversation state so exports/restores retain consumed budget.
const key = "internal:send-budget";
function recent(times = [], now) {
  if (
    !Array.isArray(times) ||
    times.some((n) => !Number.isSafeInteger(n) || n < 0)
  )
    throw Error("SEND_BUDGET_CORRUPT");
  return times.filter((n) => now - n < 3600000);
}
function legacyTimes(mem, now) {
  return mem.db
    .prepare(
      "SELECT value FROM runtime WHERE agent_id=? AND conversation GLOB '[gp]*:*'",
    )
    .all(mem.agentId)
    .flatMap((row) => recent(JSON.parse(row.value).sendTimes, now));
}
function load(mem, now) {
  const budget = mem.state(key);
  if (budget.version === undefined) return legacyTimes(mem, now);
  if (budget.version !== 1 || !Array.isArray(budget.sendTimes))
    throw Error("SEND_BUDGET_CORRUPT");
  return recent(budget.sendTimes, now);
}
export function reserveSendBudget(
  mem,
  behavior,
  conversationTimes,
  now,
  reconcile = false,
) {
  let total = load(mem, now);
  const local = recent(conversationTimes, now);
  // Old versions keep writing per-conversation counters. On the first reservation
  // after boot, union the two histories by timestamp multiplicity, not Set.
  if (reconcile) {
    const counts = (times) => {
      const result = new Map();
      for (const at of times) result.set(at, (result.get(at) || 0) + 1);
      return result;
    };
    const merged = counts(total);
    for (const [at, n] of counts(legacyTimes(mem, now)))
      merged.set(at, Math.max(n, merged.get(at) || 0));
    total = [...merged].flatMap(([at, n]) => Array(n).fill(at));
  }
  if (
    total.length >= behavior.maxSendPerHour ||
    total.filter((n) => now - n < 60000).length >= behavior.maxSendPerMinute
  )
    throw Error("SEND_RATE_LIMIT");
  if (
    (behavior.conversationMaxSendPerHour !== undefined &&
      local.length >= behavior.conversationMaxSendPerHour) ||
    (behavior.conversationMaxSendPerMinute !== undefined &&
      local.filter((n) => now - n < 60000).length >=
        behavior.conversationMaxSendPerMinute)
  )
    throw Error("CONVERSATION_SEND_RATE_LIMIT");
  mem.setState(key, { version: 1, sendTimes: [...total, now] });
  return [...local, now];
}
