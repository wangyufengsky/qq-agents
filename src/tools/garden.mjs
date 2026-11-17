import { z } from "zod";
import { mediaLease } from "./media-lease.mjs";
import {
  gardenPauseReason,
  performGardenAction,
  subjectGardenView,
} from "../home/garden-console.mjs";
import {
  gardenPublicSnapshot,
  renderGardenSnapshot,
} from "../home/garden-public.mjs";
import { gardenDelegationScope } from "../home/garden-delegations.mjs";
import { DESKTOP_CONVERSATION } from "../home/desktop-decision.mjs";

export const gardenToolNames = ["garden_read", "garden_act"];
export function gardenPublicScope(conversation) {
  return (
    conversation === "@subject" ||
    conversation === DESKTOP_CONVERSATION ||
    /^(group|private):\d+$/.test(conversation || "")
  );
}

export const gardenDefinitions = {
  garden_read: [
    "查看小窝花园。默认是文字与九宫格状态，view=public 可显式读取可分享状态，view=image 同时生成基础图片。可分享文字为 text，可用本会话已有的 qq_send 发送 text、mediaId 或两者；读取不会发送。获准的主人格用 view=overview（或省略）查看经营详情。",
    z.strictObject({ view: z.string().min(1).max(40).optional() }),
  ],
  garden_act: [
    "经营花园或处理管理员私聊的浇水委托。管理员私聊明确委托时用 delegate_water={eventId,plot?}，eventId 填本轮已展示的原始来信记录 ID，省略 plot 表示给当前缺水的地浇水。用 delegate_status/delegate_cancel={delegationId} 回查或应明确要求撤回。主人格看到 garden-watering 收件后，用 delegate_step/delegate_dismiss={delegationId} 处理或放下。每步最多浇一块地，续作使用新 requestId。主人格也可以直接经营，每次一个动作，先调用 garden_read。kind=plant，args={plot,cropId,buyPrice?}，buyPrice 为缺种时同笔购买的单价；buy_seed={cropId,quantity,price}；buy_fertilizer={quantity,price}；water/fertilize/harvest/clear={plot,plantId}；sell={harvestId,quantity,price}；gift={harvestId,quantity,recipient:{kind,id}}。交易 price 是总价。requestId 唯一，同一动作重试用原 ID。",
    z.strictObject({
      requestId: z.string().regex(/^[A-Za-z0-9_-]{8,80}$/),
      kind: z.string().min(1).max(40),
      args: z.record(z.string(), z.unknown()),
    }),
  ],
};

const lastImage = new WeakMap();

function activeRead(runtime, ctx) {
  const role = runtime.assertActive(ctx);
  if (
    !gardenPublicScope(ctx.conversation) ||
    (ctx.runtimeKind && ctx.runtimeKind !== "desktop") ||
    ctx.desktopScreenObserved ||
    ctx.desktopPrivateObservation
  )
    throw Error("TOOL_DISABLED");
  if (!runtime.home.garden.initialized()) throw Error("GARDEN_NOT_INITIALIZED");
  return role;
}

async function gardenImage(runtime, ctx, snapshot, render) {
  const role = activeRead(runtime, ctx);
  const now = runtime.now();
  const fallback = (reason) => ({
    ...snapshot,
    imageAvailable: false,
    modelImageAttached: false,
    reason,
    notice: "花园图暂未生成；可分享本快照的文字。",
  });
  const perRole = lastImage.get(runtime) || new Map();
  lastImage.set(runtime, perRole);
  if (perRole.has(role.id) && now - perRole.get(role.id) < 5000)
    return fallback("GARDEN_IMAGE_BUSY");
  perRole.set(role.id, now);
  let buffer, saved;
  try {
    buffer = await render(snapshot, {
      signal: AbortSignal.any([
        ctx.controller.signal,
        AbortSignal.timeout(20_000),
      ]),
    });
    activeRead(runtime, ctx);
    saved = runtime.media.put(role.id, buffer, "image/png", {
      saved: true,
      kind: "garden-snapshot",
      title: "小窝花园",
      createdAt: snapshot.capturedAt,
    });
  } catch {
    activeRead(runtime, ctx);
    return fallback("GARDEN_IMAGE_UNAVAILABLE");
  }
  const backend = runtime.config.backends.find((b) => b.id === role.backendId);
  const modelImageAttached =
    backend?.type !== "openai" || backend.vision === true;
  const image = {
    ...snapshot,
    imageAvailable: true,
    modelImageAttached,
    mediaId: saved.id,
    mimeType: saved.mimeType,
    notice: "可以使用当前会话已有的发送工具与权限分享这张快照。",
  };
  if (!modelImageAttached) return image;
  return {
    [mediaLease]: () => {
      try {
        activeRead(runtime, ctx);
        return true;
      } catch {
        return false;
      }
    },
    content: [
      { type: "text", text: JSON.stringify(image) },
      { type: "image", mimeType: "image/png", data: buffer.toString("base64") },
    ],
  };
}

export function gardenTool(
  runtime,
  ctx,
  name,
  input,
  render = renderGardenSnapshot,
) {
  const role =
    name === "garden_read"
      ? activeRead(runtime, ctx)
      : runtime.assertActive(ctx);
  const garden = runtime.home.garden;
  const manages =
    ctx.conversation === "@subject" &&
    !ctx.runtimeKind &&
    !ctx.intentOnly &&
    !ctx.scheduleRunId &&
    ctx.turnId &&
    runtime.running.get(role.id + "|@subject") === ctx &&
    garden.allowsRole(role.id, runtime.home.generation(role.id));
  if (name === "garden_read") {
    const view = input.view ?? "overview";
    if (!["overview", "public", "image"].includes(view))
      throw Error("INVALID_REQUEST");
    if (view === "overview" && manages)
      return subjectGardenView(runtime, role.id, ctx.turnId);
    const now = runtime.now(),
      state = garden.snapshot(now);
    const snapshot = gardenPublicSnapshot(state, {
      now,
      running: state.running && !gardenPauseReason(runtime),
    });
    return view === "image"
      ? gardenImage(runtime, ctx, snapshot, render)
      : snapshot;
  }
  const delegations = runtime.home.gardenDelegations;
  if (gardenDelegationScope(ctx.conversation)) {
    if (input.kind === "delegate_water")
      return delegations.submit(ctx, input.requestId, input.args);
    if (["delegate_status", "delegate_cancel"].includes(input.kind))
      return delegations.origin(ctx, input.kind, input.args);
    throw Error("TOOL_DISABLED");
  }
  if (["delegate_step", "delegate_dismiss"].includes(input.kind))
    return delegations.execute(ctx, input.kind, input.requestId, input.args);
  if (!manages) throw Error("GARDEN_ROLE_UNAVAILABLE");
  runtime.home.rooms.shareable(ctx);
  if (Object.hasOwn(input.args, "kind")) throw Error("INVALID_REQUEST");
  return performGardenAction(
    runtime,
    { kind: "agent", id: role.id, turnId: ctx.turnId },
    { requestId: input.requestId, action: { ...input.args, kind: input.kind } },
  );
}
