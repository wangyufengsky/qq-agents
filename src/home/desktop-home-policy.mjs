import { z } from "zod";

// An absent list preserves installations that previously inherited P2 roles.
export const observationRoles = (policy) =>
  policy.observationRoles ?? policy.activityRoles;

export const desktopHomePolicy = z
  .object({
    enabled: z.boolean().default(false),
    toolRoles: z.array(z.string().min(1).max(64)).max(64).default([]),
    autonomousObservation: z.boolean().default(false),
    observationRoles: z.array(z.string().min(1).max(64)).max(64).optional(),
    observationRetentionDays: z.number().int().min(1).max(30).default(7),
    activityRoles: z.array(z.string().min(1).max(64)).max(64).default([]),
    bodyControlRoles: z.array(z.string().min(1).max(64)).max(64).default([]),
    interactionsEnabled: z.boolean().default(false),
    residentPreferences: z
      .record(
        z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/),
        z
          .object({
            quiet: z.boolean().optional(),
            activityMinutes: z.number().int().min(2).max(30).optional(),
          })
          .strict(),
      )
      .default({}),
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
