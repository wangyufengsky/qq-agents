// @ts-check

import { createHash } from "node:crypto";
import { prepared, recallBoundary } from "../core/recall-boundary.mjs";

/** @typedef {keyof typeof SOURCES} Partition */
/** @typedef {Record<Partition, number>} Watermarks */
/** @typedef {{id:string, seq:number, revision:number, conversation:string, kind:string, direction:string, status:string, body:string, title:string, sender_id:string|null, occurred_at:string, updated_at:string, written_at:string, payload:string, metadata:string, value:string}} SourceRow */
/** @typedef {{id:string, type:"event"|"diary"|"correction", scopeId:string, sourceScopes:string[], seq:number, text:string, time:string, observed:boolean, fingerprint:string, revision?:number, direction?:string, kind?:string, senderId?:string|null}} DreamSource */

export const SOURCES = Object.freeze({
  events: {
    from: "events r",
    cursor: "r.seq",
    type: /** @type {const} */ ("event"),
  },
  diaries: {
    from: "diary_revisions r JOIN diaries d ON d.id=r.id",
    cursor: "r.rowid",
    type: /** @type {const} */ ("diary"),
  },
  corrections: {
    from: "memory_corrections r",
    cursor: "r.rowid",
    type: /** @type {const} */ ("correction"),
  },
});
/** @param {Partition} partition */
export function sourceRoleColumn(partition) {
  return partition === "diaries" ? "d.agent_id" : "r.agent_id";
}

export const SOURCE_PARTITIONS = /** @type {Partition[]} */ (
  Object.keys(SOURCES)
);

/** @param {unknown} value */
export function sourceScope(value) {
  if (typeof value !== "string") return "global";
  if (value === "@desktop") return "desktop";
  return /^(group|private):\d+$/.test(value) ? value : "global";
}

