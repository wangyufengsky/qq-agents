/* global window */
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { _electron } from "playwright-core";
import { desktopToken } from "../src/home/desktop-auth.mjs";
import { createServer } from "../src/server.mjs";
import { config, fixture } from "./helpers.mjs";

const exec = promisify(execFile);
const tests = dirname(fileURLToPath(import.meta.url));
const repo = dirname(tests);
const fixtureToken = "private-drop-native-marker";
const fileMarker = "private-drop-fixture.png";
const linkMarker = "https://example.com/private-drop-native";
const png =
  "iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAIAAAD8GO2jAAAAKklEQVR42u3NQQkAAAgEsEtuE2PYzxQ+hMH+S02fikAgEAgEAoFAIPgSLCOKQGqzZ/4ZAAAAAElFTkSuQmCC";

async function waitFor(read, failure = "Native desktop drop timed out") {
  const deadline = Date.now() + 12000;
  for (;;) {
    const value = read();
    if (value) return value;
    if (Date.now() >= deadline) throw Error(failure);
    await delay(25);
  }
}

async function pointer(root) {
  if (process.platform === "darwin") {
    const program = join(root, "desktop-drop-pointer");
    await exec("swiftc", [
      join(tests, "fixtures", "desktop-drop-pointer.swift"),
      "-o",
      program,
    ]);
    return (from, to) =>
      exec(program, [from.x, from.y, to.x, to.y].map(String), {
        timeout: 6000,
      });
  }
  const shell = [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    join(tests, "fixtures", "desktop-drop-pointer.ps1"),
  ];
  await exec("powershell.exe", [...shell, "-Probe"], { timeout: 15000 });
  return (from, to, click = false) =>
    exec(
      "powershell.exe",
      [
        ...shell,
        ...(click ? ["-Click"] : []),
        "-StartX",
        String(from.x),
        "-StartY",
        String(from.y),
        "-EndX",
        String(to.x),
        "-EndY",
        String(to.y),
      ],
      { timeout: 15000 },
    );
}

