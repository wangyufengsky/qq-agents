import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { runNativeSocial } from "../src/backends/native-social.mjs";
import { deriveRelayToken } from "../src/core/relay-auth.mjs";
import { desktopToken } from "../src/home/desktop-auth.mjs";
import { createServer } from "../src/server.mjs";
import { config, fixture } from "./helpers.mjs";

const tool = "desktop_screen_view";
const jpeg =
  "/9j/4AAQSkZJRgABAgAAAQABAAD//gAQTGF2YzYyLjI4LjEwMAD/2wBDAAgEBAQEBAUFBQUFBQYGBgYGBgYGBgYGBgYHBwcICAgHBwcGBgcHCAgICAkJCQgICAgJCQoKCgwMCwsODg4RERT/xABLAAEBAAAAAAAAAAAAAAAAAAAABQEBAAAAAAAAAAAAAAAAAAAABRABAAAAAAAAAAAAAAAAAAAAABEBAAAAAAAAAAAAAAAAAAAAAP/AABEIABAAEAMBIgACEQADEQD/2gAMAwEAAhEDEQA/AIAAok//2Q==";

async function setup(t) {
  const cfg = config(2);
  cfg.desktopHome.enabled = true;
  cfg.desktopHome.screenView = { enabled: true };
  cfg.desktopHome.toolRoles = ["agent-0", "agent-1"];
  for (const agent of cfg.agents) agent.behavior.imageInput.enabled = true;
  const { runtime, root } = fixture(t, { cfg });
  const host = runtime.desktopVisits;
  const token = randomBytes(32).toString("hex");
  const server = createServer({ runtime, token, allowLive: true });
  t.after(() => server.close());
  const origin = `http://127.0.0.1:${await server.listen()}`;
  const client = randomUUID();
  const post = (route, body, headers) =>
    fetch(origin + route, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
  const command = async (action, data, id = client) => {
    const response = await post(
      "/api/desktop-home/client",
      { client: id, action, data },
      { "x-desktop-home-token": desktopToken(token) },
    );
    assert.equal(response.status, 200);
    return response.json();
  };
  const result = (data, key = desktopToken(token)) =>
    post("/api/desktop-home/screen-result", data, {
      "x-desktop-home-token": key,
    });
  const { room } = await command("sync");
  for (const role of host.live.room.roles) {
    host.live.room.members[role.id] = "invited";
    host.live.admit(role);
  }
  const run = async (actor, body) => {
    const backend = runtime.backendConnections.adapter(runtime.agent(actor));
    let capability;
    backend.runDesktop = (params) => {
      capability = params.socialContextToken;
      return runNativeSocial(backend, params, async () => {}, "desktop");
    };
    backend.run = async (params) => {
      await params.beforeInputSubmitted();
      params.saveSession(
        params.session ?? { backend: "codex", id: `fixture-${randomUUID()}` },
      );
      const call = (name = tool, args = {}) =>
        post(
          "/agent/tools",
          { name, arguments: args },
          {
            "x-agent-capability": capability,
            "x-agent-relay-token": deriveRelayToken(token),
            "x-agent-output-request": randomUUID(),
            "x-agent-output-protocol": "stdio-v1",
          },
        ).then((response) => response.json());
      await body(call, params);
      await call("desktop_room_decide", { action: "silent" });
    };
    const decision = await host.run(
      { actor, kind: "chat", people: [], messages: [] },
      new AbortController().signal,
    );
    assert.equal(decision.action, "silent");
  };
  return {
    runtime,
    root,
    host,
    roomEpoch: room.roomEpoch,
    client,
    command,
    result,
    token,
    run,
  };
}

async function waitForRequest(command) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const { screenRequest } = await command("sync");
    if (screenRequest) return screenRequest;
    await delay(10);
  }
  assert.fail("Desktop client did not receive a capture request");
}

test("screen bytes reach only the selected desktop turn and the next turn gets a fresh session", async (t) => {
  const {
    runtime,
    root,
    host,
    roomEpoch,
    client,
    command,
    result,
    token,
    run,
  } = await setup(t);
  const grantId = randomUUID();
  const { room } = await command("screen-grant", {
    roomEpoch,
    grantId,
    agentId: "agent-0",
  });
  assert.deepEqual(room.screenView.eligible, ["agent-0", "agent-1"]);
  assert.equal(room.screenView.grantedAgentId, "agent-0");
  for (const conversation of ["private:30000", "@subject"]) {
    assert(
      !runtime.toolsFor(runtime.agent("agent-0"), conversation).includes(tool),
    );
  }
  await run("agent-1", async (call) => {
    assert.equal((await call()).isError, true);
    assert.equal((await command("sync")).screenRequest, undefined);
  });

  const before = host.archive.history();
  await run("agent-0", async (call, params) => {
    assert(params.tools.some(({ name }) => name === tool));
    const output = call();
    const request = await waitForRequest(command);
    assert.equal(request.roomEpoch, roomEpoch);
    assert.equal(request.grantId, grantId);
    assert(request.maxEdge >= 16);
    assert(request.maxBytes >= Buffer.from(jpeg, "base64").length);
    const payload = {
      client,
      roomEpoch,
      grantId,
      requestId: request.requestId,
      data: jpeg,
    };
    assert.equal((await result(payload, token)).status, 401);
    assert.equal(
      (await command("sync", undefined, randomUUID())).screenRequest,
      undefined,
    );
    assert.equal(
      (await result({ ...payload, client: randomUUID() })).ok,
      false,
    );
    assert.equal(
      (await result({ ...payload, roomEpoch: randomUUID() })).ok,
      false,
    );
    const accepted = await result(payload);
    assert.equal(accepted.status, 200);
    assert.deepEqual(await accepted.json(), { accepted: true });

    const delivered = await output;
    assert(!delivered.isError);
    assert.deepEqual(
      delivered.content.filter(({ type }) => type === "image"),
      [{ type: "image", mimeType: "image/jpeg", data: jpeg }],
    );
    assert.equal((await result(payload)).ok, false);
    assert.equal((await command("sync")).screenRequest, undefined);
    assert.equal((await call()).isError, true);
  });

  assert.deepEqual(host.archive.history(), before);
  const { room: after } = await command("sync");
  assert(!JSON.stringify(after).includes(jpeg));
  for (const filename of ["memory.sqlite", "memory.sqlite-wal"]) {
    const disk = await readFile(path.join(root, filename));
    assert(!disk.includes(jpeg));
    assert(!disk.includes(Buffer.from(jpeg, "base64")));
  }
  await run("agent-0", async (_, params) => {
    assert.equal(params.session, null);
  });
});

test("revoking screen access cancels an outstanding capture and rejects its late result", async (t) => {
  const { roomEpoch, client, command, result, run } = await setup(t);
  const grantId = randomUUID();
  await command("screen-grant", { roomEpoch, grantId, agentId: "agent-0" });
  await run("agent-0", async (call) => {
    const output = call();
    const { requestId } = await waitForRequest(command);
    await command("screen-revoke", { roomEpoch, grantId });
    assert.equal((await output).isError, true);
    const late = await result({
      client,
      roomEpoch,
      grantId,
      requestId,
      data: jpeg,
    });
    assert.equal(late.ok, false);
    const sync = await command("sync");
    assert.equal(sync.screenRequest, undefined);
    assert.notEqual(sync.room.screenView.grantedAgentId, "agent-0");
  });
});
