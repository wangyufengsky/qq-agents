import { randomUUID } from "node:crypto";
import { z } from "zod";
import { mediaLease } from "./media-lease.mjs";
import {
  gardenPauseReason,
  performGardenAction,
  subjectGardenView,
  subjectGardenGifts,
} from "../home/garden-console.mjs";
import {
  gardenPublicSnapshot,
  gardenPlantSnapshot,
  renderGardenPlantSnapshot,
  renderGardenSnapshot,
} from "../home/garden-public.mjs";
import { gardenDelegationScope } from "../home/garden-delegations.mjs";
import { supportsMessageImages } from "../backends/capabilities.mjs";
import { DESKTOP_CONVERSATION } from "../home/desktop-decision.mjs";

export const gardenToolNames = ["garden_read", "garden_act"];
export function gardenPublicScope(conversation) {
  return (
    conversation === "@subject" ||
    conversation === DESKTOP_CONVERSATION ||
    /^(group|private):\d+$/.test(conversation || "")
  );
}

const gardenViews = [
  "overview",
  "public",
  "image",
  "timeline",
  "plant_history",
  "digest",
  "ack_digest",
  "plant",
  "plant_image",
  "gifts",
];

export const gardenDefinitions = {
  garden_read: [
    "查看小窝花园。public 读整园，image 生成整园图。timeline 可用 factId 查询具体记录，或按 fromDay、toDay、plot、type、cropId 和 limit 查年表，plant_history 按 plantId、plot 或 cropId 查手帐，可用 type 找最近一次照料。下一页沿用查询并填 cursor。digest 看自己还未读到的园内变化，不改变已读位置。取得 readToken 的主人格或获准经营的桌面角色确认看过便笺后，可在同一回合用 ack_digest 提交刚才返回的 readToken，确认自己当时看到的范围。plant 和 plant_image 用 plot、plantId 或 cropId 读单株；多个同种时请用返回的 plantId 选择。只有手帐事实支持时才断言时间、照料者或亲历。图像生成成功会返回 mediaId，可用本会话已有的 qq_send 或桌面聊天的 desktop_room_decide({action:'say',mediaId,text?}) 分享；再次分享原照用原 mediaId。读取不会发送或消耗经营次数。获准经营的主人格或在场桌面角色用 overview（或省略）查看经营详情；普通主人格或获准经营的桌面角色可用 gifts 查看礼物。",
    z.strictObject({
      view: z.string().min(1).max(40).meta({ enum: gardenViews }).optional(),
      plantId: z.string().uuid().optional(),
      plot: z.number().int().min(1).max(9).optional(),
      cropId: z.string().trim().min(1).max(60).optional(),
      factId: z.number().int().positive().safe().optional(),
      fromDay: z.number().int().positive().safe().optional(),
      toDay: z.number().int().positive().safe().optional(),
      type: z.string().min(1).max(60).optional(),
      actorId: z.string().min(1).max(64).optional(),
      limit: z.number().int().min(1).max(50).optional(),
      cursor: z.string().min(1).max(2048).optional(),
      readToken: z.string().uuid().optional(),
    }),
  ],
  garden_act: [
    '在获准的主人格或桌面回合经营花园，或处理管理员私聊的浇水委托。管理员私聊明确委托时用 {"requestId":"water-001","kind":"delegate_water","args":{"eventId":"来信记录ID"}}，可在 args 加 plot。eventId 填本轮已展示的原始来信记录 ID，省略 plot 表示给当前缺水的地浇水。以下动作名填 kind，括号内字段放入 args。用 delegate_status/delegate_cancel（delegationId）回查或应明确要求撤回。主人格看到 garden-watering 收件后，用 delegate_step/delegate_dismiss={delegationId} 处理或放下。每步最多浇一块地，续作使用新 requestId。主人格也可以直接经营，每次一个动作，用 garden_read 查看当前地块与价格。kind=plant，args={plot,cropId,buyPrice?}，buyPrice 为缺种时同笔购买的单价；buy_seed={cropId,quantity,price}；buy_fertilizer={quantity,price}；water/fertilize/harvest/clear={plot,plantId}；sell={harvestId,quantity,price}；gift={harvestId,quantity,recipient:{kind,id}}。事件、神秘种子、遮棚和礼物操作可从 overview 的 event.actions、mysteryPlantActions、地块 shelterAction 和 giftActions 获取对应 kind 与参数。display_gift 和 withdraw_gift 的 slot 可选第 1 至 16 格。交易 price 是总价。requestId 唯一，同一动作重试用原 ID。',
    z.strictObject({
      requestId: z.string().regex(/^[A-Za-z0-9_-]{8,80}$/),
      kind: z.string().min(1).max(40),
      args: z.record(z.string(), z.unknown()),
    }),
  ],
};

const lastImage = new WeakMap();
const shownDigests = new WeakMap();

