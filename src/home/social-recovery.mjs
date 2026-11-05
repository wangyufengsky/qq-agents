// @ts-check
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { acquireProcessLock } from "../core/process-lifecycle.mjs";
import { SocialStore } from "./social-store.mjs";

/** Apply only to an offline restored dataset, before any runtime can serve it.
 * Configuration is disabled first so an interrupted database barrier fails closed.
 * @param {string} dataRoot
 * @param {{retentionDays:number,clock?:()=>number,recoveryEpoch?:string}} options */
export function prepareSocialRecovery(
  dataRoot,
  { retentionDays, clock = Date.now, recoveryEpoch = randomUUID() },
) {
  if (
    !Number.isInteger(retentionDays) ||
    retentionDays < 1 ||
    retentionDays > 365
  )
    throw Error("SOCIAL_RETENTION_INVALID");
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(recoveryEpoch))
    throw Error("SOCIAL_RECOVERY_EPOCH_REQUIRED");
  const root = path.resolve(dataRoot);
  if (fs.existsSync(path.join(root, "process.lock")))
    throw Error("STOP_DESTINATION_BEFORE_SOCIAL_RECOVERY");
  const lock = acquireProcessLock(root);
  try {
    const configFile = path.join(root, "config.json");
    const databaseFile = path.join(root, "memory.sqlite");
    // Refuse missing inputs and links: this command must never create an empty restore.
    let configText;
    try {
      for (const file of [configFile, databaseFile])
        if (!fs.lstatSync(file).isFile())
          throw Error("SOCIAL_RECOVERY_INPUT_INVALID");
      configText = fs.readFileSync(configFile, "utf8");
    } catch {
      // Native filesystem errors contain destination paths.
      throw Error("SOCIAL_RECOVERY_INPUT_INVALID");
    }
    let config;
    try {
      config = JSON.parse(configText);
    } catch {
      // SyntaxError messages can include fragments of private configuration.
      throw Error("SOCIAL_RECOVERY_CONFIG_INVALID");
    }
    if (!config || typeof config !== "object" || !Array.isArray(config.agents))
      throw Error("SOCIAL_RECOVERY_CONFIG_INVALID");
    const now = clock();
    if (!Number.isSafeInteger(now) || now < 0)
      throw Error("SOCIAL_CLOCK_INVALID");
    const db = new DatabaseSync(databaseFile);
    try {
      if (
        db.prepare("PRAGMA integrity_check").get()?.integrity_check !== "ok" ||
        db.prepare("PRAGMA foreign_key_check").all().length
      )
        throw Error("SOCIAL_RECOVERY_INTEGRITY_FAILED");
      const temp = configFile + ".social-recovery-" + randomUUID();
      try {
        fs.writeFileSync(
          temp,
          JSON.stringify(
            {
              ...config,
              globalPaused: true,
              homeSocial: {
                ...config.homeSocial,
                enabled: false,
                exchangeEnabled: false,
              },
            },
            null,
            2,
          ) + "\n",
          { flag: "wx", mode: 0o600 },
        );
        fs.renameSync(temp, configFile);
      } finally {
        fs.rmSync(temp, { force: true });
      }
      const store = new SocialStore(db, { clock: () => now });
      const result = store.invalidateRestoredAuthority({ recoveryEpoch });
      const previousRetention = config.homeSocial?.retentionDays;
      const effectiveRetention =
        Number.isInteger(previousRetention) && previousRetention >= 1
          ? Math.min(previousRetention, retentionDays)
          : retentionDays;
      const cleared = store.pruneBodies({
        before: Math.max(0, now - effectiveRetention * 86400000),
      });
      return {
        ...result,
        recoveryEpoch,
        paused: true,
        integrity: "ok",
        cleared,
      };
    } finally {
      db.close();
    }
  } finally {
    lock.release();
  }
}
