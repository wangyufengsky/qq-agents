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
    // Opponent name shown on the game page; empty falls back to the agent name.
    publicName: z.string().max(24).default(""),
    // "qq" serves this connection's own QQ avatar from the game origin; the page never sees the account.
    avatar: z.enum(["qq", "none"]).default("qq"),
    remarks: z.boolean().default(true),
    remarkStyle: z.string().max(500).default(""),
  })
  .prefault({});
