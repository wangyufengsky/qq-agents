// @ts-check
import { z } from "zod";
import { actionSchema } from "../core/kernel.mjs";
const roomId = z.uuid(),
  requestId = z.uuid();
export const gameDefinitions = {
  game_create: [
    "为当前会话中明确说‘下五子棋’的真实 QQ 来信者创建一人一 AI 房间；eventId 必须是该来信；邀请由框架直接投递，工具不返回私密链接。",
    z.strictObject({
      eventId: z.string().max(128),
      requestId,
      gameType: z.literal("gomoku"),
      options: z.strictObject({}),
    }),
  ],
  game_view: [
    "读取本角色在指定游戏房间中的参与者视图。",
    z.strictObject({ roomId }),
  ],
  game_act: [
    "仅独立游戏执行范围可提交动作，聊天回合不可调用。",
    actionSchema.extend({ roomId }),
  ],
  game_close: [
    "结束当前会话关联房间，不计作任何一方获胜；相同 requestId 使用首次动作和版本。",
    z.strictObject({ roomId, requestId }),
  ],
};
/** @param {any} runtime @param {any} ctx @param {string} name @param {any} args */
export function gameTool(runtime, ctx, name, args) {
  if (name === "game_create") return runtime.games.create(ctx, args);

  if (name === "game_close") return runtime.games.closeRoom(ctx, args);
  throw Error("GAME_EXECUTION_REQUIRED");
}
