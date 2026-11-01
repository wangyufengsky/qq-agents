// @ts-check
// This process imports neither bridge runtime nor management/QQ credentials.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { gameDatabase } from "./database.mjs";
import { createGameHttp } from "../core/http.mjs";
import { renderGame } from "./page.mjs";
import { secret, GameError } from "../core/value.mjs";
import { avatarPath, avatarType } from "./avatar.mjs";
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
/** @type {Map<string,string>} agentId -> served avatar path */
const avatars = new Map();
/** The bridge owns fetching; this process only revalidates bytes and serves them by hash.
 * @param {any} input */
function setAvatar(input) {
  if (typeof input?.agentId !== "string") return;
  const previous = avatars.get(input.agentId);
  avatars.delete(input.agentId);
  if (previous && ![...avatars.values()].includes(previous))
    assets.delete(previous);
  if (input.remove || typeof input.body !== "string") return;
  const body = Buffer.from(input.body, "base64"),
    type = avatarType(body);
  if (!type || type !== input.type || body.length > 262144) return;
  const path = avatarPath({ type, body });
  assets.set(path, { type, body });
  avatars.set(input.agentId, path);
}
/** Presentation sits beside the participant view, never inside rules state. @param {any} snapshot */
function decorate(snapshot) {
  /** @type {Record<string,string>} */
  const byParticipant = {};
  for (const p of kernel.store.room(snapshot.roomId).participants) {
    const path = p.agentId && avatars.get(p.agentId);
    if (path) byParticipant[p.participantId] = path;
  }
  return { ...snapshot, presentation: { avatars: byParticipant } };
}
/** @type {Map<string,(value:boolean)=>void>} */
const admissions = new Map();
/** @type {Map<string,(message:any)=>void>} */
const retries = new Map();
process.on("message", (/** @type {any} */ message) => {
  if (message?.retry) retries.get(message.retry)?.(message);
  if (message?.avatar) setAvatar(message.avatar);
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
  decorate,
  publicOrigin,
  publicJoin: true,
  authorize,
  retry: async (/** @type {string} */ roomId, /** @type {object} */ actor) => {
    if (!process.connected || retries.size >= 120)
      throw new GameError("GAME_SERVICE_UNAVAILABLE", 503);
    const principalId = kernel.access(
      kernel.store.room(roomId),
      actor,
    ).principal;
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        retries.delete(id);
        reject(new GameError("GAME_RETRY_TIMEOUT", 503));
      }, 2000);
      retries.set(id, (message) => {
        clearTimeout(timer);
        retries.delete(id);
        if (message.error)
          reject(
            new GameError(
              [
                "GAME_RETRY_LIMIT",
                "GAME_OUTCOME_UNKNOWN",
                "GAME_BUDGET_EXHAUSTED",
                "GAME_BACKEND_BUSY",
                "GAME_JOB_NOT_RUNNABLE",
              ].includes(message.error)
                ? message.error
                : "GAME_RETRY_UNAVAILABLE",
            ),
          );
        else resolve(message.result);
      });
      process.send?.({ retry: id, roomId, principalId });
    });
  },
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
