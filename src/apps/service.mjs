import { randomUUID } from "node:crypto";
import { AppAdapter } from "./adapter.mjs";
import { appInfo, contentIdentity, resolveAppUrl, publicUrl } from "./urls.mjs";
import { inAppHours, browserCursor } from "./policy.mjs";
import { parseCards } from "./cards.mjs";
import { ownedEvent } from "../tools/forward.mjs";
import { allowed } from "../core/config.mjs";
const LEDGER = "internal:app-browsing";
export const clean = (v, max = 12000) =>
  String(v ?? "")
    .replace(
      /(?:Bearer\s+|(?:access_token|cookie|password|user_pkey)\s*[=:]\s*)[^\s;]+/gi,
      "[credential omitted]",
    )
    .replace(/<[^>]+>/g, " ")
    .slice(0, max);
function scalar(v) {
  return typeof v === "string" || typeof v === "number" ? String(v) : "";
}
export function normalizeRows(raw, job) {
  let rows = Array.isArray(raw) ? raw : raw ? [raw] : [];
  if (
    rows.length &&
    rows.every((x) => typeof x?.field === "string" && "value" in x)
  )
    rows = [Object.fromEntries(rows.map((x) => [x.field, x.value]))];
  if (["read", "comments"].includes(job.operation) && job.url)
    rows = rows.map((x) => ({ ...x, url: x.url || job.url }));
  return rows.slice(0, 100).flatMap((x, index) => {
    if (!x || typeof x !== "object") return [];
    let identity;
    try {
      identity = contentIdentity(x.url, job.platform);
    } catch {
      if (!["read", "comments"].includes(job.operation)) return [];
      identity = contentIdentity(job.url, job.platform);
    }
    return [
      {
        ...identity,
        title: clean(x.title || x.question_title || x.name || "", 500),
        author: clean(scalar(x.author) || scalar(x.user?.username) || "", 200),
        publishedAt: clean(
          x.publishedAt || x.created_at || x.time || x.publish_time || "",
          120,
        ),
        text: clean(
          x.content ||
            x.text ||
            x.description ||
            x.desc ||
            x.snippet ||
            x.excerpt ||
            "",
          64000,
        ),
        sourceMayBeTruncated:
          String(
            x.content ||
              x.text ||
              x.description ||
              x.desc ||
              x.snippet ||
              x.excerpt ||
              " ",
          ).length >= 64000 || !!x.truncated,
        image: (() => {
          try {
            return publicUrl(x.cover || x.image || x.pic || x.thumbnail || "")
              .href;
          } catch {
            return null;
          }
        })(),
        commentId:
          job.operation === "comments" ||
          (job.platform === "tieba" &&
            job.operation === "read" &&
            x.floor != null)
            ? clean(x.id || x.rpid || x.floor || index, 100)
            : null,
      },
    ];
  });
}
export class AppBrowsing {
  constructor(
    runtime,
    { adapter = new AppAdapter(), resolve = resolveAppUrl } = {},
  ) {
    this.runtime = runtime;
    this.adapter = adapter;
    this.resolve = resolve;
    this.epoch = randomUUID();
    this.chains = new Map();
  }
  memory(id) {
    return this.runtime.memory.bind(id);
  }
  state(id) {
    return this.memory(id).state(LEDGER);
  }
  save(id, state) {
    this.memory(id).setState(LEDGER, state);
  }
  async serial(id, fn) {
    const before = this.chains.get(id) || Promise.resolve();
    let release;
    const current = new Promise((r) => (release = r));
    this.chains.set(id, current);
    await before;
    try {
      return await fn();
    } finally {
      release();
      if (this.chains.get(id) === current) this.chains.delete(id);
    }
  }
  active(ctx, platform, { spend = false, sharing = false } = {}) {
    if (
      [...ctx.privateRead].some((id) =>
        /^(operations|operations-result):/.test(id),
      )
    )
      throw Error("APP_RESTRICTED_CONTEXT");
    const r = this.runtime,
      a = r.assertActive(ctx),
      p = a.apps;
    if (
      !p?.enabled ||
      (platform && !p.platforms.includes(platform)) ||
      (sharing && !p.sharing)
    )
      throw Error("APP_PERMISSION_DISABLED");
    if (!inAppHours(p, r.clock())) throw Error("APP_OUTSIDE_HOURS");
    if (spend) {
      const now = r.now(),
        s = this.state(a.id),
        calls = (s.calls || []).filter((t) => t > now - 86400000);
      if (
        calls.length >= p.maxReadsPerDay ||
        (ctx.appReads || 0) >= p.maxReadsPerTurn
      )
        throw Error("APP_READ_BUDGET");
      ctx.appReads = (ctx.appReads || 0) + 1;
      this.save(a.id, { ...s, calls: [...calls, now] });
    }
    return a;
  }
  record(ctx, value) {
    const result = this.memory(ctx.agentId).append({
      connectionId: this.runtime.agent(ctx.agentId).connectionId,
      conversation: ctx.conversation,
      kind: "app.observation",
      direction: "internal",
      status: value.ok === false ? "failed" : "observed",
      body: clean(value.title || value.error || "App 浏览记录", 500),
      payload: { app: value },
      dedupe: "app:" + randomUUID(),
      origin: "app-browser",
    });
    const id = result.id || result.event?.id || result.record?.id;
    if (!id) throw Error("APP_RECORD_STORE_FAILED");
    return { recordId: id, ...value };
  }
  get(ctx, id) {
    const row = this.memory(ctx.agentId)
      .db.prepare(
        "SELECT * FROM events WHERE id=? AND agent_id=? AND kind='app.observation'",
      )
      .get(id, ctx.agentId);
    if (!row) throw Error("APP_RECORD_NOT_FOUND");
    const value = JSON.parse(row.payload).app;
    if (!value) throw Error("APP_RECORD_NOT_FOUND");
    if (
      row.conversation !== ctx.conversation &&
      value.origin !== "app-browser"
    ) {
      ctx.privateRead.add(row.id);
      ctx.persistTaint?.();
    }
    return { recordId: row.id, ...value };
  }
  progress(agentId) {
    return Object.entries(this.state(agentId).cursors || {})
      .filter(([, x]) => x.expiresAt > this.runtime.now())
      .map(([cursor, x]) => ({
        cursor,
        platform: x.platform,
        operation: x.operation,
        entry: x.job.entry,
        recordId: x.job.recordId,
        query: x.job.query,
        buffered: x.pending?.length || 0,
        expiresAt: x.expiresAt,
      }));
  }
  preview(record, maxChars = 6000, offset = 0) {
    const text = record.text || "",
      end = Math.min(text.length, offset + maxChars);
    return {
      ...record,
      text: text.slice(offset, end),
      textOffset: offset,
      storedTextChars: text.length,
      textTruncated: end < text.length || !!record.sourceMayBeTruncated,
      nextTextOffset: end < text.length ? end : null,
    };
  }
  readStored(ctx, { recordId, offset = 0, maxChars = 6000 }) {
    const record = this.get(ctx, recordId);
    this.active(ctx, record.platform);
    return this.preview(record, maxChars, offset);
  }
  history(agentId, offset = 0) {
    const rows = this.memory(agentId)
      .db.prepare(
        "SELECT id,payload,observed_at FROM events WHERE agent_id=? AND kind='app.observation' ORDER BY seq DESC LIMIT 21 OFFSET ?",
      )
      .all(agentId, offset);
    return {
      items: rows.slice(0, 20).map((x) => ({
        recordId: x.id,
        ...JSON.parse(x.payload).app,
        text: undefined,
      })),
      nextOffset: rows.length > 20 ? offset + 20 : null,
    };
  }
  capabilities(agentId) {
    const a = this.runtime.agent(agentId);
    return {
      enabled: a.apps.enabled,
      sharing: a.apps.sharing,
      platforms: this.adapter
        .capabilities()
        .map((p) => ({ ...p, enabled: a.apps.platforms.includes(p.platform) })),
      budgets: {
        readsPerTurn: a.apps.maxReadsPerTurn,
        readsPerDay: a.apps.maxReadsPerDay,
        sharesPerDay: a.apps.maxSharesPerDay,
      },
      hours: a.apps.hours,
    };
  }
  async boards(ctx, { platform }) {
    this.active(ctx, platform, { spend: true });
    this.runtime.assertDisclosure(ctx, { external: true });
    const value = await this.adapter.perform(
      { platform, operation: "boards", streamId: "board-catalog" },
      { signal: ctx.controller.signal },
    );
    this.active(ctx, platform);
    return value;
  }
  async probe(platform) {
    appInfo(platform);
    return this.adapter.perform({
      platform,
      operation: "status",
      streamId: "admin-status-" + platform,
    });
  }
  cards(ctx, { eventId }) {
    const a = this.active(ctx),
      event = ownedEvent(this.runtime, ctx, eventId);
    if (!["message.received", "forward.node"].includes(event.type))
      throw Error("APP_CARD_SOURCE_DENIED");
    if (
      event.connectionId !== a.connectionId ||
      !allowed(a, event.conversation)
    )
      throw Error("APP_CARD_SOURCE_DENIED");
    const source = {
      eventId: event.id,
      messageId: event.messageId,
      connectionId: event.connectionId,
      conversation: event.conversation,
      senderId: event.senderId,
      occurredAt: event.occurredAt,
    };
    return {
      items: parseCards(event.payload?.segments).map((card) =>
        this.record(ctx, {
          ...card,
          origin: "qq-card",
          source,
          fetchedAt: new Date(this.runtime.now()).toISOString(),
          ok: card.availability === "card-summary-only",
          validated: false,
        }),
      ),
      untrustedContent: true,
    };
  }
  async perform(ctx, operation, args) {
    return this.serial(ctx.agentId, async () => {
      const r = this.runtime;
      if (JSON.stringify(args).includes(ctx.token))
        throw Error("APP_SENSITIVE_INPUT");
      let job = { ...args, operation },
        stream,
        prior;
      if (args.cursor) {
        const state = this.state(ctx.agentId);
        stream = state.cursors?.[args.cursor];
        if (
          !stream ||
          stream.expiresAt <= r.now() ||
          stream.operation !== operation ||
          stream.platform !== args.platform
        )
          throw Error("APP_CURSOR_INVALID");
        if (
          stream.epoch !== this.epoch &&
          browserCursor(stream) &&
          !stream.pending?.length
        )
          throw Error("APP_CURSOR_RESTARTED");
        if (
          (args.query && args.query !== stream.job.query) ||
          (args.entry && args.entry !== stream.job.entry) ||
          (args.board && args.board !== stream.job.board)
        )
          throw Error("APP_CURSOR_INVALID");
        job = { ...stream.job, operation, cursor: stream.backendCursor };
      }
      if (args.recordId) {
        prior = this.get(ctx, args.recordId);
        if (stream && stream.job.recordId !== args.recordId)
          throw Error("APP_CURSOR_INVALID");
        if (!prior.url) throw Error("APP_CARD_APP_ONLY");
        job.platform = prior.platform || args.platform;
        job.url = prior.url;
      }
      const a = this.active(ctx, job.platform, { spend: true });
      r.assertDisclosure(ctx, {
        external: !["read", "comments"].includes(operation),
      });
      const streamId = stream?.job.streamId || randomUUID();
      job.streamId = streamId;
      job.limit = Math.min(20, args.limit || stream?.job.limit || 5);
      job.backendLimit = stream?.job.backendLimit || job.limit;
      if (
        stream &&
        browserCursor(job) &&
        stream.epoch !== this.epoch &&
        stream.pending?.length
      )
        stream.backendCursor = null;
      try {
        if (["read", "comments"].includes(operation)) {
          const resolved = await this.resolve(job.url, {
            signal: ctx.controller.signal,
          });
          if (job.platform && resolved.platform !== job.platform)
            throw Error("APP_PLATFORM_MISMATCH");
          job.platform = resolved.platform;
          this.active(ctx, job.platform);
          job.url = resolved.url;
        }
        const result = stream?.pending?.length
          ? {
              items: stream.pending,
              next: stream.backendCursor,
              coverage: stream.coverage,
              normalized: true,
            }
          : await this.adapter.perform(job, { signal: ctx.controller.signal });
        this.active(ctx, job.platform);
        const fetchedAt = new Date(r.now()).toISOString(),
          rows = result.normalized
            ? result.items
            : normalizeRows(result.items, job),
          seen = new Set(stream?.seen || []),
          items = [],
          pending = [];
        let duplicatesRemoved = 0;
        for (const row of rows) {
          const key =
            row.key +
            (row.commentId !== null ? ":comment:" + row.commentId : "");
          if (seen.has(key)) {
            duplicatesRemoved++;
            continue;
          }
          if (items.length >= job.limit) {
            pending.push(row);
            continue;
          }
          seen.add(key);
          items.push(
            this.preview(
              this.record(ctx, {
                ...row,
                ok: true,
                origin: "app-browser",
                operation,
                coverage: result.coverage,
                readingScope: result.coverage,
                fetchedAt,
                validated: ["read", "comments"].includes(operation),
                source: prior?.source || null,
                evidence: prior ? [prior.recordId] : [],
                untrustedContent: true,
              }),
              Math.min(6000, Math.floor(12000 / job.limit)),
            ),
          );
        }
        const state = this.state(ctx.agentId),
          cursors = Object.fromEntries(
            Object.entries(state.cursors || {}).filter(
              ([, v]) => v.expiresAt > r.now(),
            ),
          );
        if (args.cursor) delete cursors[args.cursor];
        let nextCursor = null;
        if (
          (pending.length || result.next) &&
          (stream?.pages || 0) < 100 &&
          (pending.length ||
            result.normalized ||
            JSON.stringify(result.next) !== JSON.stringify(job.cursor)) &&
          Object.keys(cursors).length < 20
        ) {
          nextCursor = randomUUID();
          cursors[nextCursor] = {
            job: { ...job, cursor: undefined },
            operation,
            platform: job.platform,
            backendCursor: result.next,
            pending,
            coverage: result.coverage,
            seen: [...seen].slice(-10000),
            pages: (stream?.pages || 0) + (result.normalized ? 0 : 1),
            expiresAt: r.now() + 3600000,
            epoch: this.epoch,
          };
        }
        this.save(ctx.agentId, { ...state, cursors });
        return {
          platform: job.platform,
          operation,
          coverage: result.coverage,
          items,
          nextCursor,
          duplicatesRemoved,
          untrustedContent: true,
          videoUnderstanding: false,
          ...(!items.length
            ? {
                notice: nextCursor
                  ? "本页没有新的内容；仍有后端下一页，可继续读取。"
                  : "本次没有新内容，也没有继续游标。",
              }
            : {}),
        };
      } catch (error) {
        const code = /^APP_[A-Z_]+$/.test(error.message)
          ? error.message
          : "APP_READ_FAILED";
        this.record(ctx, {
          ok: false,
          origin: "app-browser",
          platform: job.platform,
          operation,
          error: code,
          fetchedAt: new Date(r.now()).toISOString(),
          untrustedContent: true,
        });
        throw Error(code);
      }
    });
  }
}
