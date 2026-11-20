import {
  companionMode,
  sensitiveApplications,
} from "./companion-preferences.mjs";

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export function createPreferencesStore(directory) {
  const path = join(directory, "prototype-preferences.json");
  return {
    read() {
      try {
        return JSON.parse(readFileSync(path, "utf8"));
      } catch {
        return {};
      }
    },
    write(value) {
      mkdirSync(directory, { recursive: true });
      const next = `${path}.next`;
      writeFileSync(next, JSON.stringify(value));
      renameSync(next, path);
    },
  };
}

export const validSpriteSize = (value) =>
  Number.isInteger(value) && value >= 70 && value <= 300 && value % 5 === 0;

export const validIdleFrequency = (value) =>
  Number.isInteger(value) && value >= -2 && value <= 2;

export function readDesktopPreferences(store) {
  const saved = store.read();
  return {
    saved,
    spriteSize: validSpriteSize(saved.spriteSize) ? saved.spriteSize : 100,
    idleFrequency: validIdleFrequency(saved.idleFrequency)
      ? saved.idleFrequency
      : 0,
    selectedMode: companionMode(saved.companionMode) ?? "privacy",
    blockedApplications:
      sensitiveApplications(saved.sensitiveApplications) ?? [],
    positions: saved.positions ?? {},
    places: new Map(
      Object.entries(saved.places ?? {}).filter(
        ([, place]) =>
          place &&
          /^[a-f0-9]{64}$/.test(place.display) &&
          [place.x, place.y].every(Number.isSafeInteger),
      ),
    ),
    doorPosition: saved.doorPosition,
  };
}

export function writeDesktopPreferences(
  store,
  {
    spriteSize,
    idleFrequency,
    minutes,
    positions,
    doorPosition,
    selectedMode,
    blockedApplications,
    places,
  },
) {
  store.write({
    spriteSize,
    idleFrequency,
    minutes,
    positions,
    doorPosition,
    companionMode: selectedMode,
    sensitiveApplications: blockedApplications,
    places: Object.fromEntries(places),
  });
}
