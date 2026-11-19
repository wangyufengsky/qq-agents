import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { _electron } from "playwright-core";
import {
  observationDisplayTarget,
  observationSources,
  verifyCaptureCoverage,
} from "../desktop/home/screen-source.mjs";
import { temp } from "./helpers.mjs";

const exec = promisify(execFile);
const probe = fileURLToPath(
  new URL("fixtures/windows-window-coverage.ps1", import.meta.url),
);
const desktopCaptureModule = new URL(
  "../desktop/home/full-desktop-capture.mjs",
  import.meta.url,
).href;

async function waitFor(read, accept, message) {
  const end = Date.now() + 12_000;
  do {
    const value = await read();
    if (accept(value)) return value;
    await delay(150);
  } while (Date.now() < end);
  assert.fail(message);
}

async function launch(root, executablePath, extra = []) {
  return _electron.launch({
    executablePath,
    args: [root, ...extra],
    timeout: 20_000,
  });
}

test("interactive Windows CI supplies window identity and coverage evidence", async (t) => {
  const executablePath = process.env.QQ_TEST_ELECTRON;
  if (process.platform !== "win32" || !executablePath) {
    t.skip("Requires an interactive Windows desktop and QQ_TEST_ELECTRON");
    return;
  }
  const root = temp(t);
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({ main: "main.cjs" }),
  );
  await writeFile(
    join(root, "main.cjs"),
    `
const { app, BrowserWindow, desktopCapturer, screen } = require("electron");
const { join } = require("node:path");
const observer = process.argv.includes("--coverage-observer");
app.setPath("userData", join(app.getAppPath(), observer ? "observer-profile" : "target-profile"));
app.whenReady().then(async () => {
  if (observer) {
    const { createFullDesktopCapture } = await import(${JSON.stringify(desktopCaptureModule)});
    globalThis.captureFixtureDesktop = createFullDesktopCapture({
      getDisplays: () => screen.getAllDisplays(),
      getSources: (options) => desktopCapturer.getSources(options),
      permission: () => "granted",
    });
    const win = new BrowserWindow({ show: false });
    await win.loadURL("data:text/html,<title>Coverage Metadata Observer</title>");
    return;
  }
  const { x, y, width, height } = screen.getPrimaryDisplay().workArea;
  const targetBounds = { x: x + Math.floor(width * .12), y: y + Math.floor(height * .15), width: 310, height: 200 };
  const window = (bounds, options) => new BrowserWindow({ ...bounds, show: false, ...options });
  const target = window(targetBounds);
  const blocker = window({ x: targetBounds.x + 28, y: targetBounds.y + 36, width: 110, height: 90 }, { focusable: false, alwaysOnTop: true });
  const other = window({ x: targetBounds.x + 340, y: targetBounds.y, width: 145, height: 130 });
  await Promise.all([[target,"Target"],[blocker,"Blocker"],[other,"Focus"]].map(([w, name]) =>
    w.loadURL("data:text/html," + encodeURIComponent("<title>Windows Coverage Fixture " + name + "</title><body>synthetic"))));
  globalThis.coverageFixture = { target, blocker, other };
  target.show();
  target.focus();
});
`,
  );
  let fixture, observer;
  try {
    fixture = await launch(root, executablePath);
    observer = await launch(root, executablePath, ["--coverage-observer"]);
    await observer.firstWindow();
    const setup = await waitFor(
      () =>
        fixture.evaluate(({ screen }) => {
          const windows = globalThis.coverageFixture;
          if (!windows) return;
          const id = (win) =>
            win.getNativeWindowHandle().readBigUInt64LE().toString();
          const display = screen.getDisplayMatching(windows.target.getBounds());
          return {
            targetId: id(windows.target),
            blockerId: id(windows.blocker),
            otherId: id(windows.other),
            pid: process.pid,
            displayId: display.id,
            scale: display.scaleFactor,
            displayBounds: screen.dipToScreenRect(
              windows.target,
              display.bounds,
            ),
          };
        }),
      Boolean,
      "The Windows fixture did not initialize",
    );
    const { targetId, blockerId, otherId } = setup;
    const snapshot = async () => {
      const { stdout } = await exec(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-ExecutionPolicy",
          "Bypass",
          "-File",
          probe,
          "-TargetHandle",
          targetId,
        ],
        { timeout: 10_000 },
      );
      const report = JSON.parse(stdout);
      // Runner windows are unknown and are treated as sensitive for this experiment.
      report.windows = report.windows.map((entry) => ({
        ...entry,
        sensitive: entry.id !== targetId && entry.id !== otherId,
      }));
      return report;
    };
    const focus = (key) =>
      fixture.evaluate((_electron, key) => {
        const win = globalThis.coverageFixture[key];
        win.show();
        win.focus();
      }, key);
    await focus("target");
    const start = await waitFor(
      snapshot,
      (value) => value.complete && value.foregroundId === targetId,
      "Win32 did not identify the fixture as the foreground window",
    );
    assert.equal(start.ownerPid, setup.pid);
    assert.ok(start.processInstance);
    assert.equal(start.dpi, Math.round(96 * setup.scale));
    assert.deepEqual(start.display.bounds, setup.displayBounds);
    assert.equal(
      verifyCaptureCoverage(start, { targetId }),
      true,
      "The unobstructed target did not establish coverage",
    );

    const metadata = await observer.evaluate(
      async ({ BrowserWindow, desktopCapturer }) => {
        const available = await desktopCapturer.getSources({
          types: ["window", "screen"],
          thumbnailSize: { width: 0, height: 0 },
        });
        return {
          ownPid: process.pid,
          ownSources: BrowserWindow.getAllWindows().map((win) =>
            win.getMediaSourceId(),
          ),
          sources: available.map(({ id, display_id }) => ({ id, display_id })),
        };
      },
    );
    const identities = [
      {
        id: `w-${targetId}`,
        state: "ready",
        pid: start.ownerPid,
        processInstance: start.processInstance,
      },
    ];
    assert.equal(
      observationSources(
        metadata.sources,
        identities,
        metadata.ownSources,
        metadata.ownPid,
      ).length,
      1,
    );
    assert.ok(observationDisplayTarget(metadata.sources, setup.displayId));

    const desktop = await observer.evaluate(async ({ screen }) => {
      const result = await globalThis.captureFixtureDesktop(
        { maxEdge: 256, maxBytes: 1024 * 1024 },
        new AbortController().signal,
      );
      return {
        status: result.status,
        displays: screen.getAllDisplays().map(({ id, bounds }) => ({
          id: String(id),
          bounds,
        })),
        frames: result.frames?.map(
          ({ displayId, bounds, width, height, data }) => ({
            id: displayId,
            bounds,
            jpeg: data.startsWith("/9j/") && width > 0 && height > 0,
          }),
        ),
      };
    });
    assert.equal(desktop.status, undefined);
    assert.ok(desktop.displays.length > 0);
    assert.deepEqual(
      desktop.frames,
      desktop.displays
        .sort((left, right) => left.id.localeCompare(right.id))
        .map((display) => ({ ...display, jpeg: true })),
    );
    t.diagnostic(
      "Full desktop capture covered " +
        desktop.frames.length +
        " Windows display(s).",
    );

    await fixture.evaluate(() =>
      globalThis.coverageFixture.blocker.showInactive(),
    );
    const blocked = await waitFor(
      snapshot,
      (value) =>
        value.complete && value.windows.some(({ id }) => id === blockerId),
      "Win32 did not enumerate the non-activating blocker",
    );
    assert.equal(blocked.foregroundId, targetId);
    const order = (report) => report.windows.map(({ id }) => id);
    assert.ok(
      order(blocked).indexOf(blockerId) < order(blocked).indexOf(targetId),
    );
    assert.equal(verifyCaptureCoverage(blocked, { targetId }), false);
    assert.equal(
      verifyCaptureCoverage(blocked, { displayBounds: start.display.bounds }),
      false,
    );
    await fixture.evaluate(() => {
      const { target, blocker } = globalThis.coverageFixture;
      const [x, y] = target.getPosition();
      blocker.setPosition(x + 340, y);
    });
    const separate = await snapshot();
    assert.ok(separate.complete && order(separate).includes(blockerId));
    assert.equal(verifyCaptureCoverage(separate, { targetId }), true);
    assert.equal(
      verifyCaptureCoverage(separate, { displayBounds: start.display.bounds }),
      false,
    );
    await fixture.evaluate(() => globalThis.coverageFixture.blocker.hide());
    await focus("other");
    const unfocused = await waitFor(
      snapshot,
      (value) => value.complete && value.foregroundId === otherId,
      "Win32 did not observe the different foreground window",
    );
    assert.ok(!order(unfocused).includes(blockerId));
    assert.ok(order(unfocused).includes(targetId));
    assert.equal(verifyCaptureCoverage(unfocused, { targetId }), false);
    await fixture.evaluate(() => globalThis.coverageFixture.target.minimize());
    const minimized = await snapshot();
    assert.ok(minimized.complete && !order(minimized).includes(targetId));
    assert.equal(verifyCaptureCoverage(minimized, { targetId }), false);
    assert.equal(
      verifyCaptureCoverage({ ...start, complete: false }, { targetId }),
      false,
    );
    t.diagnostic(
      JSON.stringify({
        targetProcessVerified: true,
        externalElectronSourceMatched: true,
        displayCount: start.display.count,
        displayBounds: start.display.bounds,
        targetDpi: start.dpi,
        results: {
          clearWindow: true,
          foregroundOverlap: false,
          nonOverlappingBlocker: true,
          restrictedDisplay: false,
          differentForeground: false,
          minimized: false,
          incomplete: false,
        },
      }),
    );
  } finally {
    try {
      await observer?.close();
    } finally {
      await fixture?.close();
    }
  }
});