/** @param {any} runtime @param {{agentId:string, conversation:string}} ctx @param {Watermarks} limits */
export function dreamSources(runtime, ctx, limits) {
  const memory = runtime.memory.bind(ctx.agentId),
    db = memory.db;
  const boundary = recallBoundary(runtime, ctx, { publicOnly: true });

  /** @param {Partition} partition @param {string} id */
  const get = (partition, id) => {
    const { from, cursor } = SOURCES[partition];
    return /** @type {SourceRow|undefined} */ (
      prepared(
        db,
        `SELECT ${cursor} AS seq,r.* FROM ${from} WHERE ${sourceRoleColumn(partition)}=? AND r.id=?${partition === "diaries" ? " AND r.revision=d.revision" : ""}`,
      ).get(ctx.agentId, id)
    );
  };

  /** @param {string} id @param {number} beforeRevisionRow */
  const diaryBefore = (id, beforeRevisionRow) =>
    /** @type {SourceRow|undefined} */ (
      prepared(
        db,
        `SELECT r.rowid AS seq,r.* FROM ${SOURCES.diaries.from}
        WHERE d.agent_id=? AND r.id=? AND r.rowid<?
        ORDER BY r.rowid DESC LIMIT 1`,
      ).get(ctx.agentId, id, beforeRevisionRow)
    );

  /** @param {string} id @param {number} revision */
  const diaryRevision = (id, revision) =>
    /** @type {SourceRow|undefined} */ (
      prepared(
        db,
        `SELECT r.rowid AS seq,r.* FROM ${SOURCES.diaries.from}
        WHERE d.agent_id=? AND r.id=? AND r.revision=?`,
      ).get(ctx.agentId, id, revision)
    );

  /** @param {Partition} partition @param {SourceRow} row @param {Set<string>} [seen] @param {boolean} [provenanceOnly] @returns {DreamSource|null} */
  function project(partition, row, seen = new Set(), provenanceOnly = false) {
    if ((!provenanceOnly && row.seq > limits[partition]) || seen.has(row.id))
      return null;
    const { id, seq } = row,
      { type } = SOURCES[partition];
    /** @type {Set<string>} */
    const scopes = new Set();
    /** @type {string} */
    let scopeId, text, time;
    let observed = false;
    /** @type {Partial<DreamSource>} */
    let eventFields = {};

    if (partition === "events") {
      const payload = JSON.parse(row.payload);
      if (
        !boundary.allowed({
          id,
          conversation: row.conversation,
          payload,
          evidence: payload.evidence,
          sources: payload.sources,
        })
      )
        return null;
      if (
        memory.recallAnnotation(id).recalled ||
        row.kind === "message.recalled"
      )
        return null;
      scopeId = sourceScope(row.conversation);
      for (const source of [
        payload.app?.source?.conversation,
        ...(payload.sourceScopes ?? []),
        ...(payload.sources ?? []).map(
          (/** @type {{conversation?:string}} */ item) => item.conversation,
        ),
      ])
        scopes.add(sourceScope(source));
      for (const { parent_id } of prepared(
        db,
        "SELECT DISTINCT parent_id FROM dream_event_parents WHERE agent_id=? AND id=?",
      ).all(ctx.agentId, id)) {
        const parent = get("events", String(parent_id));
        const source =
          parent &&
          parent.seq < row.seq &&
          project("events", parent, new Set([...seen, id]), true);
        if (!source) return null;
        for (const scope of source.sourceScopes) scopes.add(scope);
      }
      observed =
        (row.kind === "message.received" &&
          row.direction === "in" &&
          row.status === "observed") ||
        (row.kind === "action.confirmed" && row.status === "confirmed");
      text = row.body;
      time = row.occurred_at;
      eventFields = {
        direction: row.direction,
        kind: row.kind,
        senderId: row.sender_id,
      };
    } else if (partition === "diaries") {
      eventFields = { revision: row.revision };
      const metadata = JSON.parse(row.metadata);
      const conversation =
        typeof metadata.writtenIn === "string"
          ? metadata.writtenIn
          : metadata.writtenIn?.conversation;
      if (
        !boundary.allowed({
          id,
          conversation,
          metadata,
          evidence: metadata.evidence,
          sources: metadata.sources,
        })
      )
        return null;
      for (const evidence of metadata.evidence ?? []) {
        if (typeof evidence !== "string") continue;
        if (evidence.startsWith("context:")) {
          scopes.add(sourceScope(evidence.slice(8)));
          continue;
        }
        const event = get("events", evidence);
        const diary = event ? undefined : diaryBefore(evidence, row.seq);
        const ancestors = new Set([...seen, id]);
        const source = event
          ? project("events", event, ancestors, true)
          : diary && project("diaries", diary, ancestors, true);
        if (!source) return null;
        for (const scope of source.sourceScopes) scopes.add(scope);
      }
      scopeId = sourceScope(conversation);
      text = `${row.title}\n${row.body}`;
      time = row.updated_at || row.written_at;
    } else {
      const value = JSON.parse(row.value);
      if (value.supersededBy) return null;
      const source = get("events", value.sourceId);
      const supporting = source && project("events", source);
      if (
        !supporting ||
        !boundary.allowed({
          ...value,
          id,
          conversation: value.sourceConversation,
          evidence: [value.sourceId],
        })
      )
        return null;
      for (const target of value.targets ?? []) {
        let record;
        try {
          record = memory.corrections.record(target.type, target.id);
        } catch (error) {
          if (!(error instanceof Error) || error.message !== "RECORD_NOT_FOUND")
            throw error;
          return null;
        }
        if (!boundary.allowed(record)) return null;
        scopes.add(
          sourceScope(
            record.conversation ??
              record.writtenIn?.conversation ??
              record.writtenIn,
          ),
        );
        if (target.type === "event" || target.type === "diary") {
          const targetPartition =
            target.type === "event" ? "events" : "diaries";
          const targetRow =
            targetPartition === "diaries" && target.revision > 0
              ? diaryRevision(target.id, target.revision)
              : get(targetPartition, target.id);
          const targetSource =
            targetRow && project(targetPartition, targetRow, seen, true);
          if (!targetSource) return null;
          for (const scope of targetSource.sourceScopes) scopes.add(scope);
        } else {
          const provenance = target.provenance;
          if (!provenance || provenance.unresolved) return null;
          for (const scope of provenance.scopes) scopes.add(sourceScope(scope));
          for (const ref of provenance.refs) {
            if (ref.id.startsWith("context:")) {
              scopes.add(sourceScope(ref.id.slice(8)));
              continue;
            }
            const event = get("events", ref.id);
            const diary = event
              ? undefined
              : ref.revision
                ? diaryRevision(ref.id, ref.revision)
                : get("diaries", ref.id);
            const ancestors = new Set([...seen, id]);
            const parent = event
              ? project("events", event, ancestors, true)
              : diary && project("diaries", diary, ancestors, true);
            if (!parent) return null;
            for (const scope of parent.sourceScopes) scopes.add(scope);
          }
        }
      }
      for (const scope of supporting.sourceScopes) scopes.add(scope);
      scopeId = supporting.scopeId;
      text = `旧认识：${value.oldBelief}\n更正：${value.current}`;
      time = value.createdAt;
    }
    if (!text.trim() && !provenanceOnly) return null;
    scopes.add(scopeId);
    const sourceScopes = [...scopes]
      .filter((scope) => scope !== "global")
      .sort();
    return {
      id,
      seq,
      type,
      scopeId,
      sourceScopes,
      text,
      time,
      observed,
      fingerprint: createHash("sha256")
        .update(JSON.stringify([row, sourceScopes]))
        .digest("hex"),
      ...eventFields,
    };
  }

  return {
    /** @param {string} id @param {number} [revision] */
    read(id, revision) {
      if (revision !== undefined) {
        const row = diaryRevision(id, revision);
        return row && project("diaries", row);
      }
      for (const partition of SOURCE_PARTITIONS) {
        const row = get(partition, id);
        if (row) return project(partition, row);
      }
      return undefined;
    },
    /** @param {Partition} partition @param {number} after @param {number} limit @param {string} [needle] */
    *scan(partition, after, limit, needle) {
      const { from, cursor } = SOURCES[partition];
      const rows =
        /** @type {Iterable<SourceRow & {revision:number,latest_revision:number}>} */ (
          prepared(
            db,
            `SELECT ${cursor} AS seq,r.*,${partition === "diaries" ? "d.revision" : "0"} AS latest_revision
        FROM ${from} WHERE ${sourceRoleColumn(partition)}=? AND ${cursor}>? AND ${cursor}<=? ORDER BY ${cursor} LIMIT ?`,
          ).iterate(ctx.agentId, after, limits[partition], limit)
        );
      for (const { latest_revision, ...row } of rows) {
        if (needle === undefined && partition === "corrections") {
          const value = JSON.parse(row.value);
          const source = get("events", value.sourceId);
          // This correction becomes eligible in a later batch with its cited event.
          if (!value.supersededBy && source && source.seq > limits.events)
            break;
        }
        const match =
          !needle ||
          (partition === "events"
            ? row.body
            : partition === "diaries"
              ? `${row.title}\n${row.body}`
              : row.value
          )
            .toLowerCase()
            .includes(needle);
        yield {
          seq: row.seq,
          item:
            !match ||
            (partition === "diaries" && row.revision !== latest_revision)
              ? null
              : project(partition, row),
        };
      }
    },
  };
}

/** @param {DreamSource} source @param {number} [maxChars] */
export function visibleSource(source, maxChars = 1600) {
  const {
    id,
    type,
    revision,
    scopeId,
    sourceScopes,
    text,
    time,
    direction,
    kind,
    senderId,
  } = source;
  return {
    id,
    type,
    revision,
    scopeId,
    sourceScopes,
    time,
    direction,
    kind,
    senderId,
    text: text.slice(0, maxChars),
    truncated: text.length > maxChars,
  };
}
