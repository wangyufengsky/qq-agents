// @ts-check
import { createHash } from "node:crypto";
import {
  readLocalSession,
  sessionDisplayText,
  validLocalSession,
} from "../backends/local-session-logs.mjs";
import { knownErrorCodes } from "./error-codes.mjs";
import { TOOL_NAMES } from "../tools/names.mjs";

const chatScope = /^(group|private):[0-9]{1,20}$/;
const turnStatuses = new Set([
  "running",
  "sent",
  "completed-no-send",
  "failed",
  "cancelled",
  "interrupted",
]);
const pageSize = 12;
const displayTextLimit = 32000;
const bridgeNames = new Set(TOOL_NAMES);

/** @typedef {import("node:sqlite").DatabaseSync} Database */
/** @typedef {{key: string, conversation: string, backend: string, id: string, at: number, current: boolean, count: number}} Entry */

/** @param {unknown} n */
const time = (n) =>
  typeof n === "number" && Number.isSafeInteger(n) && n > 0 ? n : 0;

/** @param {Database} db @param {string} agentId */
function catalog(db, agentId) {
  const current = db
    .prepare(
      `SELECT conversation, json_extract(value,'$.session.id') AS id,
      json_extract(value,'$.session.backend') AS backend,
      json_extract(value,'$.lastTurnEndedAt') AS at, 0 AS count, 1 AS current
      FROM runtime WHERE agent_id=? AND id IS NOT NULL`,
    )
    .all(agentId);
  const historical = db
    .prepare(
      `SELECT json_extract(value,'$.conversation') AS conversation,
      json_extract(value,'$.backendSession.id') AS id,
      json_extract(value,'$.backendSession.backend') AS backend,
      max(coalesce(json_extract(value,'$.endedAt'), json_extract(value,'$.startedAt'))) AS at,
      count(*) AS count, 0 AS current
      FROM model_turns WHERE agent_id=? AND json_extract(value,'$.backendSession.id') IS NOT NULL
      GROUP BY 1,2,3`,
    )
    .all(agentId);
  const archived = db
    .prepare(
      `SELECT json_extract(value,'$.conversation') AS conversation,
      json_extract(value,'$.session.id') AS id,
      json_extract(value,'$.session.backend') AS backend,
      json_extract(value,'$.at') AS at, 0 AS count, 0 AS current
      FROM session_history WHERE agent_id=?`,
    )
    .all(agentId);
  /** @type {Map<string, Entry>} */
  const sessions = new Map();
  /** @type {Map<string, Set<string>>} */
  const owners = new Map();
  for (const row of [...current, ...historical, ...archived]) {
    const { conversation, backend, id } = row;
    if (
      typeof conversation !== "string" ||
      typeof backend !== "string" ||
      typeof id !== "string" ||
      !validLocalSession(backend, id)
    )
      continue;
    const nativeKey = backend + "/" + id;
    if (!owners.has(nativeKey)) owners.set(nativeKey, new Set());
    owners.get(nativeKey)?.add(conversation);
    if (!chatScope.test(conversation)) continue;
    const key = createHash("sha256")
      .update(JSON.stringify([agentId, conversation, backend, id]))
      .digest("hex");
    const found = sessions.get(key);
    if (found) {
      found.at = Math.max(found.at, time(row.at));
      found.current ||= row.current === 1;
      found.count = Math.max(found.count, time(row.count));
    } else {
      sessions.set(key, {
        key,
        conversation,
        backend,
        id,
        at: time(row.at),
        current: row.current === 1,
        count: time(row.count),
      });
    }
  }
  return { sessions, owners };
}

/** @param {Entry} entry */
function sessionInfo({ id: _id, ...publicEntry }) {
  return publicEntry;
}

/** @param {Database} db @param {string} agentId */
export function listSessionTranscripts(db, agentId) {
  return {
    sessions: [...catalog(db, agentId).sessions.values()]
      .sort(
        (a, b) =>
          Number(b.current) - Number(a.current) ||
          b.at - a.at ||
          a.key.localeCompare(b.key),
      )
      .map(sessionInfo),
  };
}

/** @param {unknown} text */
function display(text) {
  const safe = sessionDisplayText(text);
  return safe.length > displayTextLimit
    ? { text: safe.slice(0, displayTextLimit), clipped: true }
    : { text: safe, clipped: false };
}

/** @param {Database} db @param {string} agentId @param {Entry} session */
function storedTurns(db, agentId, session) {
  return db
    .prepare(
      `SELECT id,value FROM model_turns WHERE agent_id=?
      AND json_extract(value,'$.conversation')=?
      AND json_extract(value,'$.backendSession.id')=?
      AND json_extract(value,'$.backendSession.backend')=?
      ORDER BY json_extract(value,'$.startedAt') DESC,id DESC`,
    )
    .all(agentId, session.conversation, session.id, session.backend)
    .flatMap((row) => {
      if (typeof row.id !== "string" || typeof row.value !== "string")
        return [];
      const value = JSON.parse(row.value);
      const startedAt = time(value.startedAt);
      return startedAt
        ? [{ id: row.id, value, startedAt, endedAt: time(value.endedAt) }]
        : [];
    });
}

