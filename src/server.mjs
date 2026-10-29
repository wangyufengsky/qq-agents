import { readConversationState } from "./memory/conversation-state.mjs";
import { scopedCatalog } from "./tools/catalog.mjs";
import { randomUUID } from "node:crypto";
import { saveGithubCredential } from "./github/credentials.mjs";
import { shareList, cancelShare } from "./apps/sharing.mjs";
import { appService } from "./apps/tools.mjs";
import { safeToolFailure } from "./tools/errors.mjs";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { withExport, streamExport } from "./memory/export.mjs";
import { fileURLToPath } from "node:url";
import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { mcpResult, TOOL_NAMES } from "./tools/index.mjs";
import { readiness } from "./core/readiness.mjs";
import { activityPage, homeSummary } from "./core/activity.mjs";
const publicDir = fileURLToPath(new URL("../public/", import.meta.url));
// The running release, shown in the console's sidebar.
const packageVersion = JSON.parse(
  fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"),
).version;
// Free-time log and 24-hour activity for the console; no message bodies.
function subjectActivity(m, agentId, now) {
  const logs = m.db
    .prepare(
      "SELECT id,observed_at AS at,payload FROM events WHERE agent_id=? AND conversation='@subject' AND kind='subject.log' ORDER BY seq DESC LIMIT 20",
    )
    .all(agentId)
    .map((row) => {
      const p = JSON.parse(row.payload);
      return {
        id: row.id,
        at: row.at,
        did: p.did,
        summary: p.summary,
        found: (p.found || []).map((f) => f.title),
        next: p.next || "",
        restReason: p.restReason || null,
        protected: !!(p.protectedRepositories?.length || p.protectedOperations),
        turnId: p.turnId || null,
      };
    });
  // Each log's own turn, however many came after it: the tools it used
  // (null when the turn predates tool tracing). A turn still running has
  // not recorded them yet and adds nothing.
  const turnIds = [...new Set(logs.map((l) => l.turnId).filter(Boolean))];
  const ofLog = new Map(
    turnIds.length
      ? m.db
          .prepare(
            `SELECT id,value FROM model_turns WHERE agent_id=? AND id IN (${turnIds.map(() => "?").join(",")})`,
          )
          .all(agentId, ...turnIds)
          .map((row) => [row.id, JSON.parse(row.value)])
      : [],
  );
  for (const log of logs) {
    const turn = ofLog.get(log.turnId);
    if (turn && turn.status !== "running")
      log.toolCalls = Array.isArray(turn.toolCalls) ? turn.toolCalls : null;
  }
  const turns = m.db
    .prepare(
      "SELECT value FROM model_turns WHERE agent_id=? AND json_extract(value,'$.conversation')='@subject' AND json_extract(value,'$.startedAt')>?",
    )
    .all(agentId, now - 86400000)
    .map((row) => JSON.parse(row.value))
    .filter((t) => t.status !== "running");
  const work = (t) =>
    (t.toolCalls || []).filter((c) => c.name !== "subject_log").length;
  return {
    logs,
    stats24h: {
      turns: turns.length,
      active: turns.filter((t) => work(t) > 0).length,
      logged: turns.filter((t) =>
        (t.toolCalls || []).some((c) => c.name === "subject_log" && c.ok),
      ).length,
      toolCalls: turns.reduce((n, t) => n + work(t), 0),
      traced: turns.filter((t) => Array.isArray(t.toolCalls)).length,
    },
  };
}
const fileRecoveryRequest = z
  .object({
    agentId: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/),
    fileId: z.string().regex(/^[a-f0-9]{64}$/),
    action: z.enum(["repair", "remove"]),
    name: z.string().min(1).max(200).optional(),
  })
  .strict()
  .refine((value) => value.action !== "repair" || !!value.name);
const deliveryReconciliation = z
  .object({
    agentId: z.string(),
    requestId: z.string().min(1).max(200),
    resolution: z.enum(["sent", "failed"]),
  })
  .strict();
const equal = (a, b) =>
  typeof a === "string" &&
  Buffer.byteLength(a) === Buffer.byteLength(b) &&
  timingSafeEqual(Buffer.from(a), Buffer.from(b));
