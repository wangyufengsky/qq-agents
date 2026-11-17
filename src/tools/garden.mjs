import { z } from "zod";
import {
  performGardenAction,
  subjectGardenView,
} from "../home/garden-console.mjs";

export const gardenToolNames = ["garden_read", "garden_act"];
export const gardenDefinitions = {
  garden_read: [
    "查看共享花园九宫格、库存、集市价格和优先照料提示。先看状态和本轮剩余次数，再决定是否行动。view 可省略。",
    z.strictObject({ view: z.string().min(1).max(40).optional() }),
  ],
  garden_act: [
    "在当前主人格回合经营花园，每次一个动作，先调用 garden_read。kind=plant，args={plot,cropId,buyPrice?}，buyPrice 为缺种时同笔购买的单价；buy_seed={cropId,quantity,price}；buy_fertilizer={quantity,price}；water/fertilize/harvest/clear={plot,plantId}；sell={harvestId,quantity,price}；gift={harvestId,quantity,recipient:{kind,id}}。交易 price 是总价。requestId 唯一，同一动作重试用原 ID。",
    z.strictObject({
      requestId: z.string().regex(/^[A-Za-z0-9_-]{8,80}$/),
      kind: z.string().min(1).max(40),
      args: z.record(z.string(), z.unknown()),
    }),
  ],
};

export function gardenTool(runtime, ctx, name, input) {
  const role = runtime.assertActive(ctx);
  const garden = runtime.home.garden;
  if (
    ctx.conversation !== "@subject" ||
    ctx.runtimeKind ||
    ctx.intentOnly ||
    ctx.scheduleRunId ||
    !ctx.turnId ||
    runtime.running.get(role.id + "|@subject") !== ctx ||
    !garden.allowsRole(role.id, runtime.home.generation(role.id))
  )
    throw Error("GARDEN_ROLE_UNAVAILABLE");
  if (name === "garden_read") {
    if (input.view !== undefined && input.view !== "overview")
      throw Error("INVALID_REQUEST");
    return subjectGardenView(runtime, role.id, ctx.turnId);
  }
  runtime.home.rooms.shareable(ctx);
  if (Object.hasOwn(input.args, "kind")) throw Error("INVALID_REQUEST");
  return performGardenAction(
    runtime,
    { kind: "agent", id: role.id, turnId: ctx.turnId },
    { requestId: input.requestId, action: { ...input.args, kind: input.kind } },
  );
}
