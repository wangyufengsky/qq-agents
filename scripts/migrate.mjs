import fs from "node:fs";
import path from "node:path";
import { inspectLegacy } from "../src/memory/migrate.mjs";
import { applyMigration } from "../src/memory/migration-apply.mjs";
const args = process.argv.slice(2),
  get = (k) => args[args.indexOf(k) + 1];
if (!args.includes("--source") || !args.includes("--agent"))
  throw Error(
    "Usage: --source OLD_INSTANCE --agent STABLE_ID [--account QQ] --connection-map JSON [--subject-map JSON] [--export FILE ...] [--legacy-db FILE --legacy-agent ID] [--data NEW_DATA] [--apply]",
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
  aliasFile: args.includes("--message-aliases")
    ? get("--message-aliases")
    : undefined,
  aliasSourceFiles: args.flatMap((a, i) =>
    a === "--alias-source" ? [args[i + 1]] : [],
  ),
  connectionMap: args.includes("--connection-map")
    ? JSON.parse(fs.readFileSync(get("--connection-map"), "utf8"))
    : {},
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
  aliases: plan.aliases?.length || 0,
  legacyNotes: plan.notes.length,
  conversations: plan.states.length,
  coverage: plan.coverage,
  connectionId: plan.connectionBinding?.connectionId ?? null,
  rejected: plan.rejected,
  warnings: plan.warnings,
};
try {
  const targetConfig = args.includes("--target-config")
    ? get("--target-config")
    : path.join(root, "config.json");
  if (fs.existsSync(targetConfig) && plan.connectionBinding) {
    const cfg = JSON.parse(fs.readFileSync(targetConfig, "utf8")),
      binding = plan.connectionBinding;
    const agent = cfg.agents?.find((a) => a.id === plan.agentId),
      connection = cfg.connections?.find((c) => c.id === binding.connectionId);
    if (
      agent?.connectionId !== binding.connectionId ||
      String(connection?.accountId) !== binding.accountId
    )
      throw Error("TARGET_CONFIG_CONNECTION_MISMATCH");
    if (
      plan.aliases?.some(
        (a) => a.namespace !== (connection.messageIdNamespace || "onebot"),
      )
    )
      throw Error("TARGET_CONFIG_MESSAGE_NAMESPACE_MISMATCH");
    summary.targetConfigChecked = true;
  } else {
    if (args.includes("--target-config"))
      throw Error("TARGET_CONFIG_NOT_FOUND");
    summary.targetConfigChecked = false;
  }
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
