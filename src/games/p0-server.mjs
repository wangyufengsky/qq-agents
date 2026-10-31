// @ts-check
import http from "node:http";
import { randomBytes, randomUUID, createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { z } from "zod";

const secret = () => randomBytes(32).toString("base64url");
/** @param {string} value */
const hash = (value) => createHash("sha256").update(value).digest("hex");
const actionSchema = z
  .object({
    actionId: z.uuid(),
    expectedRevision: z.number().int().min(0).max(225),
    x: z.number().int().min(0).max(14),
    y: z.number().int().min(0).max(14),
  })
  .strict();
/** @typedef {z.infer<typeof actionSchema>} Move */
/** @typedef {{actionId:string, revision:number, x:number, y:number, stone:number}} Receipt */
/** @typedef {{id:string, expiresAt:number, inviteExpiresAt:number, inviteHash:string, sessionHash:string|null, revision:number, board:number[], actions:{request:Move,result:Receipt}[]}} Room */
/** @param {string} code @param {number} status */
const failure = (code, status) => Object.assign(Error(code), { status });
/** @param {import('node:http').IncomingMessage} req */
async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 2048) throw failure("BODY_TOO_LARGE", 413);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}
/** @param {Room} room @param {number} now */
function view(room, now) {
  return {
    roomId: room.id,
    revision: room.revision,
    board: room.board,
    expiresAt: room.expiresAt,
    snapshotAt: now,
  };
}
/** @param {string} body */
function page(body) {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>QQ Agents · 网页访问验证</title><link rel="stylesheet" href="/p0.css"><script src="/p0.js" defer></script></head><body><main><p class="eyebrow">QQ AGENTS / P0</p><h1>异地落点测试</h1><p>这是临时访问验证页：没有 AI、没有胜负判定；测试落点交替显示黑白棋子。</p><p class="notice">临时地址可能变化。QQ 内置浏览器不能保持登录时，请复制原邀请到系统浏览器，或申请另一条测试邀请；复制房间地址不会复制登录权限。</p>${body}<button id="copy" type="button">复制当前链接</button><p id="copy-result" role="status"></p><p>手机流量与 QQ 内置浏览器的可用性仍须实际验证。此页不连接 QQ 账号或模型。</p></main></body></html>`;
}
/** @param {Room} room @param {number} now */
function roomPage(room, now) {
  const cells = room.board
    .map(
      (stone, i) =>
        `<button disabled class="cell stone-${stone}" data-index="${i}" aria-label="${String.fromCharCode(65 + (i % 15))}${Math.floor(i / 15) + 1}${stone ? (stone === 1 ? " 黑子" : " 白子") : " 空位"}">${stone ? (stone === 1 ? "●" : "○") : "·"}</button>`,
    )
    .join("");
  return page(
    `<section id="room" data-room="${room.id}" data-revision="${room.revision}"><p>版本 <strong id="revision">${room.revision}</strong> · 保留至 <time>${new Date(room.expiresAt).toISOString()}</time></p><p id="connection" role="status">非实时快照：${new Date(now).toISOString()}。请刷新获取最新状态。</p><noscript><p>JavaScript 未开启，下面是有权查看的快照，不能提交。<a href="/room/${room.id}">刷新快照</a></p></noscript><div id="board" aria-label="15 行 15 列测试棋盘">${cells}</div><p id="selection" aria-live="polite">先点选位置，再确认提交。</p><div id="zoom" aria-label="选点局部放大"></div><div class="controls"><button id="confirm" disabled>确认落点</button><button id="cancel" disabled>取消选点</button><button id="retry" hidden>查询待确认结果</button></div></section>`,
  );
}

/** A separate server deliberately imports no runtime or management routes.
 * @param {{database:string, publicOrigin?:string, clock?:()=>number}} options */
export function createP0Server({ database, publicOrigin, clock = Date.now }) {
  if (publicOrigin) {
    const url = new URL(publicOrigin);
    if (
      url.protocol !== "https:" ||
      url.origin !== publicOrigin ||
      url.username ||
      url.password
    )
      throw Error("PUBLIC_ORIGIN_MUST_BE_HTTPS");
  }
  const db = new DatabaseSync(database);
  db.exec(
    "PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS p0_rooms(id TEXT PRIMARY KEY, data TEXT NOT NULL);",
  );
  const challenge = secret();
  let origin = publicOrigin || "";
  let rateWindow = 0,
    requests = 0;
  const assets = new Map([
    [
      "/p0.js",
      {
        type: "text/javascript; charset=utf-8",
        body: readFileSync(new URL("../../public/game-p0.js", import.meta.url)),
      },
    ],
    [
      "/p0.css",
      {
        type: "text/css; charset=utf-8",
        body: readFileSync(
          new URL("../../public/game-p0.css", import.meta.url),
        ),
      },
    ],
  ]);
  /** @param {string} id @returns {Room} */
  function load(id) {
    const row = db.prepare("SELECT data FROM p0_rooms WHERE id=?").get(id);
    if (!row) throw failure("ROOM_UNAVAILABLE", 404);
    const room = /** @type {Room} */ (JSON.parse(String(row.data)));
    if (room.expiresAt <= clock()) throw failure("ROOM_UNAVAILABLE", 410);
    return room;
  }
  /** @param {Room} room */
  function save(room) {
    db.prepare("INSERT OR REPLACE INTO p0_rooms VALUES(?,?)").run(
      room.id,
      JSON.stringify(room),
    );
  }
  /** @template T @param {()=>T} fn @returns {T} */
  function transaction(fn) {
    db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      db.exec("COMMIT");
      return result;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
  /** @param {import('node:http').IncomingMessage} req @param {Room} room */
  function authorized(req, room) {
    const token = (req.headers.cookie || "")
      .split(";")
      .map((x) => x.trim())
      .find((x) => x.startsWith("p0_session="))
      ?.slice(11);
    return !!token && hash(token) === room.sessionHash;
  }
  /** @param {import('node:http').IncomingMessage} req @param {import('node:http').ServerResponse} res */
  async function handle(req, res) {
    res.setHeader("cache-control", "no-store");
    res.setHeader("referrer-policy", "no-referrer");
    res.setHeader("x-content-type-options", "nosniff");
    res.setHeader(
      "content-security-policy",
      "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
    );
    /** @param {unknown} value @param {number} [status] */
    const json = (value, status = 200) => {
      res.writeHead(status, {
        "content-type": "application/json; charset=utf-8",
      });
      res.end(JSON.stringify(value));
    };
    /** @param {string} html @param {number} [status] */
    const html = (html, status = 200) => {
      res.writeHead(status, { "content-type": "text/html; charset=utf-8" });
      res.end(html);
    };
    try {
      const now = clock();
      if (now - rateWindow >= 1000) {
        rateWindow = now;
        requests = 0;
      }
      if (++requests > 120) throw failure("RATE_LIMITED", 429);
      const url = new URL(req.url || "/", origin);
      const address = server.address();
      const localHost =
        typeof address === "object" && address
          ? `127.0.0.1:${address.port}`
          : "";
      if (
        req.headers.host !== new URL(origin).host &&
        !(url.pathname === "/health" && req.headers.host === localHost)
      )
        throw failure("INVALID_HOST", 403);
      if (req.method === "GET" && url.pathname === "/health")
        return json({ service: "qq-agents-game-p0", challenge });
      if (
        req.method === "POST" &&
        (req.headers.origin !== origin ||
          req.headers["sec-fetch-site"] === "cross-site")
      )
        throw failure("CROSS_ORIGIN", 403);
      if (!["GET", "POST"].includes(req.method || ""))
        throw failure("METHOD_NOT_ALLOWED", 405);
      const asset = assets.get(url.pathname);
      if (req.method === "GET" && asset) {
        res.writeHead(200, { "content-type": asset.type });
        res.end(asset.body);
        return;
      }
      if (req.method === "GET" && url.pathname === "/")
        return html(
          page(
            "<p>请使用部署者提供的测试邀请，点击确认加入。公开首页不显示任何房间。</p>",
          ),
        );
      const match =
        /^\/room\/([a-f0-9-]{36})(?:\/(join|state|actions|receipt)(?:\/([a-f0-9-]{36}))?)?$/.exec(
          url.pathname,
        );
      if (!match) throw failure("NOT_FOUND", 404);
      const [, id, route, actionId] = match;
      let room = load(id);
      if (req.method === "GET" && !route) {
        if (authorized(req, room)) return html(roomPage(room, now));
        const invite = url.searchParams.get("invite") || "";
        if (
          !/^[A-Za-z0-9_-]{43}$/.test(invite) ||
          hash(invite) !== room.inviteHash ||
          room.sessionHash ||
          room.inviteExpiresAt <= now
        )
          return html(
            page(
              "<p>邀请无效、已兑换或已过期。若换了浏览器，请向部署者申请独立邀请；刷新不会恢复另一浏览器的登录。</p>",
            ),
            403,
          );
        return html(
          page(
            `<noscript><p>请先开启 JavaScript 完成加入。已加入后可关闭脚本查看快照。</p></noscript><form id="join" method="post" action="/room/${id}/join"><input type="hidden" name="invite" value="${invite}"><button type="submit">确认加入测试房间</button></form><p>仅打开链接不会兑换邀请。确认后请在此浏览器完成测试。</p>`,
          ),
        );
      }
      if (req.method === "POST" && route === "join") {
        if (
          req.headers["content-type"]?.split(";")[0] !==
          "application/x-www-form-urlencoded"
        )
          throw failure("CONTENT_TYPE", 415);
        const invite =
          new URLSearchParams(await readBody(req)).get("invite") || "";
        const token = transaction(() => {
          room = load(id);
          if (authorized(req, room)) return null;
          if (
            hash(invite) !== room.inviteHash ||
            room.sessionHash ||
            room.inviteExpiresAt <= clock()
          )
            throw failure("INVITE_UNAVAILABLE", 403);
          const token = secret();
          room.sessionHash = hash(token);
          save(room);
          return token;
        });
        if (token)
          res.setHeader(
            "set-cookie",
            `p0_session=${token}; Path=/room/${id}; HttpOnly; SameSite=Strict; Max-Age=${Math.max(0, Math.floor((room.expiresAt - clock()) / 1000))}${publicOrigin ? "; Secure" : ""}`,
          );
        res.writeHead(303, { location: `/room/${id}` });
        res.end();
        return;
      }
      if (!authorized(req, room)) throw failure("SESSION_REQUIRED", 401);
      if (req.method === "GET" && route === "state")
        return json(view(room, now));
      if (req.method === "GET" && route === "receipt" && actionId) {
        const action = room.actions.find(
          (a) => a.request.actionId === actionId,
        );
        if (!action) throw failure("ACTION_NOT_FOUND", 404);
        return json(action.result);
      }
      if (req.method === "POST" && route === "actions" && !actionId) {
        if (req.headers["content-type"]?.split(";")[0] !== "application/json")
          throw failure("CONTENT_TYPE", 415);
        let input;
        try {
          input = actionSchema.parse(JSON.parse(await readBody(req)));
        } catch (error) {
          if (error instanceof Error && error.message === "BODY_TOO_LARGE")
            throw error;
          throw failure("INVALID_ACTION", 400);
        }
        const result = transaction(() => {
          room = load(id);
          if (!authorized(req, room)) throw failure("SESSION_REQUIRED", 401);
          const previous = room.actions.find(
            (a) => a.request.actionId === input.actionId,
          );
          if (previous) {
            if (JSON.stringify(previous.request) !== JSON.stringify(input))
              throw failure("IDEMPOTENCY_CONFLICT", 409);
            return previous.result;
          }
          if (input.expectedRevision !== room.revision)
            throw failure("REVISION_CONFLICT", 409);
          const index = input.y * 15 + input.x;
          if (room.board[index]) throw failure("CELL_OCCUPIED", 409);
          const stone = (room.revision % 2) + 1;
          room.board[index] = stone;
          room.revision++;
          const result = {
            actionId: input.actionId,
            revision: room.revision,
            x: input.x,
            y: input.y,
            stone,
          };
          room.actions.push({ request: input, result });
          save(room);
          return result;
        });
        return json(result);
      }
      throw failure("NOT_FOUND", 404);
    } catch (error) {
      if (res.destroyed || res.writableEnded) return;
      const e = /** @type {{message?:string,status?:number}} */ (error);
      const code = e.status ? e.message : "INTERNAL_ERROR";
      if (req.headers.accept?.includes("text/html"))
        return html(
          page(`<p>无法完成请求：${code}。请返回原邀请，或联系部署者。</p>`),
          e.status || 500,
        );
      json({ error: code }, e.status || 500);
    }
  }
  const server = http.createServer(
    { requestTimeout: 10000, headersTimeout: 10000, maxHeaderSize: 8192 },
    (req, res) => {
      void handle(req, res);
    },
  );
  server.maxConnections = 64;
  return {
    challenge,
    /** @param {number} [port] */
    async listen(port = 0) {
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, "127.0.0.1", () => {
          server.off("error", reject);
          resolve(null);
        });
      });
      const address = /** @type {import('node:net').AddressInfo} */ (
        server.address()
      );
      origin ||= `http://127.0.0.1:${address.port}`;
      return { port: address.port, origin };
    },
    createInvite() {
      return transaction(() => {
        db.prepare(
          "DELETE FROM p0_rooms WHERE json_extract(data,'$.expiresAt')<=?",
        ).run(clock());
        if (
          Number(db.prepare("SELECT COUNT(*) AS n FROM p0_rooms").get()?.n) >= 8
        )
          throw Error("ROOM_CAPACITY");
        const token = secret(),
          id = randomUUID(),
          now = clock();
        save({
          id,
          expiresAt: now + 86400000,
          inviteExpiresAt: now + 900000,
          inviteHash: hash(token),
          sessionHash: null,
          revision: 0,
          board: Array(225).fill(0),
          actions: [],
        });
        return {
          roomId: id,
          url: `${origin}/room/${id}?invite=${token}`,
          inviteExpiresAt: now + 900000,
        };
      });
    },
    async close() {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      db.close();
    },
  };
}
