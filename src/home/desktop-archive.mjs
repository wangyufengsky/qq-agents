import { randomUUID } from "node:crypto";
import { DESKTOP_CONVERSATION } from "./desktop-decision.mjs";

export { DESKTOP_CONVERSATION };
export const DESKTOP_ADMINISTRATOR = "@administrator";
const connectionId = "@desktop";
const namespace = "desktop";

export function isGroupConversation(conversation) {
  return (
    conversation === DESKTOP_CONVERSATION || conversation.startsWith("group:")
  );
}

export function initializeDesktopArchive(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS desktop_messages(
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      id TEXT UNIQUE NOT NULL,
      actor TEXT NOT NULL,
      speaker_type TEXT NOT NULL,
      speaker TEXT NOT NULL,
      text TEXT NOT NULL,
      sent_at INTEGER NOT NULL,
      attachments TEXT NOT NULL
    );
  `);
}

export class DesktopArchive {
  constructor(store) {
    this.store = store;
    this.db = store.db;
  }

  history({ beforeSeq = Number.MAX_SAFE_INTEGER, limit = 160 } = {}) {
    return this.db
      .prepare(
        "SELECT seq, id AS messageId, actor, speaker_type AS speakerType, speaker, text, sent_at AS now, attachments FROM desktop_messages WHERE seq<? ORDER BY seq DESC LIMIT ?",
      )
      .all(beforeSeq, limit)
      .reverse()
      .map(({ attachments, ...row }) => ({
        ...row,
        attachments: JSON.parse(attachments),
      }));
  }

  publish({
    actor,
    speakerType,
    speaker,
    text,
    now,
    present,
    identities,
    targets,
    attachments = [],
    turnId,
  }) {
    const messageId = randomUUID();
    const occurredAt = new Date(now).toISOString();
    const requestId = `desktop:${messageId}`;
    const administrator = speakerType === "administrator";
    return this.store.transaction(() => {
      const { lastInsertRowid } = this.db
        .prepare(
          "INSERT INTO desktop_messages(id,actor,speaker_type,speaker,text,sent_at,attachments) VALUES(?,?,?,?,?,?,?)",
        )
        .run(
          messageId,
          actor,
          speakerType,
          speaker,
          text,
          now,
          JSON.stringify(attachments),
        );
      for (const agentId of present) {
        const memory = this.store.bind(agentId);
        const own = !administrator && agentId === actor;
        const payload = {
          messageNamespace: namespace,
          senderName: speaker,
          desktop: {
            senderQq: identities[administrator ? DESKTOP_ADMINISTRATOR : actor],
            targets,
            targetQq: targets.flatMap((target) => identities[target] || []),
            attachments,
            ...(own && turnId && { turnId }),
          },
          ...(own && { requestId }),
        };
        if (own) {
          memory.reserveDelivery(requestId, DESKTOP_CONVERSATION, { text });
          memory.completeDelivery(requestId, "sent", messageId);
        }
        memory.append({
          dedupe: own ? `send:${requestId}:sent` : requestId,
          connectionId,
          conversation: DESKTOP_CONVERSATION,
          kind: own ? "message.sent" : "message.received",
          direction: own ? "out" : "in",
          status: own ? "confirmed" : "observed",
          senderId: administrator
            ? "desktop:administrator"
            : `desktop:agent:${actor}`,
          messageId,
          occurredAt,
          observedAt: occurredAt,
          body: text,
          payload,
        });
      }
      return {
        messageId,
        seq: Number(lastInsertRowid),
        actor,
        speakerType,
        speaker,
        text,
        now,
        attachments,
      };
    });
  }

  opening(agentId, afterSeq) {
    return this.db
      .prepare(
        `
        SELECT e.id, e.seq, d.seq AS roomSeq, e.message_id AS messageId, e.body AS text, e.direction,
          d.speaker_type AS speakerType, d.sent_at AS now,
          json_extract(e.payload,'$.senderName') AS speaker,
          json_extract(e.payload,'$.desktop.senderQq') AS senderQq,
          json_extract(e.payload,'$.desktop.attachments') AS attachments
        FROM events e
        JOIN desktop_messages d ON d.id=e.message_id
        WHERE e.agent_id=? AND e.conversation=? AND e.connection_id=?
          AND e.kind IN ('message.received','message.sent')
          AND d.seq>?
          AND NOT EXISTS (
            SELECT 1 FROM message_progress p WHERE p.agent_id=e.agent_id
              AND p.conversation=e.conversation AND p.seq=e.seq AND p.summary_only=0
          )
        ORDER BY d.seq LIMIT 24
      `,
      )
      .all(agentId, DESKTOP_CONVERSATION, connectionId, afterSeq)
      .map(({ attachments, ...row }) => ({
        ...row,
        attachments: JSON.parse(attachments || "[]"),
      }));
  }

  commitOpening(agentId, messages, elsewhere) {
    this.store.transaction(() => {
      const insert = this.db.prepare(
        "INSERT INTO message_progress(agent_id,conversation,seq,summary_only) SELECT agent_id,conversation,seq,0 FROM events WHERE agent_id=? AND conversation=? AND id=? AND seq=? AND connection_id=? ON CONFLICT(agent_id,conversation,seq) DO UPDATE SET summary_only=0",
      );
      for (const { id, seq } of messages)
        insert.run(agentId, DESKTOP_CONVERSATION, id, seq, connectionId);
      if (elsewhere) {
        const memory = this.store.bind(agentId);
        memory.setState(DESKTOP_CONVERSATION, {
          ...memory.state(DESKTOP_CONVERSATION),
          elsewhereShown: elsewhere.shown,
          elsewhereWordsThroughSeq: elsewhere.words.through,
        });
      }
    });
  }
}

export function desktopInputCommitted(memory, row) {
  return Boolean(
    memory.db
      .prepare(
        "SELECT 1 FROM message_progress WHERE agent_id=? AND conversation=? AND seq=? AND summary_only=0",
      )
      .get(memory.agentId, DESKTOP_CONVERSATION, row.seq),
  );
}
