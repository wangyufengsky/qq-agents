import fs from "node:fs";
import path from "node:path";
import { inspectLegacy } from "../src/memory/migrate.mjs";
import { applyMigration } from "../src/memory/migration-apply.mjs";
const args = process.argv.slice(2),
  get = (k) => args[args.indexOf(k) + 1];
if (!args.includes("--source") || !args.includes("--agent"))
  throw Error(
    "Usage: --source OLD_INSTANCE --agent STABLE_ID [--account QQ] [--subject-map JSON] [--export FILE ...] [--legacy-db FILE --legacy-agent ID] [--data NEW_DATA] [--apply]",
  );
const source = fs.realpathSync(get("--source"));
function realDestination(p) {
  if (fs.existsSync(p)) return fs.realpathSync(p);
  return path.join(realDestination(path.dirname(p)), path.basename(p));
}
const root = realDestination(
  path.resolve(args.includes("--data") ? get("--data") : ".runtime"),
);
if (root === source || root.startsWith(source + path.sep))
  throw Error("DESTINATION_MUST_BE_SEPARATE");
if (fs.existsSync(path.join(root, "process.lock")))
  throw Error("STOP_DESTINATION_BEFORE_MIGRATING");
const legacyDb = args.includes("--legacy-db")
  ? fs.realpathSync(get("--legacy-db"))
  : undefined;
if (legacyDb && legacyDb === path.join(root, "memory.sqlite"))
  throw Error("DESTINATION_MUST_BE_SEPARATE");
const plan = inspectLegacy(source, {
  agentId: get("--agent"),
  accountId: args.includes("--account") ? get("--account") : undefined,
  subjectMap: args.includes("--subject-map")
    ? JSON.parse(fs.readFileSync(get("--subject-map"), "utf8"))
    : {},
  exportFiles: args.flatMap((a, i) => (a === "--export" ? [args[i + 1]] : [])),
  exportSourceId: args.includes("--export-source-id")
    ? get("--export-source-id")
    : undefined,
  sourceId: args.includes("--source-id") ? get("--source-id") : undefined,
  legacySourceId: args.includes("--legacy-source-id")
    ? get("--legacy-source-id")
    : undefined,
  legacyDb,
  legacyAgentId: args.includes("--legacy-agent")
    ? get("--legacy-agent")
    : undefined,
});
const summary = {
  mode: args.includes("--apply") ? "apply" : "dry-run",
  events: plan.events.length,
  legacyNotes: plan.notes.length,
  conversations: plan.states.length,
  coverage: plan.coverage,
  rejected: plan.rejected,
  warnings: plan.warnings,
};
try {
  if (args.includes("--apply"))
    summary.result = await applyMigration(
      path.join(root, "memory.sqlite"),
      plan,
    );
} catch (error) {
  summary.error = error.message;
  if (error.backup) summary.before = error.backup;
  process.exitCode = 1;
}
console.log(JSON.stringify(summary, null, 2));
