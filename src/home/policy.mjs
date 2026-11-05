// @ts-check
import { z } from "zod";
export const HOME_INTENT_TOOLS = Object.freeze([
  "room_intent_submit",
  "room_intent_list",
  "room_intent_resolve",
  "room_intent_cancel",
]);
export const HOME_READ_TOOLS = Object.freeze([
  "room_read",
  "room_scene_read",
  "room_operation_status",
]);
export const HOME_WRITE_TOOLS = Object.freeze([
  "room_scene_patch",
  "room_scene_undo",
  "room_publish",
  "room_retract",
]);
export const HOME_TOOLS = Object.freeze([
  ...HOME_INTENT_TOOLS,
  ...HOME_READ_TOOLS,
  ...HOME_WRITE_TOOLS,
]);
export const HOME_SLOTS = /** @type {const} */ ([
  "intro",
  "work-1",
  "work-2",
  "work-3",
]);
export const HOME_AUDIENCE = "instance-administrator-and-owner";
export const homePolicySchema = z
  .object({
    enabled: z.boolean().default(false),
    publishing: z.boolean().default(false),
    intents: z
      .object({
        enabled: z.boolean().default(false),
        hints: z.boolean().default(true),
        ttlDays: z.number().int().min(1).max(30).default(7),
        maxPending: z.number().int().min(1).max(100).default(20),
        maxSubmissionsPerDay: z.number().int().min(1).max(100).default(20),
      })
      .strict()
      .default({
        enabled: false,
        hints: true,
        ttlDays: 7,
        maxPending: 20,
        maxSubmissionsPerDay: 20,
      }),
    maxWritesPerDay: z.number().int().min(1).max(100).default(20),
  })
  .strict()
  .default({
    enabled: false,
    publishing: false,
    maxWritesPerDay: 20,
    intents: {
      enabled: false,
      hints: true,
      ttlDays: 7,
      maxPending: 20,
      maxSubmissionsPerDay: 20,
    },
  });
export const homeRevision = z
  .number()
  .int()
  .min(0)
  .max(Number.MAX_SAFE_INTEGER - 1);
export const homeRequestId = z.string().regex(/^[A-Za-z0-9_-]{8,80}$/);
export const homeGeneration = z
  .string()
  .uuid()
  .describe(
    "使用本次 room_read / room_scene_read 返回的 identityGeneration，旧身份代次不可重用。",
  );
const override = z
  .object({
    asset: z.string().max(64).optional(),
    assetVersion: z.number().int().positive().optional(),
    dx: z.number().min(-6).max(6).optional(),
    dy: z.number().min(-5).max(5).optional(),
    scale: z.number().min(0.8).max(1.15).optional(),
    z: z.number().int().min(1).max(8).optional(),
    hidden: z.boolean().optional(),
    flip: z.boolean().optional(),
  })
  .strict();
export const homePatch = z
  .array(
    z.discriminatedUnion("action", [
      z
        .object({
          action: z.literal("palette"),
          palette: z.enum(["cream", "blue", "rose"]),
        })
        .strict(),
      z
        .object({
          action: z.literal("object"),
          instanceId: z.string().min(1).max(64),
          value: override,
        })
        .strict(),
      z
        .object({
          action: z.literal("reset-object"),
          instanceId: z.string().min(1).max(64),
        })
        .strict(),
    ]),
  )
  .min(1)
  .max(24);
