import { z } from "zod";

export const desktopHomePolicy = z
  .object({
    enabled: z.boolean().default(false),
    maxTurns: z.number().int().min(1).max(24).default(6),
    refreshMinutes: z.number().int().min(0).max(1440).default(60),
  })
  .strict()
  .prefault({});