function activeRead(runtime, ctx) {
  const role = runtime.assertActive(ctx);
  if (
    !gardenPublicScope(ctx.conversation) ||
    (ctx.runtimeKind && ctx.runtimeKind !== "desktop") ||
    (!ctx.desktopUnified &&
      (ctx.desktopScreenObserved || ctx.desktopPrivateObservation))
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
      title: snapshot.name || "小窝花园",
      conversation: ctx.conversation,
      gardenSnapshot: true,
      createdAt: snapshot.capturedAt,
    });
  } catch {
    activeRead(runtime, ctx);
    return fallback("GARDEN_IMAGE_UNAVAILABLE");
  }
  const backend = runtime.config.backends.find((b) => b.id === role.backendId);
  const modelImageAttached =
    !!backend && (supportsMessageImages(backend) || backend.vision === true);
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
  renderPlant = renderGardenPlantSnapshot,
) {
  const role =
    name === "garden_read"
      ? activeRead(runtime, ctx)
      : runtime.assertActive(ctx);
  const garden = runtime.home.garden;
  const subjectTurn = ctx.conversation === "@subject" && !ctx.runtimeKind;
  const desktopTurn =
    ctx.desktopUnified &&
    ctx.runtimeKind === "desktop" &&
    ctx.conversation === DESKTOP_CONVERSATION &&
    runtime.desktopVisits.live?.visits.has(role.id);
  const runningTurn =
    (subjectTurn || desktopTurn) &&
    !ctx.intentOnly &&
    !ctx.scheduleRunId &&
    ctx.turnId &&
    runtime.running.get(role.id + "|" + ctx.conversation) === ctx;
  const manages =
    runningTurn && garden.allowsRole(role.id, runtime.home.generation(role.id));
  if (name === "garden_read") {
    const { view = "overview", readToken, ...query } = input;
    if (readToken !== undefined && view !== "ack_digest")
      throw Error("INVALID_REQUEST");
    if (view === "gifts") {
      if ((!subjectTurn || ctx.intentOnly || ctx.scheduleRunId) && !manages)
        throw Error("TOOL_DISABLED");
      return subjectGardenGifts(runtime, role.id);
    }
    if (view === "overview" && manages)
      return subjectGardenView(runtime, role.id, ctx.turnId);
    if (!gardenViews.includes(view)) throw Error("INVALID_REQUEST");
    const publicView = !(runningTurn && (subjectTurn || manages));
    if (query.cropId) {
      const crops = garden.requireState().settings.crops;
      if (!Object.hasOwn(crops, query.cropId))
        query.cropId =
          Object.keys(crops).find((id) => crops[id].name === query.cropId) ??
          query.cropId;
    }
    switch (view) {
      case "timeline":
        if (publicView && query.actorId !== undefined)
          throw Error("INVALID_REQUEST");
        return garden.timeline(query, { publicView });
      case "plant_history":
        return garden.plantHistory(query, { publicView });
      case "digest":
      case "ack_digest": {
        const identity = {
          kind: "agent",
          id: role.id,
          generation: runtime.home.generation(role.id),
        };
        if (view === "ack_digest") {
          if (publicView) throw Error("TOOL_DISABLED");
          const shown = shownDigests.get(ctx);
          if (
            !shown ||
            shown.readToken !== readToken ||
            shown.turnId !== ctx.turnId ||
            shown.generation !== identity.generation
          )
            throw Error("INVALID_REQUEST");
          garden.ackDigest(identity, shown.through);
          return { acknowledged: true };
        }
        const { through, ...digest } = garden.digest(identity, { publicView });
        if (publicView) return digest;
        const token = randomUUID();
        // Bind confirmation to the observed watermark, before any later facts arrive.
        shownDigests.set(ctx, {
          readToken: token,
          through,
          generation: identity.generation,
          turnId: ctx.turnId,
        });
        return { ...digest, readToken: token };
      }
    }
    // Sharing observes the garden without running the clock's reward settlement.
    const isPlant = view === "plant" || view === "plant_image";
    if (isPlant && !query.plot && !query.plantId && !query.cropId)
      throw Error("INVALID_REQUEST");
    const now = runtime.now();
    const state = garden.observe(now);
    const running = state.running && !gardenPauseReason(runtime);
    if (isPlant) {
      const detail = garden.plantHistory(
        { plantId: query.plantId, plot: query.plot, cropId: query.cropId },
        { publicView: true },
      );
      const snapshot = gardenPlantSnapshot(state, detail, {
        now,
        running,
        plot: query.plot,
      });
      return view === "plant_image" && snapshot.plantId
        ? gardenImage(runtime, ctx, snapshot, renderPlant)
        : snapshot;
    }
    const snapshot = gardenPublicSnapshot(state, { now, running });
    return view === "image"
      ? gardenImage(runtime, ctx, snapshot, render)
      : {
          ...snapshot,
          imageRequest: {
            tool: "garden_read",
            arguments: { view: "image" },
            result: "mediaId",
          },
        };
  }
  const delegations = runtime.home.gardenDelegations;
  if (gardenDelegationScope(ctx.conversation)) {
    if (input.kind === "delegate_water")
      return delegations.submit(ctx, input.requestId, input.args);
    if (["delegate_status", "delegate_cancel"].includes(input.kind))
      return delegations.origin(ctx, input.kind, input.args);
    throw Error("TOOL_DISABLED");
  }
  if (subjectTurn && ["delegate_step", "delegate_dismiss"].includes(input.kind))
    return delegations.execute(ctx, input.kind, input.requestId, input.args);
  if (!manages) throw Error("GARDEN_ROLE_UNAVAILABLE");
  if (input.kind.startsWith("delegate_")) throw Error("TOOL_DISABLED");
  if (Object.hasOwn(input.args, "kind")) throw Error("INVALID_REQUEST");
  return performGardenAction(
    runtime,
    { kind: "agent", id: role.id, turnId: ctx.turnId },
    { requestId: input.requestId, action: { ...input.args, kind: input.kind } },
  );
}
