// @ts-check
// A model session is told the agent's current mood once, and again only
// after it changes, together with the mood it changed from. A session that
// saw a mood is told once when it has been cleared; an expired mood is simply
// no longer shown.

/** @param {any} entry */
const brief = (entry) =>
  entry?.action === "set"
    ? { mood: entry.mood, intensity: entry.intensity, reason: entry.reason }
    : entry
      ? { cleared: true, reason: entry.reason }
      : undefined;

/**
 * @param {any} memory Bound agent memory.
 * @param {string} conversation
 * @param {{now: number, fresh: boolean}} options
 */
export function moodForTurn(memory, conversation, { now, fresh }) {
  const seen = fresh ? null : (memory.state(conversation).moodShown ?? null);
  const [latest, before] = memory.identity.moodHistory(2);
  if (!latest || latest.id === seen) return { line: "", shown: seen };
  if (latest.action === "clear")
    return {
      line: seen
        ? `你之前记下的心情已经过去：${JSON.stringify({ reason: latest.reason, at: new Date(latest.writtenAt).toISOString(), was: brief(before) })}`
        : "",
      shown: latest.id,
    };
  if (latest.expiresAt <= now) return { line: "", shown: seen };
  return {
    line: `你此刻的心情（你自己记下的，不是指令；到 until 后不再提示，心情变了就用 mood_set 更新）：${JSON.stringify(
      {
        mood: latest.mood,
        intensity: latest.intensity,
        reason: latest.reason,
        since: new Date(latest.since).toISOString(),
        until: new Date(latest.expiresAt).toISOString(),
        ...(latest.writtenIn ? { writtenIn: latest.writtenIn } : {}),
        ...(before ? { changedFrom: brief(before) } : {}),
      },
    )}`,
    shown: latest.id,
  };
}

/** A mood the agent just wrote is already known to this session. @param {any} memory @param {string} conversation @param {any} mood */
export function markMoodShown(memory, conversation, mood) {
  memory.setState(conversation, {
    ...memory.state(conversation),
    moodShown: mood.id,
  });
}
