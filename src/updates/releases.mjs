import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";

export const UPDATE_REPOSITORY = "wangyufengsky/qq-agents";
export const RELEASES_URL = `https://github.com/${UPDATE_REPOSITORY}/releases`;
const endpoint = `https://api.github.com/repos/${UPDATE_REPOSITORY}/releases/latest`;
const interval = 6 * 60 * 60 * 1000;
export const releaseTag = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const preferences = z
  .object({
    enabled: z.boolean(),
    ignoredTag: z.string().max(80).regex(releaseTag).nullable(),
  })
  .strict();
const changes = preferences.partial();

export function compareVersions(left, right) {
  if (typeof left !== "string" || typeof right !== "string") return null;
  const a = releaseTag.exec(left || ""),
    b = releaseTag.exec(right || "");
  if (!a || !b || left.length > 80 || right.length > 80) return null;
  for (let i = 1; i <= 3; i++) {
    if (BigInt(a[i]) > BigInt(b[i])) return 1;
    if (BigInt(a[i]) < BigInt(b[i])) return -1;
  }
  return 0;
}

// Only public release metadata crosses this fixed-origin request. No agent
// credentials, configuration, machine identifiers or chat context are attached.
export async function readRelease(response) {
  if (Number(response.headers.get("content-length")) > 256 * 1024) {
    await response.body?.cancel();
    throw Error("UPDATE_RESPONSE_INVALID");
  }
  const chunks = [];
  let bytes = 0;
  for await (const chunk of response.body || []) {
    bytes += chunk.length;
    if (bytes > 256 * 1024) throw Error("UPDATE_RESPONSE_INVALID");
    chunks.push(chunk);
  }
  let value;
  try {
    value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw Error("UPDATE_RESPONSE_INVALID");
  }
  if (
    !value ||
    typeof value.tag_name !== "string" ||
    value.tag_name.length > 80 ||
    !releaseTag.test(value.tag_name) ||
    value.draft !== false ||
    value.prerelease !== false ||
    typeof value.published_at !== "string" ||
    !Number.isFinite(Date.parse(value.published_at)) ||
    (value.body != null && typeof value.body !== "string")
  )
    throw Error("UPDATE_RESPONSE_INVALID");
  return {
    tag: value.tag_name,
    publishedAt: new Date(value.published_at).toISOString(),
    notes: (value.body || "").slice(0, 60000),
    url: `${RELEASES_URL}/tag/${encodeURIComponent(value.tag_name)}`,
  };
}

