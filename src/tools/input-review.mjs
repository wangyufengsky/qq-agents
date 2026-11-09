// @ts-check
import { z } from "zod";

export const inputReviewSchema = z
  .object({
    token: z.string().regex(/^[a-f0-9]{64}$/),
    decision: z.literal("continue"),
    unrelated: z
      .array(
        z
          .object({
            id: z.string().min(1).max(200),
            reason: z.string().trim().min(1).max(160),
          })
          .strict(),
      )
      .max(20)
      .optional(),
  })
  .strict()
  .describe(
    "Only after complete reading and a deliberate decision to send these exact contents, copy the current preparation.token for qq_draft, or the compatibility review token for a non-draft action. In ordinary group chats you may name reviewed unrelated input IDs and their reasons.",
  )
  .optional();
