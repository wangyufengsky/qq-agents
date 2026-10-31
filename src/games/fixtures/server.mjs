// @ts-check
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { GameRegistry } from "../core/registry.mjs";
import { GameKernel } from "../core/kernel.mjs";
import { GameIdentity } from "../core/identity.mjs";
import { createGameHttp, escapeHtml } from "../core/http.mjs";
import { registerChoiceProbe } from "./choice-probe.mjs";

/** @param {{database:string,clock?:()=>number}} options */
export function createP1aFixture(options) {
  const registry = new GameRegistry();
  registerChoiceProbe(registry);
  const kernel = new GameKernel({ ...options, registry, maxRooms: 8 }),
    identity = new GameIdentity(kernel);
  const assets = new Map(
    ["js", "css"].map((ext) => [
      `/game-p1a.${ext}`,
      {
        type:
          ext === "js"
            ? "text/javascript; charset=utf-8"
            : "text/css; charset=utf-8",
        body: readFileSync(
          new URL(`../../../public/game-p1a.${ext}`, import.meta.url),
        ),
      },
    ]),
  );
  const service = createGameHttp({
    kernel,
    identity,
    assets,
    render(snapshot, roomId) {
      return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>P1a 隐藏选择夹具</title><link rel="stylesheet" href="/game-p1a.css"><script src="/game-p1a.js" defer></script></head><body><main data-room="${escapeHtml(roomId)}"><h1>隐藏选择 · P1a</h1><p>仅本机的合成参与者测试，不连接 QQ 或模型。</p><p id="status" role="status">${snapshot ? "当前为非实时快照，开启脚本后同步。" : "请点击确认加入。"}</p><button id="join" ${snapshot ? "hidden" : ""}>确认加入</button><section id="game" ${snapshot ? "" : "hidden"}><pre id="snapshot">${snapshot ? escapeHtml(JSON.stringify(snapshot, null, 2)) : ""}</pre><div id="controls"></div><p>先选符号，再确认。另一人的选择会在双方完成后揭示。</p><button data-choice="sun">太阳</button><button data-choice="moon">月亮</button><button id="confirm" disabled>确认选择</button><button id="retry" hidden>查询待确认操作</button></section><noscript><p>脚本关闭时仅显示有权查看的快照，不能提交。<a href="/rooms/${roomId}">刷新快照</a></p></noscript></main></body></html>`;
    },
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
          gameType: "choice-probe",
          moduleVersion: "1",
          options: {},
          participants: [
            { principalId: "fixture-owner", kind: "human", label: "参与者 A" },
            { principalId: "fixture-guest", kind: "human", label: "参与者 B" },
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