export class ReleaseUpdates {
  constructor({ root, installed = {}, fetchImpl = fetch, now = Date.now }) {
    Object.assign(this, { root, installed, fetch: fetchImpl, now });
    this.file = path.join(root, "updates.json");
    this.preferences = { enabled: false, ignoredTag: null };
    this.latest = null;
    this.checkedAt = null;
    this.attemptedAt = null;
    this.nextCheckAt = null;
    this.error = null;
    this.failures = 0;
    this.closed = false;
    try {
      const st = fs.lstatSync(this.file);
      if (
        !st.isFile() ||
        st.isSymbolicLink() ||
        st.nlink !== 1 ||
        st.size > 4096
      )
        throw Error("UPDATE_SETTINGS_INVALID");
      this.preferences = preferences.parse(
        JSON.parse(fs.readFileSync(this.file, "utf8")),
      );
    } catch (error) {
      if (error.code !== "ENOENT") this.error = "UPDATE_SETTINGS_INVALID";
    }
  }
  snapshot() {
    const order = this.latest
      ? compareVersions(this.installed.packageVersion, this.latest.tag)
      : null;
    const comparison =
      order === null
        ? "unknown"
        : order < 0
          ? "available"
          : order > 0
            ? "ahead"
            : "same-version";
    return {
      ...this.preferences,
      installed: {
        version: this.installed.packageVersion || "unknown",
        commit: this.installed.commit || null,
        modified: this.installed.modified ?? null,
        provenance: this.installed.provenance || "unknown",
      },
      latest: this.latest,
      comparison,
      notify:
        comparison === "available" &&
        this.preferences.ignoredTag !== this.latest?.tag,
      checking: !!this.inFlight,
      checkedAt: this.checkedAt,
      attemptedAt: this.attemptedAt,
      nextCheckAt: this.nextCheckAt,
      error: this.error,
    };
  }
  configure(value) {
    if (this.closed) throw Error("RUNTIME_CLOSING");
    const result = changes.safeParse(value);
    if (!result.success) throw Error("UPDATE_SETTINGS_INVALID");
    const next = { ...this.preferences, ...result.data };
    if (result.data.ignoredTag && result.data.ignoredTag !== this.latest?.tag)
      throw Error("UPDATE_RELEASE_CHANGED");
    const tmp = `${this.file}.${randomUUID()}.tmp`;
    try {
      fs.writeFileSync(tmp, JSON.stringify(next) + "\n", {
        flag: "wx",
        mode: 0o600,
      });
      fs.renameSync(tmp, this.file);
    } catch {
      throw Error("UPDATE_SETTINGS_SAVE_FAILED");
    } finally {
      fs.rmSync(tmp, { force: true });
    }
    this.preferences = next;
    if (this.error === "UPDATE_SETTINGS_INVALID") this.error = null;
    this.schedule(
      next.enabled
        ? Math.max(1000, (this.nextCheckAt || this.now()) - this.now())
        : 0,
    );
    return this.snapshot();
  }
  start() {
    this.schedule(this.preferences.enabled ? 1000 : 0);
  }
  schedule(delay) {
    clearTimeout(this.timer);
    if (!delay || !this.preferences.enabled || this.closed) return;
    this.timer = setTimeout(() => {
      void this.check();
    }, delay);
    this.timer.unref?.();
  }
  async check() {
    if (this.closed) throw Error("RUNTIME_CLOSING");
    if (this.inFlight) {
      await this.inFlight;
      return this.snapshot();
    }
    // Manual clicks share the same rate budget as the scheduled checker.
    if (this.attemptedAt !== null && this.now() - this.attemptedAt < 60000) {
      this.schedule(60000 - (this.now() - this.attemptedAt));
      return this.snapshot();
    }
    this.inFlight = this.fetchLatest();
    try {
      await this.inFlight;
    } finally {
      this.inFlight = null;
    }
    return this.snapshot();
  }
  async fetchLatest() {
    this.attemptedAt = this.now();
    this.controller = new AbortController();
    const timeout = setTimeout(() => this.controller.abort(), 10000);
    timeout.unref?.();
    try {
      const response = await this.fetch(endpoint, {
        method: "GET",
        redirect: "error",
        credentials: "omit",
        headers: {
          accept: "application/vnd.github+json",
          "user-agent": "qq-agents-updates",
          ...(this.etag ? { "if-none-match": this.etag } : {}),
        },
        signal: this.controller.signal,
      });
      let latest = this.latest;
      if (response.status === 404) {
        await response.body?.cancel();
        latest = null;
      } else if (response.status === 304 && this.checkedAt !== null) {
        await response.body?.cancel();
      } else if (response.status === 200) latest = await readRelease(response);
      else {
        await response.body?.cancel();
        throw Error(
          response.status === 403 || response.status === 429
            ? "UPDATE_RATE_LIMITED"
            : "UPDATE_UNAVAILABLE",
        );
      }
      if (this.closed) return;
      this.latest = latest;
      const etag = response.headers.get("etag");
      if (response.status !== 304)
        this.etag = etag && etag.length < 512 ? etag : null;
      this.checkedAt = this.now();
      this.error = null;
      this.failures = 0;
    } catch (error) {
      if (this.closed) return;
      this.error = ["UPDATE_RESPONSE_INVALID", "UPDATE_RATE_LIMITED"].includes(
        error.message,
      )
        ? error.message
        : "UPDATE_UNAVAILABLE";
      this.failures++;
    } finally {
      clearTimeout(timeout);
      if (!this.closed) {
        const delay = this.failures
          ? Math.min(interval, 300000 * 2 ** Math.min(this.failures - 1, 7))
          : interval;
        this.nextCheckAt = this.now() + delay;
        this.schedule(delay);
      }
    }
  }
  close() {
    this.closed = true;
    clearTimeout(this.timer);
    this.controller?.abort();
  }
}
