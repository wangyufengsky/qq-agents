// @ts-check
import http from "node:http";
import { z } from "zod";
import { GameError, fail, parse, secret } from "./value.mjs";

const tokenSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const joinSchema = z.strictObject({ bindingId: z.uuid(), invite: tokenSchema });
/** @param {string} text */
export const escapeHtml = (text) =>
  text.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ] || c,
  );
/** @param {import('node:http').IncomingMessage} req */
async function body(req) {
  if (req.headers["content-type"]?.split(";")[0] !== "application/json")
    fail("JSON_REQUIRED", 415);
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 16384) fail("BODY_TOO_LARGE", 413);
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return fail("INVALID_JSON", 400);
  }
}
/** Loopback-only transport for the isolated P1a harness. No management routes or actor issuer.
 * @param {{kernel:import('./kernel.mjs').GameKernel,identity:import('./identity.mjs').GameIdentity,assets:Map<string,{type:string,body:string|Buffer}>,render:(snapshot:any|null,roomId:string)=>string,confirm?:(roomId:string,bindingId:string,challenge:string)=>void,publicOrigin?:string,publicJoin?:boolean,health?:()=>unknown,authorize?:(roomId:string)=>Promise<boolean>}} options */
export function createGameHttp({
  kernel,
  identity,
  assets,
  render,
  confirm,
  publicOrigin = "",
  publicJoin = false,
  health,
  authorize,
}) {
  if (publicOrigin) {
    const u = new URL(publicOrigin);
    if (u.protocol !== "https:" || u.origin !== publicOrigin)
      fail("INVALID_PUBLIC_ORIGIN", 400);
  }
  let origin = "",
    windowAt = 0,
    count = 0;
  /** @param {import('node:http').IncomingMessage} req @param {string} name */
  const cookie = (req, name) =>
    (req.headers.cookie || "")
      .split(";")
      .map((x) => x.trim())
      .find((x) => x.startsWith(name + "="))
      ?.slice(name.length + 1) || "";
  /** @param {import('node:http').IncomingMessage} req @param {import('node:http').ServerResponse} res */
  async function handle(req, res) {
    for (const [k, v] of Object.entries({
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
      "content-security-policy":
        "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    }))
      res.setHeader(k, v);
    /** @param {unknown} value @param {number} [status] */
    const json = (value, status = 200) => {
      res.writeHead(status, {
        "content-type": "application/json; charset=utf-8",
      });
      res.end(JSON.stringify(value));
    };
    try {
      const now = Date.now();
      if (now - windowAt >= 1000) {
        windowAt = now;
        count = 0;
      }
      if (++count > 120) fail("RATE_LIMITED", 429);
      if (
        req.headers.host !== new URL(origin).host ||
        req.headers.forwarded ||
        (!publicOrigin &&
          Object.keys(req.headers).some((k) => k.startsWith("x-forwarded-"))) ||
        (publicOrigin &&
          req.headers["x-forwarded-host"] !== undefined &&
          req.headers["x-forwarded-host"] !== new URL(origin).host)
      )
        fail("LOOPBACK_HOST_REQUIRED", 403);
      if (publicOrigin && req.headers["x-forwarded-proto"] !== "https")
        fail("HTTPS_REQUIRED", 403);
      if (publicOrigin)
        res.setHeader("strict-transport-security", "max-age=86400");
      if (!["GET", "POST"].includes(req.method || ""))
        fail("METHOD_NOT_ALLOWED", 405);
      if (
        req.method === "POST" &&
        (req.headers.origin !== origin ||
          req.headers["sec-fetch-site"] === "cross-site")
      )
        fail("CROSS_ORIGIN", 403);
      const url = new URL(req.url || "/", origin);
      const asset = assets.get(url.pathname);
      if (asset && req.method === "GET") {
        res.writeHead(200, { "content-type": asset.type });
        res.end(asset.body);
        return;
      }
      if (url.pathname === "/health" && req.method === "GET")
        return json(
          health
            ? health()
            : {
                service: "qq-agents-game-p1a-fixture",
                publicAccess: false,
              },
        );
      const match =
        /^\/rooms\/([a-f0-9-]{36})(?:\/(join|view|actions|events)(?:\/([a-f0-9-]{36}))?)?$/.exec(
          url.pathname,
        );
      if (!match) fail("NOT_FOUND", 404);
      const [, roomId, route, actionId] = match;
      if (authorize && !(await authorize(roomId))) fail("GAME_BLOCKED", 403);
      const sessionName = "game_" + roomId,
        browserName = "binding_" + roomId;
      /** @param {string} name @param {string} value @param {number} maxAge */
      const setCookie = (name, value, maxAge) =>
        res.setHeader(
          "set-cookie",
          `${name}=${value}; HttpOnly; SameSite=Strict; Path=/rooms/${roomId}; Max-Age=${maxAge}${publicOrigin ? "; Secure" : ""}`,
        );
      if (req.method === "GET" && !route) {
        let snapshot = null;
        if (cookie(req, sessionName)) {
          try {
            snapshot = kernel.view(
              roomId,
              identity.session(roomId, cookie(req, sessionName)),
            );
          } catch (error) {
            // Rotated/expired credentials must not block a fresh invitation's landing page.
            if (
              !(error instanceof GameError) ||
              error.message !== "AUTH_REQUIRED"
            )
              throw error;
            setCookie(sessionName, "", 0);
          }
        }
        if (snapshot && url.search) {
          res.writeHead(303, { location: `/rooms/${roomId}` });
          res.end();
          return;
        }
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(render(snapshot, roomId));
        return;
      }
      if (route === "join" && req.method === "POST") {
        const input = parse(
          z.union([
            joinSchema,
            z.strictObject({ bindingId: z.uuid() }),
            ...(publicJoin ? [z.strictObject({ start: z.literal(true) })] : []),
          ]),
          await body(req),
        );
        if (Object.hasOwn(input, "start")) {
          const browser = secret(),
            pending = identity.requestPublic(roomId, browser);
          setCookie(browserName, browser, 900);
          return json(pending);
        }
        if (Object.hasOwn(input, "invite")) {
          const request = parse(joinSchema, input),
            browser = /^[A-Za-z0-9_-]{43}$/.test(cookie(req, browserName))
              ? cookie(req, browserName)
              : secret();
          const pending = identity.request(
            roomId,
            request.bindingId,
            request.invite,
            browser,
          );
          // Only the explicit synthetic harness supplies this callback. A future QQ adapter confirms out of band.
          confirm?.(roomId, request.bindingId, pending.challenge);
          setCookie(browserName, browser, 900);
          return json({ bindingId: request.bindingId, ...pending });
        }
        const request = parse(z.strictObject({ bindingId: z.uuid() }), input);
        const joined = identity.exchange(
          roomId,
          request.bindingId,
          cookie(req, browserName),
        );
        setCookie(sessionName, joined.session, 86400);
        return json({ joined: true, location: `/rooms/${roomId}` });
      }
      const actor = identity.session(roomId, cookie(req, sessionName));
      if (req.method === "GET" && route === "view")
        return json(kernel.view(roomId, actor));
      if (req.method === "GET" && route === "events")
        return json(
          kernel.events(
            roomId,
            actor,
            Number(url.searchParams.get("after") || "0"),
          ),
        );
      if (req.method === "GET" && route === "actions" && actionId)
        return json(kernel.receipt(roomId, actor, actionId));
      if (req.method === "POST" && route === "actions" && !actionId)
        return json(kernel.act(roomId, actor, await body(req)));
      fail("NOT_FOUND", 404);
    } catch (error) {
      json(
        {
          error:
            error instanceof GameError ? error.message : "GAME_REQUEST_FAILED",
        },
        error instanceof GameError ? error.status : 500,
      );
    }
  }
  const server = http.createServer((req, res) => {
    void handle(req, res);
  });
  server.requestTimeout = 10_000;
  server.headersTimeout = 10_000;
  return {
    /** @param {number} [port] */
    listen(port = 0) {
      return new Promise(
        /** @param {(value:{origin:string,port:number})=>void} resolve */ (
          resolve,
          reject,
        ) => {
          server.once("error", reject);
          server.listen(port, "127.0.0.1", () => {
            const address = server.address();
            if (!address || typeof address === "string")
              return reject(Error("LISTEN_FAILED"));
            origin = publicOrigin || `http://127.0.0.1:${address.port}`;
            resolve({ origin, port: address.port });
          });
        },
      );
    },
    close() {
      server.closeAllConnections();
      return new Promise(
        /** @param {(value?:any)=>void} resolve */ (resolve) =>
          server.close(() => resolve()),
      );
    },
  };
}
