// @ts-check
// This process imports neither bridge runtime nor management/QQ credentials.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { gameDatabase } from "./database.mjs";
import { createGameHttp } from "../core/http.mjs";
import { renderGame } from "./page.mjs";
import { secret } from "../core/value.mjs";
const [database, port, publicOrigin = ""] = process.argv.slice(2);
const { kernel, identity } = gameDatabase({ database });
const boot = secret(),
  challenge = secret();
kernel.store.db
  .prepare("INSERT OR REPLACE INTO game_entry VALUES(1,?)")
  .run(JSON.stringify({ boot, challenge, verified: false, publicOrigin }));
const assets = new Map(
  [
    ["/game-play.js", "text/javascript"],
    ["/game-play.css", "text/css"],
  ].map(([name, type]) => [
    name,
    {
      type,
      body: readFileSync(new URL("../../../public" + name, import.meta.url)),
    },
  ]),
);
/** @type {Map<string,(value:boolean)=>void>} */
const admissions = new Map();
process.on("message", (/** @type {any} */ message) => {
  if (message?.admission)
    admissions.get(message.admission)?.(message.allowed === true);
});
/** The bridge rechecks the source policy on every request; a live child is not authorization. @param {string} roomId */
async function authorize(roomId) {
  if (!process.connected || admissions.size >= 120) return false;
  const id = randomUUID();
  return new Promise((resolve) => {
    const timer = setTimeout(() => finish(false), 2000);
    const finish = (/** @type {boolean} */ allowed) => {
      clearTimeout(timer);
      admissions.delete(id);
      resolve(allowed);
    };
    admissions.set(id, finish);
    process.send?.({ admission: id, roomId });
  });
}
const http = createGameHttp({
  kernel,
  identity,
  assets,
  render: renderGame,
  publicOrigin,
  publicJoin: true,
  authorize,
  health: () => ({ service: "qq-agents-games", boot, challenge }),
});
await http.listen(Number(port));
process.send?.({ ready: true, boot });
const stop = async () => {
  await http.close();
  kernel.close();
  process.exit(0);
};
process.on("disconnect", () => void stop());
process.on("SIGTERM", () => void stop());
