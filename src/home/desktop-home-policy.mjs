import { z } from "zod";

export const desktopHomePolicy = z
  .object({
    enabled: z.boolean().default(false),
    toolRoles: z.array(z.string().min(1).max(64)).max(64).default([]),
    screenView: z
      .object({ enabled: z.boolean().default(false) })
      .strict()
      .prefault({}),
    nativeControl: z
      .object({ enabled: z.boolean().default(false) })
      .strict()
      .prefault({}),
    browserControl: z
      .object({ enabled: z.boolean().default(false) })
      .strict()
      .prefault({}),
    maxTurns: z.number().int().min(1).max(24).default(6),
    refreshMinutes: z.number().int().min(0).max(1440).default(60),
    administratorQq: z
      .string()
      .regex(/^\d{1,20}$/)
      .optional(),
  })
  .strict()
  .prefault({});
