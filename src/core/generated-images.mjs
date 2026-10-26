import { createHash } from "node:crypto";
import { generationError } from "../backends/generated-image-file.mjs";
import { taintMedia } from "../tools/legacy.mjs";

const protectedRead = (ctx) =>
  [...ctx.privateRead].some((x) => /^(operations|operations-result):/.test(x));
export class GeneratedImages {
  constructor(runtime) {
    this.runtime = runtime;
    this.db = runtime.memory.db;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS image_sessions(agent_id TEXT NOT NULL, session_id TEXT NOT NULL, backend_id TEXT NOT NULL, conversation TEXT NOT NULL, protected_operations INTEGER NOT NULL, at INTEGER NOT NULL, PRIMARY KEY(agent_id,session_id));
      CREATE TABLE IF NOT EXISTS image_generations(agent_id TEXT NOT NULL, id TEXT NOT NULL, session_id TEXT NOT NULL, conversation TEXT NOT NULL, value TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY(agent_id,id));
      CREATE INDEX IF NOT EXISTS image_generations_scope ON image_generations(agent_id,conversation,at);
    `);
  }
  begin(ctx, sessionId) {
    const a = this.runtime.assertActive(ctx);
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(sessionId))
      throw Error("INVALID_IMAGE_SESSION");
    const old = this.db
      .prepare("SELECT * FROM image_sessions WHERE agent_id=? AND session_id=?")
      .get(a.id, sessionId);
    if (
      old &&
      (old.conversation !== ctx.conversation || old.backend_id !== a.backendId)
    )
      throw Error("IMAGE_SESSION_SCOPE_MISMATCH");
    this.db
      .prepare(
        "INSERT INTO image_sessions VALUES(?,?,?,?,?,?) ON CONFLICT(agent_id,session_id) DO UPDATE SET protected_operations=MAX(protected_operations,excluded.protected_operations),at=excluded.at",
      )
      .run(
        a.id,
        sessionId,
        a.backendId,
        ctx.conversation,
        +protectedRead(ctx),
        this.runtime.now(),
      );
    ctx.imageSession = sessionId;
  }
  taint(ctx) {
    if (ctx.imageSession && protectedRead(ctx))
      this.db
        .prepare(
          "UPDATE image_sessions SET protected_operations=1 WHERE agent_id=? AND session_id=?",
        )
        .run(ctx.agentId, ctx.imageSession);
  }
  capture(ctx, backend, sessionId, item) {
    this.runtime.assertActive(ctx);
    this.taint(ctx);
    const source = this.db
      .prepare(
        "SELECT * FROM image_sessions WHERE agent_id=? AND session_id=? AND conversation=? AND backend_id=?",
      )
      .get(
        ctx.agentId,
        sessionId,
        ctx.conversation,
        this.runtime.agent(ctx.agentId).backendId,
      );
    if (
      !source ||
      item?.type !== "imageGeneration" ||
      typeof item.id !== "string" ||
      item.id.length > 512
    )
      throw Error("GENERATED_IMAGE_SOURCE_DENIED");
    if (!["completed", "failed"].includes(item.status)) return;
    const id = createHash("sha256")
      .update(JSON.stringify([sessionId, item.id]))
      .digest("hex");
    const old = this.db
      .prepare("SELECT value FROM image_generations WHERE agent_id=? AND id=?")
      .get(ctx.agentId, id);
    const existing = old && JSON.parse(old.value);
    let stored;
    if (existing?.status === "ready") {
      try {
        stored = this.runtime.media.read(ctx.agentId, existing.mediaId);
      } catch {}
    }
    if (stored) {
      if (source.protected_operations) {
        const meta = this.runtime.media.metadata(ctx.agentId, existing.mediaId);
        if (!meta.protectedOperations) {
          this.runtime.media.put(
            ctx.agentId,
            Buffer.from(stored.data, "base64"),
            stored.mimeType,
            { ...meta, protectedOperations: true },
          );
        }
      }
      return existing;
    }
    const value = {
      id,
      createdAt:
        existing?.createdAt || new Date(this.runtime.now()).toISOString(),
      status: "generation-failed",
    };
    if (item.status === "failed") value.error = generationError(item.failure);
    else {
      try {
        const image = backend.readGeneratedImage(sessionId, item);
        this.runtime.assertActive(ctx);
        const saved = this.runtime.media.put(
          ctx.agentId,
          image.buffer,
          image.mimeType,
          {
            generatedBy: "codex-native-image",
            sourceType: "generated-image",
            conversation: ctx.conversation,
            saved: true,
            kind: "generated",
            title: "生成图",
            createdAt: value.createdAt,
            protectedOperations: !!source.protected_operations,
            generatedArtifactId: id,
          },
        );
        Object.assign(value, {
          status: "ready",
          mediaId: saved.id,
          mimeType: saved.mimeType,
          bytes: saved.bytes,
        });
      } catch (e) {
        this.runtime.assertActive(ctx);
        value.status = "registration-failed";
        value.error = {
          code: [
            "INVALID_IMAGE",
            "IMAGE_TOO_LARGE",
            "GENERATED_IMAGE_FILE_CHANGED",
          ].includes(e.message)
            ? e.message
            : "GENERATED_IMAGE_FILE_UNAVAILABLE",
          hint: "生成产物尚未登记，不能声称已发送。保留原图并检查文件；不要重新生图来掩盖登记失败。",
        };
      }
    }
    this.db
      .prepare(
        "INSERT INTO image_generations VALUES(?,?,?,?,?,?) ON CONFLICT(agent_id,id) DO UPDATE SET value=excluded.value",
      )
      .run(
        ctx.agentId,
        id,
        sessionId,
        ctx.conversation,
        JSON.stringify(value),
        this.runtime.now(),
      );
    return value;
  }
  async recover(ctx, { sessionOffset = 0 } = {}) {
    const a = this.runtime.assertActive(ctx),
      backend = this.runtime.backends.get(a.id);
    if (!backend?.imageHistory)
      return { nextSessionOffset: null, recoveryErrors: [] };
    const sessions = this.db
      .prepare(
        "SELECT session_id FROM image_sessions WHERE agent_id=? AND conversation=? AND backend_id=? ORDER BY at DESC,session_id LIMIT 6 OFFSET ?",
      )
      .all(a.id, ctx.conversation, a.backendId, sessionOffset);
    const recoveryErrors = [];
    for (const { session_id: id } of sessions.slice(0, 5)) {
      try {
        const items = await backend.imageHistory(id);
        this.runtime.assertActive(ctx);
        for (const item of items) this.capture(ctx, backend, id, item);
      } catch {
        this.runtime.assertActive(ctx);
        recoveryErrors.push({
          code: "GENERATED_IMAGE_HISTORY_UNAVAILABLE",
          hint: "本页有生成会话未能恢复；已登记产物仍保留。没有重新生图或发送。",
        });
      }
    }
    return {
      nextSessionOffset: sessions.length > 5 ? sessionOffset + 5 : null,
      recoveryErrors,
    };
  }
  list(ctx, { offset = 0, limit = 10 } = {}) {
    this.runtime.assertActive(ctx);
    const rows = this.db
      .prepare(
        "SELECT value FROM image_generations WHERE agent_id=? AND conversation=? ORDER BY at DESC,id LIMIT ? OFFSET ?",
      )
      .all(ctx.agentId, ctx.conversation, limit + 1, offset);
    const items = rows.slice(0, limit).map((row) => {
      const value = JSON.parse(row.value);
      let delivery = { status: "not-sent" };
      if (value.mediaId) {
        taintMedia(
          ctx,
          this.runtime.media.metadata(ctx.agentId, value.mediaId),
        );
        const receipt = this.db
          .prepare(
            `SELECT d.status,d.request_id AS requestId,d.message_id AS messageId FROM events e JOIN deliveries d ON d.agent_id=e.agent_id AND d.request_id=json_extract(e.payload,'$.requestId') WHERE e.agent_id=? AND e.conversation=? AND json_extract(e.payload,'$.mediaId')=? ORDER BY e.seq DESC LIMIT 1`,
          )
          .get(ctx.agentId, ctx.conversation, value.mediaId);
        if (receipt) delivery = { ...receipt };
      }
      return { ...value, delivery };
    });
    return {
      items,
      nextOffset: rows.length > limit ? offset + limit : null,
      notice:
        "ready 仅表示已生成并登记。QQ 投递以 delivery 为准；pending/unknown 不得换 requestId 重发。使用 qq_send(mediaId) 发送原图，无需重新生图。",
    };
  }
  assertDelivery(ctx, mediaId, requestId) {
    if (
      !this.db
        .prepare(
          "SELECT 1 FROM image_generations WHERE agent_id=? AND json_extract(value,'$.mediaId')=?",
        )
        .get(ctx.agentId, mediaId)
    )
      return;
    const previous = this.db
      .prepare(
        `SELECT d.request_id FROM events e JOIN deliveries d ON d.agent_id=e.agent_id AND d.request_id=json_extract(e.payload,'$.requestId') WHERE e.agent_id=? AND e.conversation=? AND json_extract(e.payload,'$.mediaId')=? AND d.status IN ('pending','unknown') AND d.request_id<>? LIMIT 1`,
      )
      .get(ctx.agentId, ctx.conversation, mediaId, requestId);
    if (previous) throw Error("GENERATED_IMAGE_DELIVERY_UNKNOWN");
  }
}
