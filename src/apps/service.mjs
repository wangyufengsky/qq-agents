import { randomUUID } from "node:crypto";
import { AppCursors } from "./cursors.mjs";
import { AppAdapter } from "./adapter.mjs";
import { appInfo, contentIdentity, resolveAppUrl, publicUrl } from "./urls.mjs";
import { inAppHours, browserCursor, APP_LEDGER } from "./policy.mjs";
import { parseCards } from "./cards.mjs";
import { ownedEvent } from "../tools/forward.mjs";
import { requestedByHuman, sourceClass } from "../core/outbound-policy.mjs";
import { allowed } from "../core/config.mjs";
const LEDGER = APP_LEDGER;
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
  if (rows.length > 100) throw Error("APP_RESULT_BUDGET");
  return rows.flatMap((x, index) => {
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
        images: [
          ...new Set(
            [
              x.cover || x.image || x.pic || x.thumbnail,
              ...(Array.isArray(x.images)
                ? x.images
                : typeof x.images === "string"
                  ? x.images.split("\n")
                  : []),
              ...(Array.isArray(x.imageList) ? x.imageList : []),
            ].flatMap((value) => {
              try {
                const url =
                  typeof value === "string"
                    ? value
                    : value?.url || value?.urlDefault || value?.url_default;
                return [
                  publicUrl(url?.startsWith("//") ? "https:" + url : url).href,
                ];
              } catch {
                return [];
              }
            }),
          ),
        ].slice(0, 50),
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
    { adapter = new AppAdapter(), resolve = resolveAppUrl, cursorLimits } = {},
  ) {
    this.runtime = runtime;
    this.adapter = adapter;
    this.resolve = resolve;
    this.epoch = randomUUID();
    this.chains = new Map();
    this.cursors = new AppCursors(runtime.memory, cursorLimits);
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
  active(
    ctx,
    platform,
    {
      spend = false,
      sharing = false,
      requested = false,
      network = false,
      fixed = false,
    } = {},
  ) {
    if (
      (!fixed || sharing) &&
      [...ctx.privateRead].some((id) =>
        ["operations", "private-repository"].includes(
          sourceClass(this.runtime, ctx, id),
        ),
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
    if (
      (spend || sharing || network) &&
      !inAppHours(p, r.clock(), { requested })
    )
      throw Error("APP_OUTSIDE_HOURS");
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
      (row.conversation !== ctx.conversation &&
        value.origin !== "app-browser") ||
      (value.source?.conversation &&
        value.source.conversation !== ctx.conversation)
    ) {
      ctx.privateRead.add(row.id);
      ctx.persistTaint?.();
    }
    return { recordId: row.id, ...value };
  }
  // Reads spent against the daily budget, which counts the last 24 hours.
  readsLastDay(agentId) {
    const now = this.runtime.now();
    return (this.state(agentId).calls || []).filter((t) => t > now - 86400000)
      .length;
  }
  progress(agentId) {
    this.cursors.prepare(agentId, this.runtime.now());
    return this.cursors.list(agentId).map((x) => ({
      cursor: x.id,
      platform: x.platform,
      operation: x.operation,
      entry: x.job.entry,
      recordId: x.job.recordId,
      query: x.job.query,
      buffered: x.pendingCount,
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
    this.active(ctx, record.platform, {
      fixed: record.origin === "app-browser" && !record.source,
    });
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
  capabilities(agentId, ctx = null) {
    const a = this.runtime.agent(agentId);
    let contextGate, fixedPublicReads;
    if (ctx) {
      try {
        this.active(ctx, undefined, { network: true });
        contextGate = { allowed: true, code: null };
      } catch (error) {
        contextGate = { allowed: false, code: error.message };
      }
      try {
        this.active(ctx, undefined, { network: true, fixed: true });
        fixedPublicReads = { allowed: true, code: null };
      } catch (error) {
        fixedPublicReads = { allowed: false, code: error.message };
      }
    }
    return {
      ...(contextGate
        ? {
            contextGate,
            fixedPublicReads: {
              ...fixedPublicReads,
              notice:
                "Fixed app_browse feeds (recommend/following/hot/ranking without board), app_boards and app_read/app_comments/app_record of records returned by the platform remain available after protected recall. Arbitrary queries, board names, QQ cards and sharing remain restricted. Use returned recordId/cursor; never copy protected text into a request.",
            },
            probeNotice:
              "Recent platform probes describe service health, not current-context authorization. Platform permissions, tool allowlists and budgets still apply.",
          }
        : {}),
      enabled: a.apps.enabled,
      autonomousNetwork: a.network?.autonomous === true,
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
  async boards(ctx, { platform, requestEventId }) {
    const auth = this.runtime.authorizeExternal(
      ctx,
      { tool: "app_boards", args: { platform } },
      { requestEventId, fixed: true },
    );
    this.active(ctx, platform, {
      spend: true,
      requested: auth.requested,
      fixed: true,
    });
    const value = await this.adapter.perform(
      { platform, operation: "boards", streamId: "board-catalog" },
      { signal: ctx.controller.signal },
    );
    this.active(ctx, platform, { fixed: true });
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
      !allowed(a, event.conversation, this.runtime.config)
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
      this.cursors.prepare(ctx.agentId, r.now());
      if (JSON.stringify(args).includes(ctx.token))
        throw Error("APP_SENSITIVE_INPUT");
      let job = { ...args, operation },
        stream,
        prior;
      if (args.cursor) {
        stream = this.cursors.get(ctx.agentId, args.cursor);
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
        if (!stream.pending.length && stream.pages >= this.cursors.limits.pages)
          throw Error("APP_CURSOR_BUDGET");
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
      const request = {
        tool: "app_" + operation,
        args:
          operation === "search"
            ? { platform: job.platform, query: job.query }
            : operation === "browse"
              ? {
                  platform: job.platform,
                  entry: job.entry,
                  ...(job.board ? { board: job.board } : {}),
                }
              : { platform: job.platform, url: job.url },
      };
      const requestEventId = args.requestEventId || stream?.job.requestEventId;
      const fixed =
        (operation === "browse" &&
          ["recommend", "following", "hot", "ranking"].includes(job.entry) &&
          !job.board &&
          !job.query) ||
        (["read", "comments"].includes(operation) &&
          prior?.origin === "app-browser" &&
          !prior.source);
      const requested = requestedByHuman(r, ctx, request, requestEventId);
      this.active(ctx, job.platform, { network: true, requested, fixed });
      r.authorizeExternal(ctx, request, { requestEventId, fixed });
      this.active(ctx, job.platform, { spend: true, requested, fixed });
      job.requestEventId = requestEventId;
      const streamId = stream?.job.streamId || randomUUID();
      job.streamId = streamId;
      job.limit = Math.min(20, args.limit || stream?.job.limit || 5);
      job.backendLimit = stream?.job.backendLimit || job.limit;
      let continuationInterrupted = stream?.continuationInterrupted || false;
      if (
        stream &&
        browserCursor(job) &&
        stream.epoch !== this.epoch &&
        stream.pending?.length
      ) {
        stream.backendCursor = null;
        continuationInterrupted = true;
      }
      try {
        if (["read", "comments"].includes(operation)) {
          const resolved = await this.resolve(job.url, {
            signal: ctx.controller.signal,
            authorize: (url) =>
              r.authorizeExternal(
                ctx,
                {
                  tool: "app_" + operation,
                  args: { platform: job.platform, url },
                },
                { requestEventId, fixed: true },
              ),
          });
          if (job.platform && resolved.platform !== job.platform)
            throw Error("APP_PLATFORM_MISMATCH");
          job.platform = resolved.platform;
          this.active(ctx, job.platform, { network: true, requested, fixed });
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
        this.active(ctx, job.platform, { network: true, requested, fixed });
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
          items.push({
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
          });
        }
        let nextCursor = null;
        let continuation;
        if (pending.length || result.next) {
          if (
            !pending.length &&
            !result.normalized &&
            JSON.stringify(result.next) === JSON.stringify(job.cursor)
          )
            throw Error("APP_CURSOR_STALLED");
          nextCursor = randomUUID();
          continuation = {
            job: { ...job, cursor: undefined },
            operation,
            platform: job.platform,
            backendCursor: result.next,
            pending,
            coverage: result.coverage,
            seen: [...seen],
            pages: (stream?.pages || 0) + (result.normalized ? 0 : 1),
            expiresAt: r.now() + 3600000,
            epoch: this.epoch,
            continuationInterrupted,
          };
        }
        const savedItems = r.memory.transaction(() => {
          this.cursors.replace(
            ctx.agentId,
            args.cursor,
            nextCursor,
            continuation,
            r.now(),
          );
          return items.map((item) =>
            this.preview(
              this.record(ctx, item),
              Math.min(6000, Math.floor(12000 / job.limit)),
            ),
          );
        });
        return {
          platform: job.platform,
          operation,
          coverage: result.coverage,
          items: savedItems,
          nextCursor,
          duplicatesRemoved,
          untrustedContent: true,
          videoUnderstanding: false,
          completion: nextCursor
            ? "more"
            : continuationInterrupted
              ? "interrupted"
              : "end",
          ...(continuationInterrupted
            ? {
                notice:
                  "浏览器会话已重启；仅续读缓存内容，后端分页已中断，不能视为读完来源。",
              }
            : {}),
          ...(!items.length && !continuationInterrupted
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
        // eslint-disable-next-line preserve-caught-error -- only the sanitized APP_* code may leave; the upstream error text must not.
        throw Error(code);
      }
    });
  }
}
