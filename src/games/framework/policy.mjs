// @ts-check
import { z } from "zod";
export const gamePolicy = z
  .strictObject({
    enabled: z.boolean().default(false),
    port: z.number().int().min(1024).max(65535).default(35824),
    publicOrigin: z
      .string()
      .default("")
      .refine((value) => {
        if (!value) return true;
        try {
          const u = new URL(value);
          return (
            u.protocol === "https:" &&
            !u.username &&
            !u.password &&
            u.origin === value
          );
        } catch {
          return false;
        }
      }, "Use an exact HTTPS origin"),
    maxRooms: z.number().int().min(1).max(128).default(32),
    maxHistoryRooms: z.number().int().min(1).max(4096).default(256),
    maxAttemptsPerRoom: z.number().int().min(1).max(256).default(128),
    maxAttemptsPerAgent: z.number().int().min(1).max(1024).default(256),
    maxAttemptsTotal: z.number().int().min(1).max(4096).default(512),
    reservedTokensPerAttempt: z
      .number()
      .int()
      .min(1024)
      .max(262144)
      .default(32768),
    maxTokensPerRoom: z.number().int().min(1024).max(67108864).default(4194304),
    maxTokensPerAgent: z
      .number()
      .int()
      .min(1024)
      .max(134217728)
      .default(8388608),
    maxTokensTotal: z.number().int().min(1024).max(268435456).default(16777216),
    turnTimeoutMs: z.number().int().min(1000).max(600000).default(120000),
  })
  .prefault({});
export const agentGamePolicy = z
  .strictObject({
    enabled: z.boolean().default(false),
    publicPersona: z.string().max(2000).default(""),
  })
  .prefault({});
