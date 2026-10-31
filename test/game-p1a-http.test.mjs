import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import http from "node:http";
import { createP1aFixture } from "../src/games/fixtures/server.mjs";

async function fixture(t) {
  const service = createP1aFixture({ database: ":memory:" });
  const address = await service.listen();
  t.after(() => service.close());
  const room = service.createRoom(),
    base = `/rooms/${room.roomId}`;
  async function call(route, { method = "GET", body, headers = {} } = {}) {
    return new Promise((resolve, reject) => {
      const req = http.request(
        address.origin + route,
        {
          method,
          headers: {
            host: new URL(address.origin).host,
            origin: address.origin,
            "content-type": "application/json",
            ...headers,
          },
        },
        (res) => {
          const chunks = [];
          res.on("data", (x) => chunks.push(x));
          res.on("end", () =>
            resolve(
              new Response(Buffer.concat(chunks), {
                status: res.statusCode,
                headers: Object.fromEntries(
                  Object.entries(res.headers).map(([k, v]) => [
                    k,
                    Array.isArray(v) ? v.join(", ") : v,
                  ]),
                ),
              }),
            ),
          );
        },
      );
      req.on("error", reject);
      req.end(body === undefined ? undefined : JSON.stringify(body));
    });
  }
  async function join(index) {
    const url = new URL(room.invitations[index].url),
      bindingId = url.searchParams.get("binding"),
      invite = url.searchParams.get("invite");
    const pending = await call(base + "/join", {
      method: "POST",
      body: { bindingId, invite },
    });
    assert.equal(pending.status, 200);
    const result = await call(base + "/join", {
      method: "POST",
      body: { bindingId },
      headers: { cookie: pending.headers.get("set-cookie").split(";")[0] },
    });
    assert.equal(result.status, 200);
    return result.headers.get("set-cookie").split(";")[0];
  }
  return { service, ...room, ...address, base, call, join };
}

test("GET invitation is inert; explicit join binds a room-scoped HttpOnly session", async (t) => {
  const f = await fixture(t),
    url = new URL(f.invitations[0].url);
  for (let i = 0; i < 2; i++) {
    const response = await f.call(url.pathname + url.search);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("set-cookie"), null);
  }
  assert.equal(f.service.kernel.store.room(f.roomId).revision, 0);
  const cookie = await f.join(0);
  const reopened = await f.call(url.pathname + url.search, {
    headers: { cookie },
  });
  assert.equal(reopened.status, 303);
  assert.equal(reopened.headers.get("location"), f.base);
  assert.match(cookie, new RegExp(`^game_${f.roomId}=`));
  const response = await f.call(f.base + "/view", { headers: { cookie } });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).revision, 1);
  assert.equal((await f.call("/api/status")).status, 404);
});

test("HTTP boundaries reject forged Host, Origin, actor fields, forwarding and anonymous views", async (t) => {
  const f = await fixture(t),
    cookie = await f.join(0);
  for (const headers of [
    { host: "attacker.test" },
    { "x-forwarded-proto": "https" },
  ])
    assert.equal((await f.call("/health", { headers })).status, 403);
  assert.equal((await f.call(f.base + "/view")).status, 401);
  const action = {
    actionId: randomUUID(),
    expectedRevision: 1,
    action: { type: "room.close", payload: {} },
  };
  for (const origin of ["null", "https://attacker.test", ""])
    assert.equal(
      (
        await f.call(f.base + "/actions", {
          method: "POST",
          body: action,
          headers: { cookie, origin },
        })
      ).status,
      403,
    );
  assert.equal(
    (
      await f.call(f.base + "/actions", {
        method: "POST",
        body: { ...action, actorId: "fixture-guest" },
        headers: { cookie },
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await f.call(f.base + "/actions", {
        method: "POST",
        body: action,
        headers: { cookie, "content-type": "text/plain" },
      })
    ).status,
    415,
  );
  assert.equal(
    (
      await f.call(f.base + "/actions", {
        method: "POST",
        body: { huge: "x".repeat(20_000) },
        headers: { cookie },
      })
    ).status,
    413,
  );
  assert.equal((await f.call(f.base, { method: "HEAD" })).status, 405);
});

test("HTTP snapshots, SSR, events and receipts do not disclose the other player's hidden choice", async (t) => {
  const f = await fixture(t),
    a = await f.join(0),
    b = await f.join(1);
  const act = async (cookie, revision, type, payload) => {
    const actionId = randomUUID();
    const response = await f.call(f.base + "/actions", {
      method: "POST",
      headers: { cookie },
      body: { actionId, expectedRevision: revision, action: { type, payload } },
    });
    assert.equal(response.status, 200);
    return { actionId, receipt: await response.json() };
  };
  await act(a, 2, "room.start", {});
  const chosen = await act(a, 3, "game.choose", { symbol: "sun" });
  for (const route of [f.base, f.base + "/view", f.base + "/events?after=0"]) {
    const response = await f.call(route, { headers: { cookie: b } }),
      html = await response.text(),
      text =
        route === f.base
          ? /<pre id="snapshot">([\s\S]*?)<\/pre>/.exec(html)[1]
          : html;
    assert.equal(response.status, 200);
    assert.equal(text.includes('"sun"'), false);
    assert.equal(text.includes("&quot;sun&quot;"), false);
    assert.equal(text.includes("principalId"), false);
  }
  assert.equal(
    (
      await f.call(f.base + "/actions/" + chosen.actionId, {
        headers: { cookie: b },
      })
    ).status,
    404,
  );
  assert.equal(JSON.stringify(chosen.receipt).includes("sun"), false);
  await act(b, 4, "game.choose", { symbol: "sun" });
  const view = await (
    await f.call(f.base + "/view", { headers: { cookie: b } })
  ).json();
  assert.equal(view.lifecycle, "finished");
  assert.deepEqual(view.view.revealed, ["sun", "sun"]);
});
