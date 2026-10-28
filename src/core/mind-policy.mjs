// @ts-check
import { SUBJECT_APP_TOOLS } from "../apps/policy.mjs";
import { z } from "zod";
/** @param {number} min @param {number} max @param {number} value */
const ms = (min, max, value) =>
  z.number().int().min(min).max(max).default(value);
const ids = z
  .array(z.string().regex(/^\d{1,20}$/))
  .max(500)
  .default([]);
export const selfPolicySchema = z
  .object({
    minorDelayMs: ms(0, 604800000, 21600000),
    majorDelayMs: ms(0, 2592000000, 86400000),
    maxBodyChars: ms(500, 16000, 6000),
  })
  .strict()
  .prefault({});
export const contextPolicySchema = z
  .object({
    capacityTokens: ms(4096, 2000000, 32768),
    reserveTokens: ms(1024, 100000, 4096),
    recoverRatio: z.number().min(0.2).max(0.7).default(0.6),
    hardRatio: z.number().min(0.8).max(0.98).default(0.9),
    idleMs: ms(1000, 86400000, 2700000),
    compactCooldownMs: ms(1000, 86400000, 300000),
  })
  .strict()
  .prefault({});
export const subjectPolicySchema = z
  .object({
    enabled: z.boolean().default(false),
    intervalMs: ms(60000, 86400000, 3600000),
    maxChecksPerDay: ms(1, 96, 6),
    maxContactsPerDay: ms(1, 100, 4),
    contactCooldownMs: ms(60000, 604800000, 3600000),
    unansweredCooldownMs: ms(60000, 2592000000, 86400000),
    // Each wake starts a new backend session; continuity comes from the
    // subject log and materials instead of an ever-growing transcript.
    sessionMode: z.enum(["fresh", "continuous"]).default("fresh"),
    maxToolCallsPerTurn: ms(1, 30, 8),
    offlineReview: z.boolean().default(false),
    reviewInSilence: z.boolean().default(true),
    groups: ids,
    users: ids,
    peers: z.boolean().default(true),
    owners: z.boolean().default(true),
    // Existing read adapters only; external_tool must additionally match an explicit allowlist.
    readTools: z
      .array(
        z.enum([
          ...SUBJECT_APP_TOOLS,
          "web_fetch",
          "web_screenshot",
          "image_save",
          "media_list",
          "file_download",
          "file_list",
          "sticker_read",
          "social_status",
          "social_search",
          "social_read",
          "social_comments",
          "external_tools",
          "external_tool",
        ]),
      )
      .default([]),
    externalReads: z
      .array(
        z
          .object({ serverId: z.string().min(1), tool: z.string().min(1) })
          .strict(),
      )
      .max(50)
      .default([]),
  })
  .strict()
  .prefault({});