test("native desktop hit regions accept targeted text and file drops and preserve transparent pass-through", async (t) => {
  const executablePath = process.env.QQ_TEST_ELECTRON;
  if (!executablePath) {
    t.skip("Set QQ_TEST_ELECTRON to the native Electron executable");
    return;
  }
  assert.ok(["darwin", "win32"].includes(process.platform));
  const cfg = config(2);
  cfg.desktopHome.enabled = true;
  cfg.desktopHome.toolRoles = cfg.agents.map(({ id }) => id);
  for (const agent of cfg.agents) {
    agent.files.receive = true;
    agent.behavior.imageInput.enabled = true;
  }
  const { runtime, root } = fixture(t, { cfg });
  const nativeDrag = await pointer(root);
  const admin = randomBytes(32).toString("hex");
  const profile = join(root, "electron");
  const file = join(root, fileMarker);
  const preload = join(root, "drag-source.cjs");
  await mkdir(profile);
  await Promise.all([
    writeFile(file, Buffer.from(png, "base64")),
    writeFile(join(root, "desktop-home-token"), desktopToken(admin)),
    writeFile(
      preload,
      `const { ipcRenderer } = require("electron");
window.addEventListener("dragstart", (event) => {
  if (event.target.id !== "file") return;
  event.preventDefault();
  ipcRenderer.send("fixture:drag-file");
});`,
    ),
  ]);
  const inputs = [];
  for (const agent of cfg.agents) {
    runtime.backendConnections.adapter(agent).runDesktop = async (params) => {
      params.beforeInput?.();
      await params.onRunStarted?.();
      inputs.push({ agentId: agent.id, params });
      await params.callTool("desktop_room_decide", {
        action: "say",
        text: "已收到测试资料。",
      });
    };
  }
  const server = createServer({ runtime, token: admin, allowLive: true });
  const port = await server.listen();
  let electron, nativeSource;
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
      timeout: 20000,
    });
    const door = await electron.firstWindow();
    await door.locator(".door-button").waitFor();
    const host = runtime.desktopVisits;
    await waitFor(() => host.live);
    for (const role of host.live.room.roles) {
      host.live.room.members[role.id] = "invited";
      host.live.admit(role);
    }
    await waitFor(
      () =>
        electron.windows().filter((page) => page.url().includes("type=sprite"))
          .length === 2,
    );
    const sprites = electron
      .windows()
      .filter((page) => page.url().includes("type=sprite"));
    await Promise.all(
      sprites.map((page) =>
        page.locator('.sprite-button[data-motion="still"]').waitFor(),
      ),
    );

    const windows = await electron.evaluate(
      async (
        { app, BrowserWindow, dialog, ipcMain, nativeImage, screen },
        input,
      ) => {
        const area = screen.getPrimaryDisplay().workArea;
        const found = BrowserWindow.getAllWindows();
        const target = found.find(
          (win) =>
            new URL(win.webContents.getURL()).searchParams.get("id") ===
            "agent-0",
        );
        const other = found.find(
          (win) =>
            new URL(win.webContents.getURL()).searchParams.get("id") ===
            "agent-1",
        );
        target.setPosition(area.x + 340, area.y + 230);
        other.setPosition(area.x + 570, area.y + 230);
        const door = found.find((win) =>
          win.webContents.getURL().includes("type=door"),
        );
        door.setPosition(area.x + 780, area.y + 230);
        globalThis.fixtureChoices = [];
        const showMessageBox = dialog.showMessageBox;
        dialog.showMessageBox = (parent, options) => {
          if (parent !== door || options.title !== "选择接收者")
            return showMessageBox(parent, options);
          globalThis.fixtureChoices.push(options.buttons);
          return Promise.resolve({ response: 1 });
        };
        const bounds = target.getBounds();
        const backdrop = new BrowserWindow({
          ...bounds,
          frame: false,
          title: "Desktop Drop Fixture Backdrop",
        });
        await backdrop.loadURL(
          "data:text/html," +
            encodeURIComponent(`<body style="margin:0;height:100vh">
<script>
window.fixtureDrops=[];
window.fixtureClicks=0;
document.onmousedown=()=>window.fixtureClicks++;
window.fixtureEvents=[];
for (const name of ["dragenter", "dragleave", "dragover", "drop"])
  document.addEventListener(name, (event) => window.fixtureEvents.push([name,event.screenX,event.screenY,event.dataTransfer.dropEffect]));
document.ondragover=(event)=>{ event.preventDefault(); event.dataTransfer.dropEffect="copy"; };
document.ondrop=(event)=>{
  event.preventDefault();
  window.fixtureDrops.push(event.dataTransfer.getData('text/plain'));
};
</script>`),
        );
        const origin = { x: area.x + 44, y: area.y + 234 };
        const targets = {
          origin,
          backdrop: backdrop.id,
          target: target.id,
          door: door.id,
        };
        if (process.platform === "win32")
          return {
            ...targets,
            physicalOrigin: screen.dipToScreenPoint(origin),
          };
        const source = new BrowserWindow({
          ...origin,
          width: 180,
          height: 125,
          frame: false,
          title: "Desktop Drop Fixture Source",
          webPreferences: { preload: input.preload, sandbox: true },
        });
        ipcMain.on("fixture:drag-file", (event) => {
          if (event.sender !== source.webContents) return;
          const icon = nativeImage
            .createFromPath(input.file)
            .resize({ width: 24 });
          if (!icon.isEmpty())
            event.sender.startDrag({ file: input.file, icon });
        });
        await source.loadURL(
          "data:text/html," +
            encodeURIComponent(`<body style="margin:0">
<div id="text" draggable="true" style="height:35px;background:#eed">Test text</div>
<div id="file" draggable="true" style="height:35px;background:#ded">Test file</div>
<div id="link" draggable="true" style="height:35px;background:#dde">Test link</div>
<script>
window.fixtureEvents=[];
for (const name of ["mousedown", "dragstart", "dragend", "mouseup"])
  document.addEventListener(name, (event) => window.fixtureEvents.push([name,event.target.id,event.screenX,event.screenY,event.dataTransfer?.dropEffect]));
document.getElementById("text").ondragstart=(event) => {
  event.dataTransfer.effectAllowed="copy";
  event.dataTransfer.setData("text/plain", ${JSON.stringify(input.marker)});
};
document.getElementById("link").ondragstart=(event) => {
  event.dataTransfer.effectAllowed="copy";
  event.dataTransfer.setData("text/uri-list", ${JSON.stringify(input.link)});
  event.dataTransfer.setData("text/plain", ${JSON.stringify(input.link)});
};
</script>`),
        );
        app.focus({ steal: true });
        source.moveTop();
        source.focus();
        return { ...targets, source: source.id };
      },
      { preload, file, marker: fixtureToken, link: linkMarker },
    );
    let nativeSourceOutput = "";
    if (windows.physicalOrigin) {
      // OLE runs in the source thread. An external source leaves the target
      // Electron process free to update pointer regions during the drag.
      nativeSource = spawn(
        "powershell.exe",
        [
          "-STA",
          "-NoProfile",
          "-NonInteractive",
          "-ExecutionPolicy",
          "Bypass",
          "-File",
          join(tests, "fixtures", "desktop-drop-source.ps1"),
          "-X",
          String(windows.physicalOrigin.x),
          "-Y",
          String(windows.physicalOrigin.y),
          "-FilePath",
          file,
          "-Text",
          fixtureToken,
          "-Link",
          linkMarker,
        ],
        { stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
      );
      nativeSource.on(
        "error",
        ({ code }) => (nativeSourceOutput += String(code)),
      );
      nativeSource.stderr.on("data", (chunk) => {
        if (nativeSourceOutput.length < 4096) nativeSourceOutput += chunk;
      });
      let sourceReady = false;
      nativeSource.stdout.on("data", (chunk) => {
        if (nativeSourceOutput.length < 4096) nativeSourceOutput += chunk;
        if (nativeSourceOutput.includes("READY")) sourceReady = true;
      });
      try {
        await waitFor(() => sourceReady || nativeSource.exitCode !== null);
        assert.ok(sourceReady);
      } catch (error) {
        throw Error(
          `Native drag source failed to start: ${nativeSourceOutput}`,
          { cause: error },
        );
      }
    }
    const points = async (variant, transparent = false) => {
      return electron.evaluate(
        ({ app, BrowserWindow, screen }, { windows, variant, transparent }) => {
          const source = windows.source && BrowserWindow.fromId(windows.source);
          if (source) {
            source.show();
            app.focus({ steal: true });
            source.moveTop();
            source.focus();
          }
          const { x, y } = source ? source.getContentBounds() : windows.origin;
          const target = BrowserWindow.fromId(
            variant === "link" ? windows.door : windows.target,
          ).getBounds();
          const physical = (point) =>
            process.platform === "win32"
              ? screen.dipToScreenPoint(point)
              : point;
          return [
            physical({
              x: x + 25,
              y: y + { text: 15, file: 49, link: 84 }[variant],
            }),
            physical({
              x: target.x + (variant === "link" ? 45 : transparent ? 3 : 94),
              y: target.y + (variant === "link" ? 48 : transparent ? 3 : 109),
            }),
          ];
        },
        { windows, variant, transparent },
      );
    };
    const backdrop = await waitFor(() =>
      electron.windows().find((page) => page.url().includes("fixtureDrops")),
    );
    const transparentPoints = await points("text", true);
    const corner = transparentPoints[1];
    const windowsNative = process.platform === "win32";
    const trace = windowsNative
      ? await nativeDrag(corner, corner, true)
      : await nativeDrag(...transparentPoints);
    try {
      if (windowsNative) {
        assert.match(trace.stdout, /Desktop Drop Fixture Backdrop/);
        // Windows mouse-through and OLE target discovery use different paths.
        await backdrop.waitForFunction(() => window.fixtureClicks === 1, null, {
          timeout: 5000,
        });
      } else {
        await backdrop.waitForFunction(
          () => window.fixtureDrops.length === 1,
          null,
          {
            timeout: 5000,
          },
        );
        assert.equal(
          await backdrop.evaluate(() => window.fixtureDrops[0]),
          fixtureToken,
        );
      }
    } catch (error) {
      throw Error(
        JSON.stringify({
          transparentPoints,
          trace: trace.stdout,
          nativeSourceOutput,
          backdropEvents: await backdrop.evaluate(() =>
            window.fixtureEvents.slice(-16),
          ),
        }),
        { cause: error },
      );
    }
    assert.equal(inputs.length, 0);

    const sprite = sprites.find((page) => page.url().includes("id=agent-0"));
    await sprite.evaluate(() => {
      window.fixtureEvents = [];
      for (const name of ["dragenter", "dragover", "drop", "dragleave"])
        window.addEventListener(name, (event) =>
          window.fixtureEvents.push([
            name,
            event.target.className,
            ...event.dataTransfer.types,
          ]),
        );
    });
    const textTrace = await nativeDrag(...(await points("text")));
    try {
      await waitFor(
        () => inputs.length === 1,
        "Text did not reach the targeted private turn",
      );
    } catch (error) {
      throw Error(
        JSON.stringify({
          trace: textTrace.stdout,
          nativeSourceOutput,
          spriteEvents: await sprite.evaluate(() =>
            window.fixtureEvents.slice(-16),
          ),
        }),
        { cause: error },
      );
    }
    assert.equal(inputs[0].agentId, "agent-0");
    assert.ok(inputs[0].params.prompt.includes(fixtureToken));
    assert.ok(!JSON.stringify(host.clientSnapshot()).includes(fixtureToken));
    const panel = await waitFor(() =>
      electron.windows().find((page) => page.url().includes("type=panel")),
    );
    await panel
      .locator(".personal-history")
      .getByText(fixtureToken, { exact: false })
      .waitFor();

    await electron.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()
        .find((win) => win.webContents.getURL().includes("type=panel"))
        ?.destroy();
    });
    await nativeDrag(...(await points("file")));
    await waitFor(
      () => inputs.length === 2,
      "image did not reach its private turn",
    );
    assert.equal(inputs[1].agentId, "agent-0");
    assert.equal(inputs[1].params.inputImages.length, 1);
    assert.ok(!JSON.stringify(host.clientSnapshot()).includes(fileMarker));
    const imagePanel = await waitFor(() =>
      electron.windows().find((page) => page.url().includes("type=panel")),
    );
    await imagePanel
      .locator(".personal-history")
      .getByText(fileMarker, { exact: false })
      .waitFor();
    await electron.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()
        .find((win) => win.webContents.getURL().includes("type=panel"))
        ?.destroy();
    });

    await door.evaluate(() => {
      window.fixtureEvents = [];
      for (const name of ["dragenter", "drop"])
        window.addEventListener(name, (event) =>
          window.fixtureEvents.push([name, ...event.dataTransfer.types]),
        );
    });
    await nativeDrag(...(await points("link")));
    try {
      await waitFor(
        () => inputs.length === 3,
        "Door choice did not reach its private turn",
      );
    } catch (error) {
      throw Error(
        JSON.stringify({
          events: await door.evaluate(() => window.fixtureEvents),
          choices: await electron.evaluate(() => globalThis.fixtureChoices),
          inputCount: inputs.length,
          point: await points("link"),
        }),
        { cause: error },
      );
    }
    assert.deepEqual(await electron.evaluate(() => globalThis.fixtureChoices), [
      [...host.live.room.roles.map(({ name }) => name), "取消"],
    ]);
    assert.equal(inputs[2].agentId, "agent-1");
    assert.ok(inputs[2].params.prompt.includes(linkMarker));
    assert.ok(!inputs[2].params.prompt.includes(fixtureToken));
    assert.deepEqual(inputs[2].params.inputImages, []);
    assert.ok(!JSON.stringify(host.clientSnapshot()).includes(linkMarker));
  } finally {
    if (nativeSource && nativeSource.exitCode === null) nativeSource.kill();
    await electron?.close();
    await server.close();
  }
});
