// @ts-check
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { createGomokuFixture } from "../src/games/gomoku/server.mjs";

const { values } = parseArgs({
  options: {
    data: { type: "string" },
    port: { type: "string", default: "35823" },
  },
});
if (!values.data || !path.isAbsolute(values.data))
  throw Error("DEDICATED_ABSOLUTE_DATA_REQUIRED");
const port = Number(values.port);
if (!Number.isInteger(port) || port < 1024 || port > 65535)
  throw Error("INVALID_PORT");
process.umask(0o077);
fs.mkdirSync(values.data, { recursive: true, mode: 0o700 });
if (fs.lstatSync(values.data).isSymbolicLink())
  throw Error("DEDICATED_DIRECTORY_REQUIRED");
const dataRoot = values.data;
const allowed = new Set([
  "p1b.sqlite",
  "p1b.sqlite-wal",
  "p1b.sqlite-shm",
  "invitations.json",
]);
if (
  fs
    .readdirSync(values.data)
    .some(
      (name) =>
        !allowed.has(name) ||
        fs.lstatSync(path.join(dataRoot, name)).isSymbolicLink(),
    )
)
  throw Error("P1B_REQUIRES_DEDICATED_DIRECTORY");
const service = createGomokuFixture({
  database: path.join(values.data, "p1b.sqlite"),
});
await service.listen(port);
try {
  fs.writeFileSync(
    path.join(values.data, "invitations.json"),
    JSON.stringify(service.createRoom(), null, 2),
    { mode: 0o600 },
  );
} catch (error) {
  if (!(error instanceof Error) || error.message !== "ROOM_CAPACITY") {
    await service.close();
    throw error;
  }
}
console.log(
  JSON.stringify({
    service: "qq-agents-game-p1b-fixture",
    port,
    publicAccess: false,
    invitations: "private-data-directory",
  }),
);
const sweep = setInterval(() => service.kernel.sweep(), 1000);
sweep.unref();
let closing = false;
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, async () => {
    if (closing) return;
    closing = true;
    clearInterval(sweep);
    await service.close();
  });
