import { backupDatabase } from "../src/memory/backup.mjs";
const args = process.argv.slice(2),
  get = (k) => args[args.indexOf(k) + 1];
if (!args.includes("--source") || !args.includes("--destination"))
  throw Error(
    "Usage: --source SQLITE --destination NEW_SQLITE (also restores a backup into a new path)",
  );
console.log(
  JSON.stringify(await backupDatabase(get("--source"), get("--destination"))),
);
