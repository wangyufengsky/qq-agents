// @ts-check
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { createP0Server } from "../src/games/p0-server.mjs";

const { values } = parseArgs({
  options: {
    data: { type: "string" },
    port: { type: "string", default: "35821" },
    "public-origin": { type: "string" },
  },
});
if (!values.data || !path.isAbsolute(values.data))
  throw Error("DEDICATED_ABSOLUTE_DATA_REQUIRED");
const port = Number(values.port);
if (!Number.isInteger(port) || port < 1024 || port > 65535)
  throw Error("INVALID_PORT");
fs.mkdirSync(values.data, { recursive: true, mode: 0o700 });
const entries = fs.readdirSync(values.data);
const allowed = new Set([
  "p0.sqlite",
  "p0.sqlite-wal",
  "p0.sqlite-shm",
  "invitations.json",
  "p0-status.json",
]);
if (entries.some((name) => !allowed.has(name)))
  throw Error("P0_REQUIRES_DEDICATED_DIRECTORY");
process.umask(0o077);
const service = createP0Server({
  database: path.join(values.data, "p0.sqlite"),
  publicOrigin: values["public-origin"],
});
const address = await service.listen(port);
const invitations = [];
for (let i = 0; i < 2; i++) {
  try {
    invitations.push(service.createInvite());
  } catch (error) {
    // Capacity limits new invitations, not recovery of existing sessions.
    if (error instanceof Error && error.message === "ROOM_CAPACITY") break;
    await service.close();
    throw error;
  }
}
if (invitations.length)
  fs.writeFileSync(
    path.join(values.data, "invitations.json"),
    JSON.stringify(invitations, null, 2),
    { mode: 0o600 },
  );
fs.writeFileSync(
  path.join(values.data, "p0-status.json"),
  JSON.stringify(
    {
      pid: process.pid,
      ...address,
      challenge: service.challenge,
      externalProbeStatus: "unverified",
      startedAt: new Date().toISOString(),
    },
    null,
    2,
  ),
  { mode: 0o600 },
);
console.log(
  JSON.stringify({
    service: "qq-agents-game-p0",
    port,
    externalProbeStatus: "unverified",
    invitations: invitations.length
      ? "written-to-private-data-directory"
      : "no-new-invitations",
    invitationCount: invitations.length,
    invitationStatus: invitations.length === 2 ? "created" : "capacity-limited",
    expiresInMinutes: 15,
  }),
);
let closing = false;
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, async () => {
    if (closing) return;
    closing = true;
    await service.close();
  });
