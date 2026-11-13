// @ts-check
import { z } from "zod";

const requestId = z.string().min(1).max(64);
export const bodyActionSchema = z.discriminatedUnion("type", [
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

export const bodyClaimSchema = z
  .object({
    client: z.string().uuid(),
    roomEpoch: z.string().uuid(),
    commandId: z.string().uuid(),
  })
  .strict();

export const bodyResultSchema = bodyClaimSchema
  .extend({
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
        facing: z.enum(["left", "right"]).optional(),
      })
      .strict()
      .refine(({ status, reason, position }) =>
        status === "completed" ? Boolean(position) && !reason : Boolean(reason),
      ),
  })
  .strict();