/** @typedef {ReturnType<typeof storedTurns>[number]} StoredTurn */

/** @param {StoredTurn} row */
function turnInfo({ id, value, startedAt, endedAt }) {
  const usage = value.usage;
  const calls = Array.isArray(value.toolCalls) ? value.toolCalls : [];
  return {
    id,
    startedAt,
    endedAt,
    status: turnStatuses.has(value.status) ? value.status : "recorded",
    usage: time(usage?.contextTokens)
      ? {
          contextTokens: usage.contextTokens,
          measured: usage.source === "measured",
        }
      : null,
    errors: [
      ...new Set(
        calls
          .filter((/** @type {any} */ call) => call?.ok === false)
          .map((/** @type {any} */ call) =>
            knownErrorCodes.has(call.code) ? call.code : "TOOL_FAILED",
          ),
      ),
    ],
    bridgeTools: calls
      .filter((/** @type {any} */ call) => bridgeNames.has(call?.name))
      .map((/** @type {any} */ call) => call.name),
    /** @type {{kind: string, at: number, text: string, clipped: boolean}[]} */
    steps: [],
    /** @type {{at: number, text: string, clipped: boolean}[]} */
    delivered: [],
  };
}

/** @param {StoredTurn[]} rows @param {number} at @param {number} now @param {boolean} [nativeTime] */
function timedTurn(rows, at, now, nativeTime = false) {
  return rows.find(
    ({ startedAt, endedAt }) =>
      at >= (nativeTime ? Math.floor(startedAt / 1000) * 1000 : startedAt) &&
      at <= (endedAt || now),
  );
}

/** @param {{
 *   db: Database, dataRoot: string, agentId: string, key: string,
 *   before?: string | null, now: number, signal?: AbortSignal
 * }} options */
export async function sessionTranscript({
  db,
  dataRoot,
  agentId,
  key,
  before,
  now,
  signal,
}) {
  const { sessions, owners } = catalog(db, agentId);
  const session = sessions.get(key);
  if (!session) return undefined;
  const all = storedTurns(db, agentId, session);
  const cursor = before ? all.findIndex((row) => row.id === before) : -1;
  if (before && cursor < 0) throw Error("INVALID_CURSOR");
  const offset = cursor + 1;
  const page = all.slice(offset, offset + pageSize);
  const turns = page.map(turnInfo);
  const selected = new Map(turns.map((turn) => [turn.id, turn]));
  const since = page.at(-1)?.startedAt;
  const until = Math.max(0, ...page.map((row) => row.endedAt || now));
  let source = "unavailable";
  if (since && owners.get(session.backend + "/" + session.id)?.size === 1) {
    const raw = await readLocalSession({
      root: dataRoot,
      agentId,
      backend: session.backend,
      sid: session.id,
      from: Math.floor(since / 1000) * 1000,
      until,
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(9000)])
        : AbortSignal.timeout(9000),
    });
    /** @type {Map<string, StoredTurn>} */
    const nativeTurns = new Map();
    for (const turn of all) {
      const ids = turn.value.backendTurnIds || [turn.value.backendTurnId];
      if (Array.isArray(ids))
        for (const id of ids)
          if (typeof id === "string" && !nativeTurns.has(id))
            nativeTurns.set(id, turn);
    }
    for (const entry of raw.entries) {
      // A native ID proves the turn when present. Older records and ACP can
      // lack it, so use the stored turn interval within this single QQ scope.
      const owner =
        (entry.nativeTurn && nativeTurns.get(entry.nativeTurn)) ||
        timedTurn(all, entry.at, now) ||
        timedTurn(all, entry.at, now, true);
      if (owner)
        selected.get(owner.id)?.steps.push({
          kind: entry.kind,
          at: entry.at,
          ...display(entry.text),
        });
    }
    source = turns.some((turn) => turn.steps.length)
      ? raw.source
      : "unavailable";
  }
  if (since) {
    const sends = db
      .prepare(
        `SELECT observed_at,body FROM events WHERE agent_id=? AND conversation=?
        AND kind='message.sent' AND status='confirmed' AND observed_at BETWEEN ? AND ?
        ORDER BY observed_at,seq`,
      )
      .all(
        agentId,
        session.conversation,
        new Date(since).toISOString(),
        new Date(until).toISOString(),
      );
    for (const send of sends) {
      if (typeof send.observed_at !== "string") continue;
      const at = Date.parse(send.observed_at);
      const owner = timedTurn(page, at, now);
      if (owner)
        selected.get(owner.id)?.delivered.push({ at, ...display(send.body) });
    }
  }
  return {
    session: sessionInfo(session),
    source,
    turns: turns.reverse().map(({ bridgeTools, ...turn }) => {
      if (!turn.steps.some((step) => step.kind === "tool"))
        for (const name of bridgeTools)
          turn.steps.push({ kind: "tool", at: 0, text: name, clipped: false });
      return turn;
    }),
    nextBefore:
      all.length > offset + page.length ? page.at(-1)?.id || null : null,
  };
}
