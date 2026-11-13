// @ts-check
import { z } from "zod";

const requestId = z.string().min(1).max(64);
export const legacyBodyActionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("state"), requestId }).strict(),
  z
    .object({
      type: z.literal("move"),
      requestId,
      target: z.enum(["door", "seat"]),
    })
    .strict(),
  z
    .object({
      type: z.literal("pose"),
      requestId,
      facing: z.enum(["left", "right"]),
    })
    .strict(),
  z.object({ type: z.literal("stop") }).strict(),
  z.object({ type: z.literal("status"), requestId }).strict(),
]);

const ref = z.string().min(1).max(64);
const coordinate = z.number().int().min(-1_000_000).max(1_000_000);
const dimension = z.number().int().positive().max(1_000_000);
const version = z.number().int().positive();
const rect = z
  .object({ x: coordinate, y: coordinate, width: dimension, height: dimension })
  .strict();
const facing = z.enum(["left", "right"]);
const posture = z.enum(["stand", "sit", "look"]);
const geometry = z.object({ displayRef: ref, bounds: rect }).strict();
const structuredTarget = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("corner"),
      displayRef: ref,
      corner: z.enum(["nw", "ne", "sw", "se"]),
    })
    .strict(),
  z.object({ type: z.literal("near-resident"), residentRef: ref }).strict(),
  z
    .object({
      type: z.literal("point"),
      displayRef: ref,
      x: coordinate,
      y: coordinate,
    })
    .strict(),
]);
const {
  options: [state, move, pose, stop, status],
} = legacyBodyActionSchema;
export const bodyActionSchema = z.union([
  state,
  stop,
  status,
  z.union([
    move,
    move.extend({ target: structuredTarget, layoutVersion: version }),
  ]),
  z.union([
    pose,
    z.object({ type: z.literal("pose"), requestId, pose: posture }).strict(),
  ]),
]);

const spaceSchema = z
  .object({
    layoutVersion: version,
    sampledAt: z.number().int().nonnegative(),
    displays: z
      .array(
        z
          .object({
            ref,
            workArea: rect,
            scaleFactor: z.number().positive().max(16),
          })
          .strict(),
      )
      .min(1)
      .max(16),
    door: geometry.optional(),
    self: geometry.extend({
      facing,
      pose: posture,
      action: z
        .object({
          kind: z.enum(["move", "pose"]),
          state: z.enum(["queued", "executing"]),
          destination: z
            .object({ displayRef: ref, x: coordinate, y: coordinate })
            .strict()
            .optional(),
        })
        .strict()
        .optional(),
    }),
    residents: z
      .array(geometry.extend({ ref, name: z.string().max(80).optional() }))
      .max(24),
  })
  .strict();

export const bodyClaimSchema = z
  .object({
    client: z.string().uuid(),
    roomEpoch: z.string().uuid(),
    commandId: z.string().uuid(),
    agentId: ref.optional(),
    visitId: z.string().uuid().optional(),
  })
  .strict();

export const bodyResultSchema = bodyClaimSchema
  .extend({
    finishedAt: z.number().int().nonnegative().optional(),
    result: z
      .object({
        status: z.enum(["completed", "cancelled", "failed"]),
        reason: z
          .enum([
            "manual-control",
            "stopped",
            "hidden",
            "inactive",
            "display-changed",
            "target-unavailable",
            "target-blocked",
            "stale-layout",
            "disconnect",
            "position-unconfirmed",
          ])
          .optional(),
        position: z
          .object({
            x: z.number().int(),
            y: z.number().int(),
            displayId: z.number().int(),
          })
          .strict()
          .optional(),
        facing: facing.optional(),
        space: spaceSchema.optional(),
      })
      .strict()
      .refine(({ status, reason, position }) =>
        status === "completed" ? Boolean(position) && !reason : Boolean(reason),
      ),
  })
  .strict();

export const bodyResultEvidenceSchema = bodyResultSchema.omit({ client: true });

export const bodyRecoveryPositionSchema = z
  .object({
    agentId: ref,
    x: coordinate,
    y: coordinate,
    displayId: z.number().int(),
  })
  .strict();