async function body(req, maxBytes = 1024 * 1024, form = false) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > maxBytes) throw Error("BODY_TOO_LARGE");
    chunks.push(chunk);
  }
  try {
    const text = Buffer.concat(chunks).toString("utf8");
    return form
      ? Object.fromEntries(new URLSearchParams(text))
      : JSON.parse(text || "{}");
  } catch (cause) {
    throw Error("INVALID_JSON_BODY", { cause });
  }
}
export function createServer({
  runtime,
  token,
  allowLive = false,
  githubSecretFile,
  exportOptions,
  publicPort,
}) {
  let stopping = false,
    closing;
  const requests = new Set();
  const exportTickets = new Map();
  const expireTickets = () => {
    for (const [ticket, value] of exportTickets)
      if (value.expiresAt <= runtime.now()) exportTickets.delete(ticket);
  };
  const handle = async (req, res) => {
    const requestId = randomUUID(),
      startedAt = Date.now();
    const send = (data, status = 200) => {
      if (res.destroyed || res.writableEnded) return;
      if (res.headersSent) {
        res.destroy();
        return;
      }
      if (status >= 400)
        data = { ...data, requestId, retryable: data.retryable ?? false };
      res.writeHead(status, {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
        "x-request-id": requestId,
      });
      res.end(JSON.stringify(data));
    };
    // The console is only served under a loopback name, even when the socket
    // listens on 0.0.0.0 inside a container: a host port mapping such as
    // 127.0.0.1:8080:3210 is admitted through publicPort, and any other name
    // (a LAN address, a rebinding domain) is refused before authentication.
    const expectedHosts = new Set(
      [server.address()?.port, publicPort]
        .filter((port) => port !== undefined)
        .flatMap((port) => [
          `127.0.0.1:${port}`,
          `localhost:${port}`,
          `[::1]:${port}`,
        ]),
    );
    if (!expectedHosts.has(req.headers.host))
      return send({ error: "INVALID_HOST" }, 403);
    if (
      req.headers.origin &&
      req.headers.origin !== `http://${req.headers.host}`
    )
      return send({ error: "CROSS_ORIGIN" }, 403);
    if (req.headers["sec-fetch-site"] === "cross-site")
      return send({ error: "CROSS_SITE" }, 403);
    const readBody = async (limit) => {
      const data = await body(req, limit);
      if (stopping || runtime.closed) throw Error("RUNTIME_CLOSING");
      return data;
    };
    try {
      if (stopping || runtime.closed) throw Error("RUNTIME_CLOSING");
      const url = new URL(req.url, "http://" + req.headers.host);
      if (
        req.method === "GET" &&
        [
          "/",
          "/app.js",
          "/parity.js",
          "/agent-form.js",
          "/files-ui.js",
          "/apps-ui.js",
          "/mind-ui.js",
          "/mood-ui.js",
          "/people-ui.js",
          "/onboarding-ui.js",
          "/activity-ui.js",
          "/style.css",
          "/agent-form.css",
        ].includes(url.pathname)
      ) {
        const file =
          url.pathname === "/" ? "index.html" : url.pathname.slice(1);
        res.writeHead(200, {
          "content-type": file.endsWith(".html")
            ? "text/html; charset=utf-8"
            : file.endsWith(".js")
              ? "text/javascript; charset=utf-8"
              : "text/css; charset=utf-8",
          "cache-control": "no-store",
          "referrer-policy": "no-referrer",
          "x-content-type-options": "nosniff",
          "content-security-policy":
            "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; media-src 'self' blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
        });
        res.end(fs.readFileSync(path.join(publicDir, file)));
        return;
      }
      if (url.pathname === "/agent/catalog") {
        const ctx = runtime.capability(req.headers["x-agent-capability"]);
        if (req.method !== "POST") return send({ error: "METHOD" }, 405);
        try {
          return send(mcpResult(scopedCatalog(runtime, ctx, await readBody())));
        } catch (e) {
          runtime.diagnostics.report(e, {
            component: "http",
            requestId,
            agentId: ctx.agentId,
            conversation: ctx.conversation,
            durationMs: Date.now() - startedAt,
          });
          return send({
            isError: true,
            content: [
              { type: "text", text: JSON.stringify(safeToolFailure(e)) },
            ],
          });
        }
      }
      if (url.pathname === "/agent/tools") {
        const ctx = runtime.capability(req.headers["x-agent-capability"]);
        if (req.method !== "POST") return send({ error: "METHOD" }, 405);
        const data = await readBody();
        try {
          return send(
            mcpResult(await runtime.callTool(ctx, data.name, data.arguments)),
          );
        } catch (e) {
          runtime.diagnostics.report(e, {
            component: "http",
            requestId,
            agentId: ctx.agentId,
            conversation: ctx.conversation,
            durationMs: Date.now() - startedAt,
          });
          return send({
            isError: true,
            content: [
              { type: "text", text: JSON.stringify(safeToolFailure(e)) },
            ],
          });
        }
      }
      let downloadAgentId;
      if (req.method === "POST" && url.pathname === "/api/export/download") {
        expireTickets();
        const data = await body(req, 512, true);
        const grant = exportTickets.get(data.ticket);
        if (
          !grant ||
          grant.expiresAt <= runtime.now() ||
          Object.keys(data).length !== 1
        )
          return send({ error: "UNAUTHORIZED" }, 401);
        exportTickets.delete(data.ticket);
        downloadAgentId = grant.agentId;
        if (stopping || runtime.closed) throw Error("RUNTIME_CLOSING");
      }
      if (!downloadAgentId && !equal(req.headers["x-admin-token"], token))
        return send({ error: "UNAUTHORIZED" }, 401);
      if (req.method === "POST" && url.pathname === "/api/export/ticket") {
        const data = await readBody(512);
        const agent = runtime.agent(data.agentId);
        expireTickets();
        if (exportTickets.size >= 8) throw Error("EXPORT_TICKET_BUDGET");
        const ticket = randomUUID();
        exportTickets.set(ticket, {
          agentId: agent.id,
          expiresAt: runtime.now() + 60000,
        });
        return send({ ticket });
      }
      if (req.method === "POST" && url.pathname === "/api/github/credential") {
        const data = await readBody(4096);
        const agent = runtime.agent(data.agentId);
        if (agent.github.auth !== "token")
          throw Error("GITHUB_TOKEN_AUTH_REQUIRED");
        return send(
          saveGithubCredential(
            githubSecretFile,
            agent.github.tokenEnv,
            data.token,
          ),
        );
      }
      if (req.method === "GET" && url.pathname === "/api/mind") {
        const a = runtime.agent(url.searchParams.get("agentId")),
          m = runtime.memory.bind(a.id);
        // A mood is about the people whose messages it cites; the card and the
        // timeline show each other by reference, nothing is copied.
        const moods = m.identity.moodHistory(500),
          about = m.identity.moodPeople(
            moods,
            runtime.config.connections.find((c) => c.id === a.connectionId)
              ?.accountId,
          ),
          cards = m.identity.personCards(),
          cardOf = new Map(cards.map((c) => [c.personId, c])),
          namesOf = (qq) =>
            JSON.parse(
              m.db
                .prepare("SELECT names FROM people WHERE agent_id=? AND qq=?")
                .get(a.id, qq)?.names || "[]",
            );
        const shownMoods = moods.slice(0, 50),
          diariesIn = m.diariesInMoods(shownMoods.map((x) => x.id));
        return send({
          current: m.identity.withEvidence(
            m.identity.initialize(a, runtime.now()),
          ),
          anchors: m.identity.anchors(a),
          history: m.identity.history().map((v) => m.identity.withEvidence(v)),
          candidates: m.identity
            .list("self_candidates")
            .map((c) => m.identity.withEvidence(c)),
          intents: m.identity.list("intentions"),
          // Read-only: only the agent writes or clears its own mood.
          mood: {
            current: m.identity.currentMood(runtime.now()),
            history: shownMoods.map((x) => ({
              ...x,
              people: about.get(x.id).map((personId) => ({
                personId,
                call: cardOf.get(personId)?.call || "",
                name: namesOf(personId).at(-1) || "",
                card: cardOf.has(personId),
              })),
              diaries: diariesIn.get(x.id) || [],
            })),
          },
          personCards: cards.map((card) => ({
            ...card,
            names: namesOf(card.personId),
            moods: moods
              .filter((x) => about.get(x.id).includes(card.personId))
              .slice(0, 5)
              .map(({ id, action, mood, intensity, reason, writtenAt }) => ({
                id,
                action,
                mood,
                intensity,
                reason,
                writtenAt,
              })),
            diaries: m
              .diariesAbout(card.personId, 3)
              .map(({ id, title, updatedAt }) => ({ id, title, updatedAt })),
          })),
          subject: {
            ...m.state("@subject"),
            ...subjectActivity(m, a.id, runtime.now()),
            pendingActivities: runtime.subject.pendingActivities(a.id),
            checkStatus: runtime.subject.checkStatus(a),
            turns: m.db
              .prepare(
                "SELECT value FROM model_turns WHERE agent_id=? AND json_extract(value,'$.conversation')='@subject' ORDER BY json_extract(value,'$.startedAt') DESC, id DESC LIMIT 10",
              )
              .all(a.id)
              .map((row) => JSON.parse(row.value)),
          },
          turns: m.identity.list("model_turns").slice(0, 50),
          sessions: m.db
            .prepare(
              "SELECT conversation,value FROM runtime WHERE agent_id=? AND (conversation='@subject' OR conversation LIKE 'group:%' OR conversation LIKE 'private:%')",
            )
            .all(a.id)
            .map((r) => ({
              conversation: r.conversation,
              ...readConversationState(JSON.parse(r.value)),
            })),
          retired: m.identity.list("session_history").slice(0, 30),
        });
      }
      if (req.method === "POST" && url.pathname === "/api/self") {
        const data = await readBody(),
          a = runtime.agent(data.agentId),
          m = runtime.memory.bind(a.id);
        if (
          !Number.isSafeInteger(data.expectedVersion) ||
          typeof data.reason !== "string"
        )
          throw Error("INVALID_SELF_EDIT");
        if (data.action === "restore")
          return send(
            m.identity.restore(
              data.version,
              data.expectedVersion,
              data.reason,
              runtime.now(),
            ),
          );
        if (
          data.action !== "edit" ||
          typeof data.body !== "string" ||
          data.body.length > a.selfPolicy.maxBodyChars
        )
          throw Error("INVALID_SELF_EDIT");
        return send(
          m.identity.adminEdit(
            {
              body: data.body,
              reason: data.reason,
              expectedVersion: data.expectedVersion,
            },
            runtime.now(),
          ),
        );
      }
      // Read when a card's panel opens, not with every /api/mind: what was
      // sent under each of its versions and where the person spoke lately.
      if (req.method === "GET" && url.pathname === "/api/person-card/links") {
        const a = runtime.agent(url.searchParams.get("agentId")),
          m = runtime.memory.bind(a.id),
          personId = url.searchParams.get("personId") || "";
        if (!/^\d{5,12}$/.test(personId)) throw Error("INVALID_PERSON");
        const card = m.identity.personCard(personId);
        return send({
          sent: card ? m.sentUnderCard(card.id) : [],
          chats: m.recentChatsWith(personId),
        });
      }
      if (req.method === "POST" && url.pathname === "/api/person-card") {
        const data = await readBody(),
          a = runtime.agent(data.agentId),
          m = runtime.memory.bind(a.id);
        if (!Number.isSafeInteger(data.expectedRevision))
          throw Error("INVALID_PERSON_NOTE");
        if (data.action === "delete")
          return send(
            m.identity.deletePersonCard(
              String(data.personId),
              data.expectedRevision,
            ),
          );
        if (data.action !== "edit") throw Error("INVALID_PERSON_NOTE");
        // An administrator edit is a new revision; the agent sees it the next
        // time this person speaks in each conversation.
        return send(
          m.identity.savePersonCard(
            {
              personId: data.personId,
              call: data.call ?? "",
              body: data.body,
              expectedRevision: data.expectedRevision,
            },
            { writtenIn: "console", author: "admin", now: runtime.now() },
          ),
        );
      }
      if (req.method === "POST" && url.pathname === "/api/intent/cancel") {
        const data = await readBody(),
          a = runtime.agent(data.agentId),
          m = runtime.memory.bind(a.id),
          i = m.identity.get("intentions", data.id);
        if (i.revision !== data.expectedRevision)
          throw Error("REVISION_CONFLICT");
        if (
          ["completed", "cancelled", "expired", "failed", "unknown"].includes(
            i.status,
          )
        )
          throw Error("INTENT_CLOSED");
        return send(
          runtime.subject.transition(
            a.id,
            i,
            "cancelled",
            "administrator cancellation",
          ),
        );
      }
      if (req.method === "GET" && url.pathname === "/api/home")
        return send({
          agents: runtime.config.agents.map((a) =>
            homeSummary(runtime.memory, a.id, { now: runtime.now() }),
          ),
        });
      if (req.method === "GET" && url.pathname === "/api/activity") {
        const a = runtime.agent(url.searchParams.get("agentId"));
        const filter = url.searchParams.get("filter") || "all";
        if (!["all", "subject", "chat", "browse"].includes(filter))
          throw Error("INVALID_ACTIVITY_FILTER");
        const before = Number(url.searchParams.get("before"));
        return send(
          activityPage(runtime.memory, a.id, {
            filter,
            before:
              Number.isSafeInteger(before) && before > 0 ? before : undefined,
            limit: 20,
            now: runtime.now(),
          }),
        );
      }
      if (req.method === "GET" && url.pathname === "/api/deliveries") {
        const a = runtime.agent(url.searchParams.get("agentId"));
        return send(
          runtime.memory.bind(a.id).unresolvedDeliveries({
            offset: Math.max(
              0,
              Math.min(100000, Number(url.searchParams.get("offset")) || 0),
            ),
            limit: 20,
          }),
        );
      }
      if (
        req.method === "POST" &&
        url.pathname === "/api/deliveries/reconcile"
      ) {
        const data = deliveryReconciliation.parse(await readBody(1024)),
          a = runtime.agent(data.agentId);
        return send(
          runtime.memory
            .bind(a.id)
            .reconcileDelivery(data.requestId, data.resolution),
        );
      }
      if (req.method === "GET" && url.pathname === "/api/status") {
        const status = runtime.status();
        return send({
          ...status,
          version: packageVersion,
          allowLive,
          readiness: readiness(runtime.config, status, { allowLive }),
        });
      }
      if (req.method === "PUT" && url.pathname === "/api/permissions/apps") {
        const data = await readBody();
        return send(
          await runtime.changeAppPermissions(
            data.agentId,
            data.apps,
            data.revision,
          ),
        );
      }
      if (req.method === "GET" && url.pathname === "/api/apps") {
        const agentId = url.searchParams.get("agentId");
        runtime.agent(agentId);
        return send({
          intents: shareList(appService(runtime), agentId),
          progress: appService(runtime).progress(agentId),
          readsLastDay: appService(runtime).readsLastDay(agentId),
          capabilities: appService(runtime).capabilities(agentId),
          history: appService(runtime).history(
            agentId,
            Math.max(
              0,
              Math.min(100000, Number(url.searchParams.get("offset")) || 0),
            ),
          ),
        });
      }
      if (req.method === "POST" && url.pathname === "/api/apps/cancel") {
        const data = await readBody();
        runtime.agent(data.agentId);
        return send(
          await cancelShare(
            appService(runtime),
            data.agentId,
            data.id,
            data.revision,
          ),
        );
      }
      if (req.method === "POST" && url.pathname === "/api/apps/probe") {
        const data = await readBody();
        runtime.agent(data.agentId);
        return send(await appService(runtime).probe(data.platform));
      }
      if (req.method === "PUT" && url.pathname === "/api/permissions/files") {
        const data = await readBody();
        return send(
          await runtime.changeFilePermissions(
            data.agentId,
            data.files,
            data.revision,
          ),
        );
      }
      if (req.method === "GET" && url.pathname === "/api/files") {
        const a = runtime.agent(url.searchParams.get("agentId"));
        return send(
          runtime.files.list(a.id, {
            offset: Math.max(0, Number(url.searchParams.get("offset")) || 0),
            limit: 30,
            query: (url.searchParams.get("query") || "").slice(0, 100),
          }),
        );
      }
      if (req.method === "POST" && url.pathname === "/api/files/recovery") {
        const data = fileRecoveryRequest.parse(await readBody()),
          a = runtime.agent(data.agentId);
        return send(
          await runtime.files.acquire(a.id, () =>
            data.action === "repair"
              ? runtime.files.repair(a.id, data.fileId, data.name, a.files)
              : runtime.files.removeDamaged(a.id, data.fileId),
          ),
        );
      }
      if (req.method === "POST" && url.pathname === "/api/files/import") {
        const data = await readBody(70 * 1024 * 1024),
          a = runtime.agent(data.agentId);
        if (
          typeof data.base64 !== "string" ||
          data.base64.length > Math.ceil(a.files.maxBytes / 3) * 4 ||
          data.base64.length % 4 ||
          /[^A-Za-z0-9+/=]/.test(data.base64) ||
          (data.base64.includes("=") && !/^[^=]*={1,2}$/.test(data.base64))
        )
          throw Error("INVALID_FILE_BYTES");
        return send(
          await runtime.files.acquire(a.id, () =>
            runtime.files.put(
              a.id,
              Buffer.from(data.base64, "base64"),
              data.name,
              a.files,
              { kind: "administrator-upload" },
            ),
          ),
        );
      }
      if (req.method === "GET" && url.pathname === "/api/files/download") {
        const a = runtime.agent(url.searchParams.get("agentId"));
        const { meta, buffer } = runtime.files.read(
          a.id,
          url.searchParams.get("fileId"),
          50 * 1024 * 1024,
        );
        res.writeHead(200, {
          "content-type": "application/octet-stream",
          "cache-control": "no-store",
          "x-content-type-options": "nosniff",
          "content-disposition":
            "attachment; filename*=UTF-8''" + encodeURIComponent(meta.name),
        });
        res.end(buffer);
        return;
      }
      if (req.method === "GET" && url.pathname === "/api/schedules") {
        const id = url.searchParams.get("agentId");
        runtime.agent(id);
        return send({
          ...runtime.scheduler.state(id),
          tasks: runtime.scheduler.list(id),
        });
      }
      if (req.method === "POST" && url.pathname === "/api/schedules") {
        const data = await readBody(),
          id = data.agentId;
        runtime.agent(id);
        if (data.action === "preview")
          return send({ next: runtime.scheduler.preview(id, data.task) });
        if (data.action === "create")
          return send(runtime.scheduler.create(id, data.task));
        if (data.action === "update")
          return send(runtime.scheduler.update(id, data.id, data.task));
        if (data.action === "delete")
          return send(runtime.scheduler.remove(id, data.id));
        if (data.action === "run") {
          if (!allowLive) throw Error("ISOLATED_MODE");
          return send(runtime.scheduler.runNow(id, data.id, data.requestId));
        }
        throw Error("INVALID_ACTION");
      }
      // Groups and people this role has met, for the console's pickers.
      if (req.method === "GET" && url.pathname === "/api/known-targets") {
        const a = runtime.agent(url.searchParams.get("agentId"));
        return send(runtime.memory.bind(a.id).knownTargets());
      }
      if (req.method === "GET" && url.pathname === "/api/conversations") {
        const id = url.searchParams.get("agentId");
        runtime.agent(id);
        const mem = runtime.memory.bind(id);
        return send(
          mem.db
            .prepare(
              "SELECT conversation,value FROM runtime WHERE agent_id=? AND (conversation LIKE 'group:%' OR conversation LIKE 'private:%') ORDER BY conversation",
            )
            .all(id)
            .map((r) => ({
              conversation: r.conversation,
              ...readConversationState(JSON.parse(r.value)),
            })),
        );
      }
      if (req.method === "GET" && url.pathname === "/api/voices") {
        const id = url.searchParams.get("agentId");
        runtime.agent(id);
        return send(
          runtime.voices.list(id, {
            query: url.searchParams.get("query") || "",
            offset: Math.max(0, Number(url.searchParams.get("offset")) || 0),
            limit: 30,
          }),
        );
      }
      if (req.method === "POST" && url.pathname === "/api/voices/import") {
        const data = await readBody(29 * 1024 * 1024),
          a = runtime.agent(data.agentId);
        if (
          typeof data.base64 !== "string" ||
          !/^[A-Za-z0-9+/]*={0,2}$/.test(data.base64)
        )
          throw Error("INVALID_AUDIO");
        return send(
          await runtime.voices.put(
            a.id,
            Buffer.from(data.base64, "base64"),
            a.voice,
            { title: String(data.title || "导入语音") },
          ),
        );
      }
      if (req.method === "GET" && url.pathname === "/api/voices/play") {
        const id = url.searchParams.get("agentId");
        runtime.agent(id);
        const audio = runtime.voices.read(id, url.searchParams.get("id"));
        res.writeHead(200, {
          "content-type": audio.mimeType,
          "cache-control": "no-store",
          "x-content-type-options": "nosniff",
        });
        res.end(Buffer.from(audio.data, "base64"));
        return;
      }
      if (req.method === "GET" && url.pathname === "/api/operations")
        return send(runtime.operations.snapshot());
      if (req.method === "POST" && url.pathname === "/api/operations") {
        const data = await readBody();
        if (data.action === "revoke") {
          runtime.operations.revoke(data.agentId);
          return send({ level: "L0" });
        }
        if (data.action === "confirm") {
          if (!allowLive) throw Error("ISOLATED_MODE");
          return send(
            await runtime.operations.confirm(
              data.agentId,
              data.conversation,
              data.id,
              data.code,
              data.otp,
            ),
          );
        }
        throw Error("INVALID_ACTION");
      }
      if (req.method === "GET" && url.pathname === "/api/config")
        return send({
          config: runtime.config,
          revision: runtime.configStore.revision,
          migrationWarnings: runtime.configStore.migrationWarnings || [],
          tools: TOOL_NAMES,
        });
      if (req.method === "PUT" && url.pathname === "/api/config") {
        const data = await readBody();
        if (data.config?.mode === "live" && !allowLive)
          throw Error("RESTART_WITH_LIVE_FLAG_REQUIRED");
        const result = await runtime.changeConfig(data.config, data.revision);
        return send({
          ...result,
          ok: true,
          revision: runtime.configStore.revision,
        });
      }
      if (req.method === "POST" && url.pathname === "/api/mode") {
        const data = await readBody(512);
        if (!["isolated", "live"].includes(data.mode))
          throw Error("INVALID_MODE");
        if (data.mode === "live" && !allowLive)
          throw Error("RESTART_WITH_LIVE_FLAG_REQUIRED");
        if (data.mode === "isolated") runtime.autoResume.cancel();
        await runtime.setMode(data.mode, data.revision);
        return send({
          ok: true,
          mode: runtime.config.mode,
          revision: runtime.configStore.revision,
        });
      }
      if (req.method === "POST" && url.pathname === "/api/pause") {
        const data = await readBody();
        if (typeof data.paused !== "boolean") throw Error("INVALID_PAUSE");
        // A global pause or resume from the console ends automatic resume.
        if ((data.agentId || "all") === "all") runtime.autoResume.cancel();
        return send(await runtime.pause(data.agentId || "all", data.paused));
      }
      if (req.method === "POST" && url.pathname === "/api/connection") {
        const data = await readBody();
        if (!["connect", "disconnect"].includes(data.action))
          throw Error("INVALID_ACTION");
        if (data.action === "connect") {
          if (!allowLive) throw Error("ISOLATED_MODE");
          return send(await runtime.startConnection(data.id));
        }
        await runtime.stopConnection(data.id);
        return send({ ok: true });
      }
      if (req.method === "POST" && url.pathname === "/api/process") {
        if (!allowLive || runtime.config.mode !== "live")
          throw Error("ISOLATED_MODE");
        const data = await readBody();
        if (!runtime.lifecycle) throw Error("LIFECYCLE_UNAVAILABLE");
        const c = runtime.connection(data.id);
        if (data.action === "start") {
          if (!c.enabled) throw Error("CONNECTION_DISABLED");
          await runtime.lifecycle.start(c);
        } else if (data.action === "stop") {
          await runtime.stopConnection(c.id);
          await runtime.lifecycle.stop(c.id);
        } else throw Error("INVALID_ACTION");
        return send({ ok: true });
      }
      if (req.method === "POST" && url.pathname === "/api/models") {
        if (!allowLive || runtime.config.mode !== "live")
          throw Error("ISOLATED_MODE");
        const data = await readBody(),
          a = runtime.agent(data.agentId),
          b = runtime.config.backends.find((b) => b.id === a.backendId);
        const existing = runtime.backends.get(a.id),
          backend = existing || runtime.backendFactory(b, a);
        try {
          return send({ models: await backend.models() });
        } finally {
          if (!existing) await backend.close();
        }
      }
      if (req.method === "POST" && url.pathname === "/api/backend") {
        if (!allowLive || runtime.config.mode !== "live")
          throw Error("ISOLATED_MODE");
        return send(await runtime.backendConnections.handle(await readBody()));
      }
      if (url.pathname === "/api/protected-work") {
        if (req.method === "GET")
          return send({
            tasks: runtime.protectedWork.list(url.searchParams.get("agentId")),
          });
        if (req.method === "POST") {
          const data = await readBody();
          if (data.action === "run" && !allowLive) throw Error("ISOLATED_MODE");
          return send(
            data.action
              ? await runtime.protectedWork.act(data)
              : runtime.protectedWork.create(data),
          );
        }
      }
      if (req.method === "POST" && url.pathname === "/api/disclosure") {
        const data = await readBody();
        return send(runtime.grant(data));
      }
      if (req.method === "POST" && url.pathname === "/api/session/reset") {
        const data = await readBody();
        await runtime.resetSession(data.agentId, data.conversation);
        return send({ ok: true });
      }
      if (req.method === "POST" && url.pathname === "/api/session/recover") {
        const data = await readBody();
        return send(
          await runtime.recoverProtectedConversation(
            data.agentId,
            data.conversation,
          ),
        );
      }
      if (req.method === "POST" && url.pathname === "/api/conversation/state") {
        const data = await readBody();
        runtime.agent(data.agentId);
        if (
          !/^(group|private):\d+$/.test(data.conversation) ||
          typeof data.paused !== "boolean"
        )
          throw Error("INVALID_CONVERSATION_STATE");
        const mem = runtime.memory.bind(data.agentId);
        // Persist first: the stopping turn then cannot send, and state written
        // while it finishes is not overwritten by a stale copy.
        mem.setState(data.conversation, {
          ...mem.state(data.conversation),
          paused: data.paused,
          silenceUntil: 0,
        });
        if (data.paused)
          await runtime.cancelConversation(data.agentId, data.conversation);
        return send({ ok: true, paused: data.paused });
      }
      if (req.method === "GET" && url.pathname === "/api/memory") {
        const agentId = url.searchParams.get("agentId");
        runtime.agent(agentId);
        const q = Object.fromEntries(url.searchParams);
        delete q.agentId;
        if (q.cursor) q.cursor = JSON.parse(q.cursor);
        for (const key of [
          "limit",
          "offset",
          "diaryOffset",
          "maxChars",
          "contextBefore",
          "contextAfter",
          "contextSeconds",
        ])
          if (q[key] !== undefined) q[key] = Number(q[key]);
        const m = runtime.memory.bind(agentId),
          result = m.search(q);
        // The call each speaker's person card gives, for the speakers on this
        // page that have one; the console names them by it and opens the card.
        const speakers = [
          ...new Set(
            result.items.flatMap((r) => [
              r.senderId,
              ...[...(r.scene?.messages || []), ...(r.scene?.quoted || [])].map(
                (x) => x.senderId,
              ),
            ]),
          ),
        ].filter(Boolean);
        const people = speakers.length
          ? Object.fromEntries(
              m.db
                .prepare(
                  "SELECT person_id AS id, json_extract(value,'$.call') AS call FROM person_notes WHERE agent_id=? AND person_id IN (SELECT value FROM json_each(?))",
                )
                .all(agentId, JSON.stringify(speakers))
                .map((r) => [r.id, { call: r.call || "" }]),
            )
          : {};
        return send({ ...result, people });
      }
      if (req.method === "GET" && url.pathname === "/api/memory/conversation") {
        const agentId = url.searchParams.get("agentId");
        runtime.agent(agentId);
        const q = {};
        for (const key of ["conversation", "connectionId", "aroundId"])
          if (url.searchParams.has(key)) q[key] = url.searchParams.get(key);
        if (url.searchParams.has("aroundCursor"))
          q.aroundCursor = JSON.parse(url.searchParams.get("aroundCursor"));
        for (const key of [
          "beforeSeq",
          "afterSeq",
          "limit",
          "maxChars",
          "contextSeconds",
        ])
          if (url.searchParams.has(key))
            q[key] = Number(url.searchParams.get(key));
        return send(runtime.memory.bind(agentId).conversation(q));
      }
      if (req.method === "GET" && url.pathname === "/api/memory/related") {
        const agentId = url.searchParams.get("agentId");
        runtime.agent(agentId);
        return send(
          runtime.memory.bind(agentId).related({
            id: url.searchParams.get("id"),
            afterSeq: Number(url.searchParams.get("afterSeq") || 0),
          }),
        );
      }
      if (
        req.method === "GET" &&
        ["/api/memory/read", "/api/memory/view"].includes(url.pathname)
      ) {
        const agentId = url.searchParams.get("agentId");
        runtime.agent(agentId);
        const memory = runtime.memory.bind(agentId),
          method = url.pathname.endsWith("/view") ? "view" : "read";
        return send(
          memory[method]({
            id: url.searchParams.get("id"),
            offset: Number(url.searchParams.get("offset") || 0),
            ...(url.searchParams.has("revision")
              ? { revision: Number(url.searchParams.get("revision")) }
              : {}),
          }),
        );
      }
      if (
        downloadAgentId ||
        (req.method === "GET" && url.pathname === "/api/export")
      ) {
        const agentId = downloadAgentId || url.searchParams.get("agentId");
        runtime.agent(agentId);
        const controller = new AbortController();
        const disconnect = () => {
          if (!res.writableFinished) controller.abort();
        };
        res.once("close", disconnect);
        try {
          await withExport(
            runtime.memory,
            agentId,
            async ({ path: file, bytes, signal }) => {
              res.writeHead(200, {
                "content-type": "application/json; charset=utf-8",
                "content-disposition": `attachment; filename="${agentId}-export.json"`,
                "content-length": bytes,
                "cache-control": "no-store",
                "x-content-type-options": "nosniff",
              });
              await streamExport(file, res, signal);
            },
            { ...exportOptions, signal: controller.signal },
          );
        } finally {
          res.off("close", disconnect);
        }
        return;
      }
      send({ error: "NOT_FOUND" }, 404);
    } catch (e) {
      const failure = runtime.diagnostics.report(e, {
        component: "http",
        requestId,
        durationMs: Date.now() - startedAt,
      });
      send(
        {
          error: failure.code,
          requestId,
          retryable: failure.retryable,
          ...(failure.fields ? { fields: failure.fields } : {}),
        },
        failure.status,
      );
    }
  };
  const server = http.createServer((req, res) => {
    const job = handle(req, res).catch((error) => {
      runtime.diagnostics.report(error, { component: "http" });
      res.destroy();
    });
    requests.add(job);
    runtime.trackWork(job);
    job.then(() => requests.delete(job));
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  return {
    server,
    listen(port = 0, host = "127.0.0.1") {
      return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, () => resolve(server.address().port));
      });
    },
    close() {
      if (closing) return closing;
      stopping = true;
      exportTickets.clear();
      const stopped = new Promise((resolve) => server.close(resolve));
      server.closeAllConnections();
      closing = (async () => {
        await stopped;
        while (requests.size) await Promise.allSettled([...requests]);
      })();
      return closing;
    },
  };
}
