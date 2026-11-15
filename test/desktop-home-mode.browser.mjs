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
import { config, fixture } from "./helpers.mjs";

const repo = dirname(dirname(fileURLToPath(import.meta.url)));

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
    host.command({
      client: host.client.id,
      action: "screen-grant",
      data: { ...grant, grantId: randomUUID() },
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
  } finally {
    try {
      await electron?.close();
    } finally {
      await server.close();
    }
  }
});
