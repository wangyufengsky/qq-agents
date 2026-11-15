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
