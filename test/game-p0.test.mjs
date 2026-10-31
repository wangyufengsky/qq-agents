import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { randomUUID } from "node:crypto";
import { createP0Server } from "../src/games/p0-server.mjs";

async function fixture(t, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "game-p0-"));
  let now = Date.now();
  const database = path.join(dir, "p0.sqlite");
  let server = createP0Server({ database, clock: () => now, ...options });
  let address = await server.listen();
  t.after(async () => {
    await server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const invite = server.createInvite();
  let cookie = "";
  const route = `/room/${invite.roomId}`;
  async function call(
    suffix = "",
    { method = "GET", body, headers = {} } = {},
  ) {
    // Node fetch owns Host; use a raw request to exercise proxy Host validation.
    return new Promise((resolve, reject) => {
      const req = http.request(
        `http://127.0.0.1:${address.port}${route}${suffix}`,
        {
          method,
          headers: {
            host: new URL(address.origin).host,
            origin: address.origin,
            ...(cookie ? { cookie } : {}),
            ...headers,
          },
        },
        (res) => {
          const chunks = [];
          res.on("data", (chunk) => chunks.push(chunk));
          res.on("end", () =>
            resolve(
              new Response(Buffer.concat(chunks), {
                status: res.statusCode,
                headers: Object.fromEntries(
                  Object.entries(res.headers).map(([key, value]) => [
                    key,
                    Array.isArray(value) ? value.join(", ") : value,
                  ]),
                ),
              }),
            ),
          );
        },
      );
      req.on("error", reject);
      req.end(body?.toString());
    });
  }
  return {
    invite,
    route,
    database,
    call,
    advance(ms) {
      now += ms;
    },
    async restart() {
      await server.close();
      server = createP0Server({ database, clock: () => now, ...options });
      address = await server.listen();
    },
    createInvite: () => server.createInvite(),
    get origin() {
      return address.origin;
    },
    async join() {
      const token = new URL(invite.url).searchParams.get("invite");
      const response = await call("/join", {
        method: "POST",
        body: new URLSearchParams({ invite: token }),
        headers: { "content-type": "application/x-www-form-urlencoded" },
      });
      cookie = response.headers.get("set-cookie")?.split(";")[0] || "";
      return response;
    },
    setCookie(value) {
      cookie = value;
    },
    move(input) {
      return call("/actions", {
        method: "POST",
        body: JSON.stringify(input),
        headers: { "content-type": "application/json" },
      });
    },
  };
}
const move = (expectedRevision = 0, x = 7, y = 7) => ({
  actionId: randomUUID(),
  expectedRevision,
  x,
  y,
});

test("P0 invite preview is non-consuming, explicit exchange creates a secure scoped session", async (t) => {
  const f = await fixture(t, { publicOrigin: "https://game.example" });
  const query = new URL(f.invite.url).search;
  for (let i = 0; i < 2; i++) {
    const response = await f.call(query);
    assert.equal(response.status, 200);
    assert.match(await response.text(), /确认加入测试房间/);
    assert.equal(response.headers.get("set-cookie"), null);
    assert.equal(response.headers.get("referrer-policy"), "no-referrer");
  }
  assert.equal((await f.call("/state")).status, 401);
  const response = await f.join();
  assert.equal(response.status, 303);
  assert.equal(response.headers.get("location"), f.route);
  assert.match(
    response.headers.get("set-cookie"),
    /HttpOnly; SameSite=Strict; Max-Age=\d+; Secure/,
  );
  assert.equal((await f.call("/state")).status, 200);
  f.setCookie("");
  assert.equal((await f.call(query)).status, 403);
  assert.equal((await f.join()).status, 403);
});

test("P0 duplicate concurrent moves return the original receipt after later moves and restart", async (t) => {
  const f = await fixture(t);
  await f.join();
  const input = move();
  const results = await Promise.all([f.move(input), f.move(input)]);
  assert.deepEqual(
    results.map((r) => r.status),
    [200, 200],
  );
  const receipt = await results[0].json();
  assert.deepEqual(await results[1].json(), receipt);
  assert.equal((await f.move(move(1, 8, 7))).status, 200);
  assert.deepEqual(await (await f.move(input)).json(), receipt);
  assert.equal((await f.move({ ...input, x: 9 })).status, 409);
  await f.restart();
  assert.deepEqual(
    await (await f.call(`/receipt/${input.actionId}`)).json(),
    receipt,
  );
  assert.deepEqual(await (await f.move(input)).json(), receipt);
  const state = await (await f.call("/state")).json();
  assert.equal(state.revision, 2);
  assert.equal(state.board[112], 1);
  assert.equal(state.board[113], 2);
  f.setCookie("p0_session=forged");
  assert.equal((await f.call(`/receipt/${input.actionId}`)).status, 401);
});

test("P0 rejects cross-site writes, forged identities, wrong revisions and occupied cells", async (t) => {
  const f = await fixture(t);
  await f.join();
  const input = move();
  assert.equal(
    (
      await f.call("/actions", {
        method: "POST",
        body: JSON.stringify(input),
        headers: {
          "content-type": "application/json",
          origin: "https://other.example",
        },
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await f.call("/actions", {
        method: "POST",
        body: JSON.stringify(input),
        headers: {
          "content-type": "application/json",
          "sec-fetch-site": "cross-site",
        },
      })
    ).status,
    403,
  );
  assert.equal((await f.move({ ...input, actorId: "agent" })).status, 400);
  assert.equal(
    (
      await f.call("/actions", {
        method: "POST",
        body: JSON.stringify(input),
        headers: { "content-type": "application/json", origin: "null" },
      })
    ).status,
    403,
  );
  assert.equal((await f.move({ ...input, x: 15 })).status, 400);
  assert.equal((await f.move(move(1))).status, 409);
  assert.equal((await f.move(input)).status, 200);
  assert.equal((await f.move(move(1))).status, 409);
  assert.equal(
    (await f.call("/state", { headers: { host: "other.example" } })).status,
    403,
  );
});

test("P0 snapshots do not expose the board without a session and remain useful without scripts", async (t) => {
  const f = await fixture(t);
  const preview = await (await f.call(new URL(f.invite.url).search)).text();
  assert.doesNotMatch(preview, /id="board"/);
  await f.join();
  await f.move(move());
  const html = await (await f.call()).text();
  assert.match(html, /非实时快照/);
  assert.match(html, /<noscript>/);
  assert.match(html, /H8 黑子/);
  assert.equal((html.match(/<button disabled class="cell/g) || []).length, 225);
  assert.doesNotMatch(html, /invite=/);
});

test("P0 fake clock expires invitation separately from an established session and bounds rooms", async (t) => {
  const f = await fixture(t);
  await f.join();
  const second = f.createInvite();
  f.advance(900000);
  assert.equal((await f.call("/state")).status, 200);
  const secondResponse = await fetch(second.url);
  assert.equal(secondResponse.status, 403);
  f.advance(86400000);
  assert.equal((await f.call("/state")).status, 410);
  assert.equal((await f.move(move())).status, 410);
  for (let i = 0; i < 8; i++) f.createInvite();
  assert.throws(() => f.createInvite(), /ROOM_CAPACITY/);
});

test("P0 exposes only dedicated assets and a per-start health challenge", async (t) => {
  const f = await fixture(t);
  const before = await (await fetch(`${f.origin}/health`)).json();
  assert.equal(before.service, "qq-agents-game-p0");
  assert.equal(Object.keys(before).length, 2);
  for (const route of [
    "/api/status",
    "/agent/tools",
    "/config.json",
    "/public/app.js",
    "/proxy?url=http://localhost:3210",
  ]) {
    assert.equal((await fetch(`${f.origin}${route}`)).status, 404);
  }
  await f.restart();
  const after = await (await fetch(`${f.origin}/health`)).json();
  assert.notEqual(before.challenge, after.challenge);
  assert.throws(
    () =>
      createP0Server({
        database: ":memory:",
        publicOrigin: "http://game.example",
      }),
    /PUBLIC_ORIGIN_MUST_BE_HTTPS/,
  );
});
