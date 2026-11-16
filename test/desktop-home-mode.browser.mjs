import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { _electron } from "playwright-core";
import { desktopToken } from "../src/home/desktop-auth.mjs";
import { createServer } from "../src/server.mjs";
import { mediaSubmitted } from "../src/tools/media-lease.mjs";
import { config, fixture } from "./helpers.mjs";

const repo = dirname(dirname(fileURLToPath(import.meta.url)));
const fixtureJpeg =
  "/9j/4AAQSkZJRgABAgAAAQABAAD//gAQTGF2YzYyLjI4LjEwMAD/2wBDAAgEBAQEBAUFBQUFBQYGBgYGBgYHBwcICAgHBwcGBgcHCAgICAkJCQgICAgJCQoKCgwMCwsODg4RERT/xABLAAEBAAAAAAAAAAAAAAAAAAAABQEBAAAAAAAAAAAAAAAAAAAABRABAAAAAAAAAAAAAAAAAAAAABEBAAAAAAAAAAAAAAAAAAAAAP/AABEIABAAEAMBIgACEQADEQD/2gAMAwEAAhEDEQA/AIAAok//2Q==";

async function waitFor(read, failure) {
  const deadline = Date.now() + 12000;
  for (;;) {
    const value = read();
    if (value) return value;
    if (Date.now() >= deadline) throw Error(failure);
    await delay(25);
  }
}

test("native desktop remembers modes and requires fresh targets after a restart", async (t) => {
  const executablePath = process.env.QQ_TEST_ELECTRON;
  if (!executablePath) {
    t.skip("Set QQ_TEST_ELECTRON to the native Electron executable");
    return;
  }
  const cfg = config(2);
  cfg.desktopHome.enabled = true;
  cfg.desktopHome.toolRoles = cfg.agents.map(({ id }) => id);
  cfg.desktopHome.screenView.enabled = true;
  cfg.desktopHome.browserControl.enabled = true;
  for (const agent of cfg.agents) agent.behavior.imageInput.enabled = true;
  const { runtime, root } = fixture(t, { cfg });
  const admin = randomBytes(32).toString("hex");
  const profile = join(root, "electron");
  await mkdir(profile);
  await Promise.all([
    writeFile(join(root, "desktop-home-token"), desktopToken(admin)),
    writeFile(
      join(profile, "prototype-preferences.json"),
      JSON.stringify({ companionMode: "work" }),
    ),
  ]);
  const server = createServer({ runtime, token: admin, allowLive: true });
  const port = await server.listen();
  const launch = () =>
    _electron.launch({
      executablePath,
      args: [join(repo, "desktop/home")],
      env: {
        ...process.env,
        DESKTOP_HOME_TRIAL_PROFILE: profile,
        DESKTOP_HOME_DATA_ROOT: root,
        DESKTOP_HOME_LIVE_ROOT: "",
        DESKTOP_HOME_PORT: String(port),
      },
      timeout: 20000,
    });
  let electron;
  try {
    electron = await launch();
    const door = await electron.firstWindow();
    const button = door.locator(".door-button");
    await button.waitFor();
    const host = runtime.desktopVisits;
    await waitFor(
      () => host.live && host.mode === "work",
      "Saved mode did not negotiate",
    );
    assert.equal(host.screen.state().grants.length, 0);
    assert.equal(host.browser.state()?.grantedAgentId ?? null, null);
    const role = host.live.room.roles[0];
    host.live.room.members[role.id] = "invited";
    host.live.admit(role);
    // Install fixture grants directly so the test never selects or reads a real target.
    const grant = {
      roomEpoch: host.live.room.epoch,
      agentId: role.id,
      modeRevision: host.modeRevision,
    };
    const screenGrantId = randomUUID();
    host.command({
      client: host.client.id,
      action: "screen-grant",
      data: { ...grant, grantId: screenGrantId },
    });
    host.command({
      client: host.client.id,
      action: "browser-grant",
      data: { ...grant, grantId: randomUUID(), origin: "https://example.com" },
    });
    assert.equal(host.screen.state().grants.length, 1);
    assert.equal(host.browser.state()?.grantedAgentId, role.id);
    await button.focus();
    await button.press("Enter");
    const panel = await waitFor(
      () =>
        electron.windows().find((page) => page.url().includes("type=panel")),
      "Panel failed to open",
    );
    await panel.locator(".tools-launch").click();
    const receipts = panel.locator(".frame-receipts");
    const entries = receipts.locator("li");
    const backend = runtime.backendConnections.adapter(runtime.agent(role.id));
    for (const outcome of ["submitted", "no-receipt"]) {
      const completion = Promise.withResolvers();
      backend.runDesktop = async (params) => {
        await params.onRunStarted();
        params.onInputSubmitted();
        const frame = await params.callTool("desktop_screen_view", {});
        assert.equal(frame.content[1].data, fixtureJpeg);
        await completion.promise;
        if (outcome === "submitted") frame[mediaSubmitted]();
        await params.callTool("desktop_room_decide", { action: "silent" });
      };
      const controller = new AbortController();
      const turn = host.run(
        { actor: role.id, kind: "chat", people: [], messages: [] },
        controller.signal,
      );
      void turn.catch(() => {});
      try {
        const request = await waitFor(
          () => host.screen.request(),
          "Capture did not start",
        );
        const response = await fetch(
          `http://127.0.0.1:${port}/api/desktop-home/screen-result`,
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-desktop-home-token": desktopToken(admin),
            },
            body: JSON.stringify({
              client: host.client.id,
              roomEpoch: request.roomEpoch,
              grantId: screenGrantId,
              requestId: request.requestId,
              data: fixtureJpeg,
            }),
          },
        );
        assert.deepEqual(await response.json(), { accepted: true });
        await receipts.waitFor({ state: "visible" });
        if (outcome === "submitted") await receipts.locator("summary").click();
        const row = receipts.getByTitle(`请求 ${request.requestId}`);
        await row
          .filter({ hasText: /框架已收到画面$/ })
          .waitFor({ state: "visible" });
        completion.resolve();
        assert.equal((await turn).action, "silent");
        const label =
          outcome === "submitted" ? "画面已提交模型" : "提交结果未确认";
        await row.filter({ hasText: label }).waitFor({ state: "visible" });
      } finally {
        controller.abort();
        completion.resolve();
        await turn.catch(() => {});
      }
    }
    assert.equal(await entries.count(), 2);
    assert.doesNotMatch(await receipts.textContent(), /\/9j\/4AAQ/);
    await panel.locator(".companion-mode").selectOption("presence");
    await waitFor(() => host.mode === "presence", "Downgrade did not commit");
    assert.equal(host.browser.state()?.grantedAgentId ?? null, null);
    assert.equal(host.screen.state().grants.length, 1);
    const client = host.client.id;
    await electron.close();
    electron = await launch();
    await electron.firstWindow();
    await waitFor(
      () => host.client?.id !== client && host.mode === "presence",
      "Mode preference was not restored by the new client",
    );
    assert.equal(host.screen.state().grants.length, 0);
    assert.equal(host.browser.state()?.grantedAgentId ?? null, null);
    assert.deepEqual(host.clientSnapshot().frameReceipts, []);
  } finally {
    try {
      await electron?.close();
    } finally {
      await server.close();
    }
  }
});
