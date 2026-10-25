import fs from "node:fs";
import path from "node:path";
import { backup } from "node:sqlite";
import { MemoryStore } from "../src/memory/store.mjs";
import { inspectLegacy, importLegacy } from "../src/memory/migrate.mjs";
const args = process.argv.slice(2),
  get = (k) => args[args.indexOf(k) + 1];
if (!args.includes("--source") || !args.includes("--agent"))
  throw Error(
    "Usage: --source OLD_INSTANCE --agent STABLE_ID [--data NEW_DATA] [--legacy-db FILE --legacy-agent ID] [--apply]",
  );
const source = fs.realpathSync(get("--source")),
  root = path.resolve(args.includes("--data") ? get("--data") : ".runtime");
if (root === source || root.startsWith(source + path.sep))
  throw Error("DESTINATION_MUST_BE_SEPARATE");
if (fs.existsSync(path.join(root, "process.lock")))
  throw Error("STOP_DESTINATION_BEFORE_MIGRATING");
const plan = inspectLegacy(source, {
  legacyDb: args.includes("--legacy-db") ? get("--legacy-db") : undefined,
  legacyAgentId: args.includes("--legacy-agent")
    ? get("--legacy-agent")
    : undefined,
});
const summary = {
  mode: args.includes("--apply") ? "apply" : "dry-run",
  events: plan.events.length,
  legacyNotes: plan.notes.length,
  conversations: plan.states.length,
  warnings: plan.warnings,
};
if (args.includes("--apply")) {
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const file = path.join(root, "memory.sqlite"),
    existed = fs.existsSync(file);
  const store = new MemoryStore(file);
  try {
    if (existed) {
      const destination = path.join(root, `memory-${Date.now()}.backup.sqlite`);
      await backup(store.db, destination);
      fs.chmodSync(destination, 0o600);
    }
    summary.result = importLegacy(store.bind(get("--agent")), plan);
  } finally {
    store.close();
  }
}
console.log(JSON.stringify(summary, null, 2));
