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
const targetTitle = "Synthetic window approach target";

async function waitFor(read, problem) {
  const deadline = Date.now() + 8000;
  for (;;) {
    const value = await read();
    if (value) return value;
    if (Date.now() >= deadline) throw Error(problem);
    await delay(25);
  }
}

async function createTarget(root) {
  const directory = join(root, "target-app");
  await mkdir(directory);
  await Promise.all([
    writeFile(
      join(directory, "package.json"),
      JSON.stringify({ type: "module", main: "target.mjs" }),
    ),
    writeFile(
      join(directory, "target.mjs"),
      `import { app, BrowserWindow } from "electron";
import { join } from "node:path";
app.setPath("userData", join(app.getAppPath(), "profile"));
app.whenReady().then(async () => {
  const win = new BrowserWindow({ x: 70, y: 470, width: 300, height: 220 });
  await win.loadURL("data:text/html," + encodeURIComponent('<title>${targetTitle}</title><body style="background: rebeccapurple">'));
  globalThis.focusTarget = () => { app.focus({ steal: true }); win.moveTop(); win.focus(); };
  globalThis.focusTarget();
});`,
    ),
  ]);
  return directory;
}

test("the inherited list offers window approach from a scheduled public activity", async (t) => {
  const executablePath = process.env.QQ_TEST_ELECTRON;
  const nativeHelper = process.env.QQ_AGENTS_AGENT_DESKTOP_EXECUTABLE;
  if (process.platform !== "darwin" || !executablePath || !nativeHelper) {
    t.skip(
      "Requires macOS, QQ_TEST_ELECTRON and the installed QQ_AGENTS_AGENT_DESKTOP_EXECUTABLE",
    );
    return;
  }
  const cfg = config(2);
  cfg.desktopHome.enabled = true;
  cfg.desktopHome.publicPerception.enabled = true;
  cfg.desktopHome.autonomousObservation = true;
  delete cfg.desktopHome.observationRoles;
  cfg.desktopHome.screenView.enabled = true;
  cfg.desktopHome.toolRoles = ["agent-0"];
  cfg.desktopHome.activityRoles = ["agent-0"];
  cfg.desktopHome.bodyControlRoles = ["agent-0"];
  cfg.agents[0].behavior.imageInput.enabled = true;
  const { runtime, root } = fixture(t, { cfg });
  const profile = join(root, "electron");
  const admin = randomBytes(32).toString("hex");
  await mkdir(profile);
  await Promise.all([
    writeFile(
      join(profile, "prototype-preferences.json"),
      JSON.stringify({ companionMode: "presence" }),
    ),
    writeFile(join(root, "desktop-home-token"), desktopToken(admin)),
  ]);
  const targetDirectory = await createTarget(root);
  const server = createServer({ runtime, token: admin, allowLive: true });
  const port = await server.listen();
  let electron, targetApp;
  try {
    electron = await _electron.launch({
      executablePath,
      args: [join(repo, "desktop/home")],
      env: {
        ...process.env,
        DESKTOP_HOME_TRIAL_PROFILE: profile,
        DESKTOP_HOME_DATA_ROOT: root,
        DESKTOP_HOME_LIVE_ROOT: "",
        DESKTOP_HOME_PORT: String(port),
      },
      timeout: 20_000,
    });
    const door = await electron.firstWindow();
    const doorButton = door.locator(".door-button");
    await doorButton.waitFor();
    const host = runtime.desktopVisits;
    await waitFor(
      () =>
        host.mode === "presence" &&
        host.client?.bodyWindowApproach &&
        host.client?.bodyPublic,
      "Capabilities did not negotiate",
    );
    const role = host.live.room.roles[0];
    host.live.room.members[role.id] = "invited";
    host.live.admit(role);
    const sprite = await waitFor(
      () =>
        electron
          .windows()
          .find((page) => page.url().includes(`type=sprite&id=${role.id}`)),
      "Role window did not open",
    );
    const spriteButton = sprite.locator(".sprite-button");
    await sprite.locator(".sprite-button[data-motion=still]").waitFor();
    const spriteWindow = await electron.browserWindow(sprite);
    const bounds = () => spriteWindow.evaluate((win) => win.getBounds());
    const moveAway = () =>
      spriteWindow.evaluate((win) => win.setPosition(700, 185));
    await moveAway();
    targetApp = await _electron.launch({
      executablePath,
      args: [targetDirectory],
      timeout: 12_000,
    });
    const targetPage = await targetApp.firstWindow();
    assert.equal(await targetPage.title(), targetTitle);
    const targetWindow = await targetApp.browserWindow(targetPage);
    await electron.evaluate(({ Menu }, title) => {
      // Only select the synthetic fixture through the production observation picker.
      Menu.prototype.popup = function (options) {
        this.items
          .flatMap((item) => item.submenu?.items ?? [])
          .find((item) => item.label === `窗口 · ${title}`)
          ?.click();
        options.callback();
      };
    }, targetTitle);
    await doorButton.focus();
    await doorButton.press("Enter");
    const panel = await waitFor(
      () =>
        electron.windows().find((page) => page.url().includes("type=panel")),
      "The tools panel did not open",
    );
    const panelWindow = await electron.browserWindow(panel);
    await panelWindow.evaluate((win) => win.focus());
    await panel.locator(".tools-launch").click();
    await panel.getByRole("button", { name: "授权自主观察窗口" }).click();
    const grant = await waitFor(
      () => host.observation.windows.get(role.id),
      "The synthetic target was not authorized",
    );
    await targetApp.evaluate(() => globalThis.focusTarget());
    await waitFor(
      () =>
        host.observation.targetReady(grant) && host.activityCurrent(role.id),
      "The authorized target did not become ready",
    );
    const targetBounds = await targetWindow.evaluate((win) => win.getBounds());
    const adapter = runtime.backendConnections.adapter(runtime.agent(role.id));
    let receipt, adapterError, submitted;
    adapter.runDesktop = async (params) => {
      try {
        params.beforeInput();
        await params.onRunStarted();
        params.onInputSubmitted();
        assert.equal(params.managedContext.conversation, "@desktop-activity");
        assert.ok(
          params.tools.some(
            ({ function: tool }) =>
              tool.name === "desktop_body_control" &&
              JSON.stringify(tool.parameters).includes("approach-window"),
          ),
        );
        assert.equal(params.inputImages, undefined);
        submitted = true;
        receipt = await params.callTool("desktop_body_control", {
          type: "approach-window",
          requestId: randomUUID(),
        });
        if (!params.signal.aborted)
          await params.callTool("desktop_activity_decide", {
            action: "silent",
          });
      } catch (error) {
        adapterError = error;
        throw error;
      }
    };
    const visit = host.live.visits.get(role.id);
    const runScheduledActivity = () => {
      receipt = submitted = undefined;
      visit.publicActivity.due = runtime.now() - 1;
      return host.live.advanceActivity(runtime.now());
    };
    await runScheduledActivity();
    assert.ifError(adapterError);
    assert.equal(receipt?.status, "completed");
    assert.equal(receipt.arrivalConfirmed, true);
    assert.equal("position" in receipt, false);
    const arrived = await bounds();
    const horizontal = Math.max(
      0,
      arrived.x - targetBounds.x - targetBounds.width,
      targetBounds.x - arrived.x - arrived.width,
    );
    const vertical = Math.max(
      0,
      arrived.y - targetBounds.y - targetBounds.height,
      targetBounds.y - arrived.y - arrived.height,
    );
    assert.ok(horizontal > 0 || vertical > 0);
    assert.ok(Math.hypot(horizontal, vertical) < 60);

    await moveAway();
    const second = runScheduledActivity();
    await waitFor(() => submitted, "The second regular activity did not start");
    await waitFor(
      async () => (await bounds()).x < 680,
      "The second movement did not begin",
    );
    const { x, y, width, height } = await spriteButton.boundingBox();
    const grip = { x: x + width / 2, y: y + height / 2 };
    await sprite.mouse.move(grip.x, grip.y);
    await sprite.mouse.down();
    await sprite.mouse.move(grip.x + 45, grip.y + 15, { steps: 3 });
    await sprite.mouse.up();
    await second;
    // The public scheduler may cancel its turn before the desktop receipt arrives.
    if (adapterError)
      assert.equal(adapterError.message, "DESKTOP_VISIT_UNAVAILABLE");
    else assert.equal(receipt?.status, "cancelled");
    assert.equal(host.live.visits.get(role.id), visit);
    assert.equal(host.observation.windows.get(role.id), grant);
    const stopped = await bounds();
    await delay(650);
    assert.deepEqual(await bounds(), stopped);
  } finally {
    try {
      await targetApp?.close();
    } finally {
      try {
        await electron?.close();
      } finally {
        await server.close();
      }
    }
  }
});
