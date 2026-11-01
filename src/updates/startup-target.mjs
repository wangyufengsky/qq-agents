// @ts-check
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { FrameworkKnowledge } from "../core/framework-knowledge.mjs";
import { finalPhases } from "./manager.mjs";
import { readState, updateDirectory } from "./installation.mjs";
import { compareVersions } from "./releases.mjs";

/** Preflight and the supervisor must validate and select the same release without changing update state.
 * @param {{root:string,bundledRoot?:string,recover?:boolean}} options */
export function resolveManagedStartup({
  root,
  bundledRoot = fileURLToPath(new URL("../..", import.meta.url)),
  recover = false,
}) {
  const home = path.join(root, updateDirectory);
  for (const directory of [root, home])
    if (fs.existsSync(directory) && fs.lstatSync(directory).isSymbolicLink())
      throw Error("UPDATE_DATA_LINK_UNSUPPORTED");
  /** @param {string} file */
  const readStartupState = (file) => {
    try {
      return readState(file);
    } catch {
      throw Error("UPDATE_STATE_INVALID");
    }
  };
  const identity = new FrameworkKnowledge({ root: bundledRoot }).version;
  const bundled = {
    codeRoot: bundledRoot,
    commit: identity.commit,
    version: identity.packageVersion,
  };
  /** @param {any} value @param {boolean} [allowBundledReplacement] */
  const validInstallation = (value, allowBundledReplacement = false) => {
    if (
      !value ||
      typeof value.codeRoot !== "string" ||
      !fs.existsSync(value.codeRoot)
    )
      throw Error("UPDATE_STATE_INVALID");
    const resolved = fs.realpathSync(value.codeRoot);
    if (
      resolved !== fs.realpathSync(bundledRoot) &&
      !resolved.startsWith(
        fs.realpathSync(home) + path.sep + "releases" + path.sep,
      )
    )
      throw Error("UPDATE_STATE_INVALID");
    // A replaced bundle may advance, but interrupted transactions retain exact recorded identities.
    if (
      allowBundledReplacement &&
      resolved === fs.realpathSync(bundledRoot) &&
      compareVersions(bundled.version, value.version) === 1
    )
      return bundled;
    const actual = new FrameworkKnowledge({ root: resolved }).version;
    if (
      actual.commit !== value.commit ||
      actual.packageVersion !== value.version
    )
      throw Error("UPDATE_STATE_INVALID");
    return { ...value, codeRoot: resolved };
  };
  const pointer = path.join(home, "current.json"),
    journal = path.join(home, "transaction.json");
  const previous = fs.existsSync(journal)
    ? readStartupState(journal)
    : { phase: "idle" };
  const interrupted =
    !finalPhases.has(previous.phase) || previous.phase === "recovery-required";
  let current = fs.existsSync(pointer)
    ? validInstallation(readStartupState(pointer), !interrupted)
    : bundled;
  if (interrupted) {
    if (!recover) throw Error("UPDATE_RECOVERY_REQUIRED");
    current = validInstallation(
      previous.committing ? previous.to : previous.from,
    );
    if (
      !previous.committing &&
      previous.backupReady &&
      previous.backup !== path.join(home, `backup-${previous.id}`)
    )
      throw Error("UPDATE_STATE_INVALID");
  }
  const replacePointer =
    !interrupted &&
    ((current === bundled && fs.existsSync(pointer)) ||
      compareVersions(bundled.version, current.version) === 1);
  if (replacePointer) current = bundled;
  return {
    current,
    bundled,
    previous,
    interrupted,
    pointer,
    journal,
    replacePointer,
  };
}
