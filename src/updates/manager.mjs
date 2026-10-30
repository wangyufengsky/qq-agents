import path from "node:path";
import { randomUUID } from "node:crypto";
import { readRelease, UPDATE_REPOSITORY } from "./releases.mjs";
import {
  backupData,
  restoreData,
  stageRelease,
  writeState,
} from "./installation.mjs";

export const updateFailures = new Set([
  "UPDATE_BACKUP_INVALID",
  "UPDATE_RELEASE_CHANGED",
  "UPDATE_NOT_NEWER",
  "UPDATE_LOCAL_CHANGES",
  "UPDATE_DIVERGED",
  "UPDATE_SOURCE_UNSUPPORTED",
  "UPDATE_IMAGE_REBUILD_REQUIRED",
  "UPDATE_RUNTIME_UNSUPPORTED",
  "UPDATE_DATA_LINK_UNSUPPORTED",
  "UPDATE_PROCESS_STILL_RUNNING",
  "UPDATE_DISK_SPACE",
  "UPDATE_COMMAND_FAILED",
  "UPDATE_HEALTH_FAILED",
  "UPDATE_START_FAILED",
  "UPDATE_STOP_FAILED",
  "UPDATE_RESPONSE_INVALID",
  "UPDATE_STATE_INVALID",
  "UPDATE_RECOVERY_REQUIRED",
]);
export const safeUpdateError = (error) =>
  updateFailures.has(error?.message) ? error.message : "UPDATE_INSTALL_FAILED";
export const finalPhases = new Set([
  "idle",
  "completed",
  "failed",
  "rolled-back",
  "recovery-required",
]);

// Deployment mechanics live behind this interface so the same transaction is
// exercised by real subprocesses and deterministic fault-injection tests.
export class UpgradeManager {
  constructor({
    root,
    home,
    current,
    host,
    container = false,
    fetchImpl = fetch,
    stage = stageRelease,
    backup = backupData,
    restore = restoreData,
    notify = () => {},
    save = writeState,
  }) {
    Object.assign(this, {
      root,
      home,
      current,
      host,
      container,
      fetch: fetchImpl,
      stage,
      backup,
      restore,
      notify,
      save,
    });
    this.state = { phase: "idle", error: null };
  }
  snapshot() {
    const { phase, tag, error, startedAt, finishedAt, backupBytes } =
      this.state;
    return {
      managed: true,
      phase,
      tag,
      error,
      startedAt,
      finishedAt,
      backupBytes,
    };
  }
  transition(phase, extra = {}) {
    this.state = { ...this.state, ...extra, phase };
    this.save(path.join(this.home, "transaction.json"), this.state);
    this.notify(this.snapshot());
  }
  install(tag) {
    if (this.job || this.state.phase === "recovery-required")
      throw Error("UPDATE_IN_PROGRESS");
    const id = randomUUID();
    this.state = {
      phase: "idle",
      id,
      tag,
      from: this.current,
      error: null,
      startedAt: Date.now(),
    };
    this.transition("preparing");
    this.controller = new AbortController();
    this.job = this.perform(tag, id)
      .catch(async () => {
        this.state = {
          ...this.state,
          phase: "recovery-required",
          error: "UPDATE_STATE_INVALID",
        };
        this.notify(this.snapshot());
        await this.host.hold?.().catch(() => {});
      })
      .finally(() => {
        this.job = null;
      });
    return this.snapshot();
  }
  async perform(tag, id) {
    let stopped = false,
      backupComplete = false,
      committing = false;
    const backup = path.join(this.home, `backup-${id}`);
    try {
      const response = await this.fetch(
        `https://api.github.com/repos/${UPDATE_REPOSITORY}/releases/latest`,
        {
          redirect: "error",
          credentials: "omit",
          headers: {
            accept: "application/vnd.github+json",
            "user-agent": "qq-agents-updates",
          },
          signal: AbortSignal.any([
            this.controller.signal,
            AbortSignal.timeout(10000),
          ]),
        },
      );
      if (response.status !== 200) {
        await response.body?.cancel();
        throw Error("UPDATE_RELEASE_CHANGED");
      }
      const latest = await readRelease(response);
      if (latest.tag !== tag) throw Error("UPDATE_RELEASE_CHANGED");
      const candidate = await this.stage({
        home: this.home,
        codeRoot: this.current.codeRoot,
        tag,
        container: this.container,
        signal: this.controller.signal,
        progress: (phase) => this.transition(phase),
      });
      this.transition("stopping", { to: candidate });
      const checkpoint = await this.host.stop();
      stopped = true;
      this.transition("backing-up", { checkpoint, backup });
      const summary = await this.backup(this.root, backup);
      backupComplete = true;
      this.transition("starting", {
        backupBytes: summary.bytes,
        backupReady: true,
      });
      await this.host.start(candidate, false);
      this.transition("checking");
      await this.host.health(checkpoint);
      // Persist the point of no automatic rollback BEFORE enabling any sends.
      // A lost resume acknowledgement must not rewind a possibly-used ledger.
      this.save(path.join(this.home, "current.json"), candidate);
      this.transition("resuming", { committing: true });
      committing = true;
      this.current = candidate;
      await this.host.resume(checkpoint);
      this.transition("completed", { finishedAt: Date.now() });
    } catch (error) {
      const code = safeUpdateError(error);
      if (committing) {
        this.transition("recovery-required", {
          error: code,
          finishedAt: Date.now(),
        });
        await this.host.hold?.();
        return;
      }
      if (!stopped) {
        // A stop timeout can leave an uncertain child. Do not start a second one.
        this.transition(
          code === "UPDATE_STOP_FAILED" ? "recovery-required" : "failed",
          { error: code, finishedAt: Date.now() },
        );
        return;
      }
      try {
        this.transition("rolling-back", { error: code });
        await this.host.stopCandidate();
        if (backupComplete)
          await this.restore(
            this.root,
            backup,
            path.join(this.home, `failed-${id}`),
          );
        this.save(path.join(this.home, "current.json"), this.state.from);
        this.current = this.state.from;
        await this.host.start(this.current, false);
        await this.host.hold?.();
        // Rollbacks intentionally stay paused for administrator inspection.
        this.transition("rolled-back", { finishedAt: Date.now() });
      } catch {
        this.transition("recovery-required", {
          error: code,
          finishedAt: Date.now(),
        });
      }
    }
  }
  cancel() {
    this.controller?.abort();
  }
}
