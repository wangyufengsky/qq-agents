import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createGomokuFixture } from "../src/games/gomoku/server.mjs";

test("gomoku HTTP rejects forged and invalid actions, then plays and retains a complete winning game", async (t) => {
  const service = createGomokuFixture({ database: ":memory:" });
  const { origin } = await service.listen();
  t.after(() => service.close());
  const room = service.createRoom(),
    base = `${origin}/rooms/${room.roomId}`,
    cookies = [];
  const call = (route, body, cookie = "", extra = {}) =>
    fetch(base + route, {
      method: body ? "POST" : "GET",
      headers: { origin, "content-type": "application/json", cookie, ...extra },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  assert.equal((await call("/view")).status, 401);
  for (const invite of room.invitations) {
    const url = new URL(invite.url),
      bindingId = url.searchParams.get("binding");
    const challenge = await call("/join", {
      bindingId,
      invite: url.searchParams.get("invite"),
    });
    assert.equal(challenge.status, 200);
    const joined = await call(
      "/join",
      { bindingId },
      challenge.headers.get("set-cookie").split(";")[0],
    );
    assert.equal(joined.status, 200);
    cookies.push(joined.headers.get("set-cookie").split(";")[0]);
  }
  const request = (type, payload = {}) => ({
    actionId: randomUUID(),
    expectedRevision: service.kernel.store.room(room.roomId).revision,
    action: { type, payload },
  });
  assert.equal(
    (await call("/actions", request("room.start"), cookies[0])).status,
    200,
  );
  for (const payload of [
    { x: -1, y: 0 },
    { x: 15, y: 0 },
    { x: 0, y: 15 },
    { x: 0.1, y: 0 },
    { x: "7", y: 7 },
    { x: 7, y: 7, color: "black" },
  ]) {
    assert.equal(
      (await call("/actions", request("game.place", payload), cookies[0]))
        .status,
      400,
    );
  }
  assert.equal(service.kernel.store.room(room.roomId).revision, 3);
  assert.equal(
    (
      await call(
        "/actions",
        { ...request("game.place", { x: 7, y: 7 }), actorId: "fixture-guest" },
        cookies[0],
      )
    ).status,
    400,
  );
  assert.equal(
    (
      await call(
        "/actions",
        request("game.place", { x: 7, y: 7 }),
        cookies[0],
        { origin: "https://example.test" },
      )
    ).status,
    403,
  );
  const wrongTurn = await call("/actions", request("game.resign"), cookies[1]);
  assert.equal((await wrongTurn.json()).error, "NOT_YOUR_TURN");
  let last, receipt;
  for (let i = 0; i < 9; i++) {
    last = request("game.place", { x: Math.floor(i / 2), y: i % 2 ? 2 : 0 });
    const res = await call("/actions", last, cookies[i % 2]);
    assert.equal(res.status, 200);
    receipt = await res.json();
  }
  assert.deepEqual(
    await (await call("/actions", last, cookies[0])).json(),
    receipt,
  );
  assert.deepEqual(
    await (
      await call(`/actions/${last.actionId}`, undefined, cookies[0])
    ).json(),
    receipt,
  );
  for (const cookie of cookies) {
    const view = await (await call("/view", undefined, cookie)).json();
    assert.equal(view.lifecycle, "finished");
    assert.equal(view.view.result.reasonCode, "FIVE_OR_MORE");
    const html = await (await call("", undefined, cookie)).text();
    assert.match(html, /E1 黑子/);
    assert.match(html, /对局结束/);
  }
  const anonymous = await (await call("")).text();
  assert.doesNotMatch(anonymous, /E1 黑子/);
});
