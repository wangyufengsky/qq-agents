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
const publicDir = fileURLToPath(new URL("../public/", import.meta.url));
const fileRecoveryRequest = z
  .object({
    agentId: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/),
    fileId: z.string().regex(/^[a-f0-9]{64}$/),
    action: z.enum(["repair", "remove"]),
    name: z.string().min(1).max(200).optional(),
  })
  .strict()
  .refine((value) => value.action !== "repair" || !!value.name);
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
    const expectedHosts = new Set([
      `127.0.0.1:${server.address()?.port}`,
      `localhost:${server.address()?.port}`,
      `[::1]:${server.address()?.port}`,
    ]);
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
          "/files-ui.js",
          "/apps-ui.js",
          "/mind-ui.js",
          "/style.css",
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
          subject: {
            ...m.state("@subject"),
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
              ...JSON.parse(r.value),
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
      if (req.method === "GET" && url.pathname === "/api/status")
        return send({ ...runtime.status(), allowLive });
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
              ...JSON.parse(r.value),
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
      if (req.method === "GET" && url.pathname === "/api/slang") {
        const id = url.searchParams.get("agentId");
        runtime.agent(id);
        return send(
          runtime.memory.bind(id).state(url.searchParams.get("conversation"))
            .slang || { entries: [] },
        );
      }
      if (req.method === "POST" && url.pathname === "/api/slang") {
        const data = await readBody();
        return send(
          runtime.learner.review(
            data.agentId,
            data.conversation,
            data.id,
            data,
          ),
        );
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
      if (req.method === "POST" && url.pathname === "/api/pause") {
        const data = await readBody();
        if (typeof data.paused !== "boolean") throw Error("INVALID_PAUSE");
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
      if (req.method === "POST" && url.pathname === "/api/disclosure") {
        const data = await readBody();
        return send(runtime.grant(data));
      }
      if (req.method === "POST" && url.pathname === "/api/session/reset") {
        const data = await readBody();
        await runtime.resetSession(data.agentId, data.conversation);
        return send({ ok: true });
      }
      if (req.method === "POST" && url.pathname === "/api/conversation/state") {
        const data = await readBody();
        runtime.agent(data.agentId);
        if (
          !/^(group|private):\d+$/.test(data.conversation) ||
          typeof data.paused !== "boolean"
        )
          throw Error("INVALID_CONVERSATION_STATE");
        const mem = runtime.memory.bind(data.agentId),
          state = mem.state(data.conversation);
        if (data.paused) await runtime.cancel(data.agentId);
        mem.setState(data.conversation, {
          ...state,
          paused: data.paused,
          silenceUntil: 0,
        });
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
        return send(runtime.memory.bind(agentId).search(q));
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
        return send(
          runtime.memory
            .bind(agentId)
            [url.pathname.endsWith("/view") ? "view" : "read"]({
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
        { error: failure.code, requestId, retryable: failure.retryable },
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
    listen(port = 0) {
      return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, "127.0.0.1", () => resolve(server.address().port));
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
