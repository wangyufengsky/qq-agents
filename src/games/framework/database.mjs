// @ts-check
import { GameRegistry } from "../core/registry.mjs";
import { GameKernel } from "../core/kernel.mjs";
import { GameIdentity } from "../core/identity.mjs";
import { registerGomokuP2 } from "./module.mjs";
import { GameJobs } from "./jobs.mjs";
/** @param {{database:string,clock?:()=>number,maxRooms?:number,maxHistoryRooms?:number,gate?:(job:any)=>string|null,limits?:any}} options */
export function gameDatabase({
  database,
  clock = Date.now,
  maxRooms = 32,
  maxHistoryRooms = 256,
  gate,
  limits,
}) {
  const registry = new GameRegistry();
  registerGomokuP2(registry);
  const kernel = new GameKernel({
    database,
    registry,
    clock,
    maxRooms,
    maxHistoryRooms,
    allow: (_principal, roomId) => {
      const row = kernel.store.db
        .prepare("SELECT data FROM game_host_rooms WHERE id=?")
        .get(roomId);
      if (!row) return true;
      const source = JSON.parse(String(row.data));
      return source.access === true && source.accessUntil > clock();
    },
  });
  kernel.store.db
    .exec(`CREATE TABLE IF NOT EXISTS game_host_rooms(id TEXT PRIMARY KEY,data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS game_host_requests(id TEXT PRIMARY KEY,data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS game_entry(id INTEGER PRIMARY KEY CHECK(id=1),data TEXT NOT NULL);`);
  const identity = new GameIdentity(kernel, {
      dualConfirmation: true,
      isPublicRoom: (id) => {
        const row = kernel.store.db
          .prepare("SELECT data FROM game_host_rooms WHERE id=?")
          .get(id);
        return !!row && JSON.parse(String(row.data)).group === true;
      },
    }),
    jobs = new GameJobs(kernel, { gate, limits });
  return { kernel, identity, jobs };
}
