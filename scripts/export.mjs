import fs from "node:fs";
import path from "node:path";
import { MemoryStore } from "../src/memory/store.mjs";
import { restoreExport } from "../src/memory/migrate.mjs";
const args = process.argv.slice(2),
  get = (k) => args[args.indexOf(k) + 1];
if (
  !args.includes("--data") ||
  !args.includes("--agent") ||
  !args.includes("--file")
)
  throw Error(
    "Usage: --data DATA_DIR --agent AGENT_ID --file PRIVATE_EXPORT_JSON [--restore]",
  );
const root = path.resolve(get("--data"));
if (fs.existsSync(path.join(root, "process.lock")))
  throw Error("STOP_DESTINATION_BEFORE_EXPORT_OR_RESTORE");
const store = new MemoryStore(path.join(root, "memory.sqlite"));
try {
  const memory = store.bind(get("--agent"));
  if (args.includes("--restore")) {
    restoreExport(memory, JSON.parse(fs.readFileSync(get("--file"), "utf8")));
    console.log("Restored into empty database. Start paused.");
  } else {
    fs.writeFileSync(get("--file"), JSON.stringify(memory.export(), null, 2), {
      flag: "wx",
      mode: 0o600,
    });
    console.log(
      "Private export written. Referenced media remains in data directory/media; back it up separately.",
    );
  }
} finally {
  store.close();
}
