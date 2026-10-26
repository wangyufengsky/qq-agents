import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  dshHomeDir,
  looksLikeDsh,
  dshBaseUrlCandidates,
  listDesktopListenPorts,
} from "../../vendor/dsh-qq/dsh-endpoint.mjs";

const exec = promisify(execFile);
export function parseDshListeners(text) {
  let pid, command;
  const rows = [];
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith("p")) pid = Number(line.slice(1));
    if (line.startsWith("c")) command = line.slice(1);
    const m = /^n(?:127\.0\.0\.1|localhost|\[::1\]):(\d+)$/.exec(line);
    if (m && pid > 0 && command?.startsWith("DeepSeek"))
      rows.push({ pid, url: `http://127.0.0.1:${Number(m[1])}` });
  }
  return rows;
}
async function listeners() {
  const fallback = async () => {
    const ports = await listDesktopListenPorts();
    return [
      ...new Set([
        ...ports.map((p) => `http://127.0.0.1:${p}`),
        ...dshBaseUrlCandidates(),
      ]),
    ].map((url) => ({ pid: null, url }));
  };
  if (process.platform !== "darwin") return fallback();
  try {
    const { stdout } = await exec(
      "/usr/sbin/lsof",
      ["-nP", "-iTCP", "-sTCP:LISTEN", "-a", "-c", "DeepSeek", "-Fpcn"],
      { timeout: 3000, maxBuffer: 1024 * 1024 },
    );
    const rows = parseDshListeners(stdout);
    return rows.length ? rows : fallback();
  } catch {
    return fallback();
  }
}
async function json(file) {
  const stat = await fs.stat(file);
  if (stat.size > 65536) throw Error("DSH_DESCRIPTOR_INVALID");
  return JSON.parse(await fs.readFile(file, "utf8"));
}
export function localDshUrl(value) {
  const u = new URL(value);
  if (
    u.protocol !== "http:" ||
    !["127.0.0.1", "localhost", "[::1]"].includes(u.hostname) ||
    u.username ||
    u.password ||
    u.search ||
    u.hash ||
    u.pathname !== "/"
  )
    throw Error("DSH_ENDPOINT_INVALID");
  return u.origin;
}
// Read published routing metadata, never Relay credentials or conversation data.
export async function discoverDshInstances({
  home = dshHomeDir(),
  list = listeners,
  probe = looksLikeDsh,
  configuredUrl,
} = {}) {
  const live = await list(),
    result = [],
    claimed = new Set();
  const base = path.join(home, "plugins", "dsh-relay");
  let profiles = [];
  try {
    profiles = await fs.readdir(base);
  } catch {}
  for (const profile of profiles.sort()) {
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(profile)) continue;
    try {
      const dir = path.join(base, profile);
      const [endpoint, status] = await Promise.all([
        json(path.join(dir, "relay-endpoint.json")),
        json(path.join(dir, "relay-status.json")),
      ]);
      const url = localDshUrl(endpoint.hostWebUrl);
      if (
        endpoint.mode !== "embedded" ||
        status.mode !== "embedded" ||
        status.state !== "ready" ||
        endpoint.authorityId !== status.authorityId ||
        endpoint.ownerEpoch !== status.ownerEpoch ||
        path.resolve(status.dshHome || "") !== path.resolve(home) ||
        !live.some((x) => x.pid === status.ownerPid && x.url === url) ||
        !(await probe(url))
      )
        continue;
      result.push({
        id: "relay:" + profile,
        label: "桌面 DSH · " + profile,
        url,
        pid: status.ownerPid,
        startedAt: status.processStartedAt,
        home,
        followsRestart: true,
      });
      claimed.add(url);
    } catch {
      /* An unpublished/stale descriptor is not a candidate. */
    }
  }
  const urls = new Map(live.map((x) => [x.url, x.pid]));
  if (configuredUrl)
    urls.set(localDshUrl(configuredUrl), urls.get(localDshUrl(configuredUrl)));
  for (const [url, pid] of urls) {
    if (claimed.has(url) || !(await probe(url))) continue;
    result.push({
      id: "endpoint:" + url,
      label: "DSH · " + new URL(url).port,
      url,
      pid: pid || null,
      followsRestart: false,
    });
  }
  return result;
}
export function selectDshInstance(
  config,
  candidates,
  selectedId,
  { automatic = false } = {},
) {
  const binding = selectedId || config.recovery?.dshInstance;
  if (binding) {
    const selected = candidates.find((x) => x.id === binding);
    if (!selected) throw Error("DSH_INSTANCE_UNAVAILABLE");
    return selected;
  }
  const configured =
    config.baseUrl &&
    candidates.find((x) => x.url === config.baseUrl.replace(/\/$/, ""));
  if (configured) return configured;
  if (automatic && config.baseUrl) throw Error("DSH_SELECTION_REQUIRED");
  if (candidates.length > 1) throw Error("DSH_SELECTION_REQUIRED");
  if (!candidates.length) throw Error("DSH_NOT_FOUND");
  return candidates[0];
}
export async function resolveDshInstance(config) {
  // An explicit endpoint stays explicit until the administrator chooses an instance.
  if (!config.recovery?.dshInstance && config.baseUrl) {
    const url = localDshUrl(config.baseUrl);
    if (!(await looksLikeDsh(url))) throw Error("DSH_NOT_FOUND");
    return { url };
  }
  return selectDshInstance(config, await discoverDshInstances());
}
