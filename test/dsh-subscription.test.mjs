import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { WebSocketServer } from "ws";
import { NodeApiClient } from "../vendor/dsh-qq/dsh-client.js";

test("DSH forget closes a followed stream and the next turn receives a fresh snapshot", async (t) => {
  const server = http.createServer(),
    wss = new WebSocketServer({ server }),
    messages = [],
    snapshots = [];
  wss.on("connection", (ws) =>
    ws.on("message", (raw) => {
      const m = JSON.parse(raw);
      messages.push(m);
      if (m.type === "open" && m.endpoint === "session/follow")
        ws.send(
          JSON.stringify({
            type: "item",
            streamId: m.streamId,
            value: { type: "snapshot", records: [] },
          }),
        );
      if (m.type === "cancel")
        ws.send(JSON.stringify({ type: "end", streamId: m.streamId }));
    }),
  );
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const client = new NodeApiClient(
    `http://127.0.0.1:${server.address().port}`,
    1000,
    {},
  );
  client.ensureAuth = async () => {};
  client.cookie = "";
  const abort = new AbortController();
  let opened;
  const ready = new Promise((r) => (opened = r));
  const pump = (async () => {
    for await (const frame of client.events.mux({}, abort.signal, opened))
      snapshots.push(frame);
  })();
  t.after(async () => {
    abort.abort();
    await pump;
    for (const ws of wss.clients) ws.terminate();
    await new Promise((r) => wss.close(r));
    await new Promise((r) => server.close(r));
  });
  const wait = async (fn) => {
    for (let n = 0; n < 50 && !fn(); n++)
      await new Promise((r) => setTimeout(r, 10));
    assert.ok(fn(), "expected stream boundary within 500 ms");
  };
  await ready;
  client.events.follow("fixture-session");
  await wait(() => snapshots.length === 1);
  client.events.forget("fixture-session");
  client.events.follow("fixture-session");
  await wait(() => snapshots.length === 2);
  const follows = messages.filter((m) => m.endpoint === "session/follow");
  assert.equal(follows.length, 2);
  assert.notEqual(follows[0].streamId, follows[1].streamId);
  assert.ok(
    messages.some(
      (m) => m.type === "cancel" && m.streamId === follows[0].streamId,
    ),
  );
});
