// @ts-check
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { GameRegistry } from "../core/registry.mjs";
import { GameKernel } from "../core/kernel.mjs";
import { GameIdentity } from "../core/identity.mjs";
import { createGameHttp } from "../core/http.mjs";
import { registerGomoku } from "./module.mjs";
import { renderGomoku } from "./page.mjs";

/** @param {{database:string,clock?:()=>number}} options */
export function createGomokuFixture(options) {
  const registry = new GameRegistry();
  registerGomoku(registry);
  const kernel = new GameKernel({ ...options, registry, maxRooms: 8 }),
    identity = new GameIdentity(kernel);
  const assets = new Map(
    ["js", "css"].map((ext) => [
      `/game-gomoku.${ext}`,
      {
        type:
          ext === "js"
            ? "text/javascript; charset=utf-8"
            : "text/css; charset=utf-8",
        body: readFileSync(
          new URL(`../../../public/game-gomoku.${ext}`, import.meta.url),
        ),
      },
    ]),
  );
  const service = createGameHttp({
    kernel,
    identity,
    assets,
    render: renderGomoku,
    confirm(roomId, bindingId, challenge) {
      // The test harness owns these synthetic principals; production authentication is not simulated as QQ.
      const data = identity.load(roomId, bindingId);
      identity.confirm(
        roomId,
        bindingId,
        challenge,
        kernel.actor(data.principalId),
      );
    },
  });
  let origin = "";
  return {
    kernel,
    identity,
    async listen(port = 0) {
      const address = await service.listen(port);
      origin = address.origin;
      return address;
    },
    createRoom() {
      kernel.sweep();
      const owner = kernel.actor("fixture-owner"),
        created = kernel.createRoom(owner, {
          requestId: randomUUID(),
          gameType: "gomoku",
          moduleVersion: "1",
          options: {},
          participants: [
            { principalId: "fixture-owner", kind: "human", label: "黑方" },
            { principalId: "fixture-guest", kind: "human", label: "白方" },
          ],
        });
      const room = kernel.store.room(created.roomId);
      return {
        roomId: room.id,
        invitations: room.participants.map((/** @type {any} */ p) => {
          const invitation = identity.invite(room.id, owner, p.participantId);
          return {
            label: p.label,
            url: `${origin}/rooms/${room.id}?binding=${invitation.bindingId}&invite=${invitation.invite}`,
          };
        }),
      };
    },
    async close() {
      await service.close();
      kernel.close();
    },
  };
}
