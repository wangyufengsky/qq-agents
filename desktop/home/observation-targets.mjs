import { displayFingerprint } from "./space.mjs";
import {
  observationDisplayTarget,
  observationTarget,
  verifyCaptureCoverage,
} from "./screen-source.mjs";
import {
  macosCaptureSnapshot,
  macosCoverageSnapshot,
} from "./macos-capture-snapshot.mjs";

export function createObservationTargets({
  screen,
  BrowserWindow,
  observationDriver,
  deniedWindow,
  listScreenSources,
  screenCapturePermission,
}) {
  function ownScreenSources() {
    return BrowserWindow.getAllWindows().map((win) => win.getMediaSourceId());
  }

  function observationError(error) {
    return error.message === "DESKTOP_NATIVE_PERMISSION" ||
      !screenCapturePermission()
      ? "permission"
      : "unavailable";
  }

  async function captureCoverage(scope, signal) {
    if (process.platform !== "darwin") return false;
    const snapshot = await macosCaptureSnapshot({ signal });
    if (
      scope.targetId &&
      !snapshot.windows?.some(
        ({ id, pid }) => id === scope.targetId && pid === scope.pid,
      )
    )
      return false;
    const coverage = macosCoverageSnapshot(snapshot, deniedWindow);
    return !signal.aborted && verifyCaptureCoverage(coverage, scope);
  }

  async function readDisplayTarget(selection, signal, verifyCoverage = true) {
    if (signal.aborted) return { state: "unavailable" };
    if (!screenCapturePermission()) return { state: "permission" };
    try {
      const target = () =>
        screen
          .getAllDisplays()
          .find(
            (display) =>
              display.id === selection.displayId &&
              displayFingerprint(display) === selection.fingerprint,
          );
      if (!target()) return { state: "unavailable" };
      const sources = await listScreenSources(false, true);
      if (!screenCapturePermission()) return { state: "permission" };
      if (signal.aborted || !target()) return { state: "unavailable" };
      const source = observationDisplayTarget(sources, selection.displayId);
      if (!source) return { state: "unavailable" };
      if (
        verifyCoverage &&
        !(await captureCoverage({ displayBounds: target()?.bounds }, signal))
      )
        return { state: "minimized" };
      return target() && !signal.aborted
        ? { state: "ready", source }
        : { state: "unavailable" };
    } catch (error) {
      return { state: observationError(error) };
    }
  }

  async function readObservationTarget(source, signal, verifyCoverage = true) {
    try {
      if (
        !source?.identity ||
        !observationDriver ||
        deniedWindow(source.identity) !== false
      )
        return { state: "unavailable" };
      if (!screenCapturePermission()) return { state: "permission" };
      const windows = await observationDriver.observationWindows({
        signal: AbortSignal.any([signal, AbortSignal.timeout(2500)]),
        app: source.identity.app,
      });
      const own = ownScreenSources();
      const identity = observationTarget(
        [source],
        windows,
        source,
        own,
        process.pid,
      );
      if (identity.state !== "ready") return identity;
      if (
        verifyCoverage &&
        !(await captureCoverage(
          { targetId: source.identity.id, pid: source.identity.pid },
          signal,
        ))
      )
        return { state: "minimized" };
      const sources = await listScreenSources(true);
      if (!screenCapturePermission()) return { state: "permission" };
      if (signal.aborted) return { state: "unavailable" };
      return observationTarget(sources, windows, source, own, process.pid);
    } catch (error) {
      return { state: observationError(error) };
    }
  }

  return {
    ownScreenSources,
    observationError,
    captureCoverage,
    readDisplayTarget,
    readObservationTarget,
  };
}
