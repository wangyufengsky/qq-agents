// @ts-check
import { z } from "zod";
import { APP_NAMES } from "./urls.mjs";
// Runtime-state key of the per-agent read ledger (daily read budget).
export const APP_LEDGER = "internal:app-browsing";
const time = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/);
export const appsPolicySchema = z
  .object({
    enabled: z.boolean().default(true),
    sharing: z.boolean().default(true),
    platforms: z
      .array(z.enum(APP_NAMES))
      .max(5)
      .default(() => [...APP_NAMES]),
    maxReadsPerDay: z.number().int().min(1).max(200).default(30),
    maxReadsPerTurn: z.number().int().min(1).max(30).default(6),
    maxSharesPerDay: z.number().int().min(1).max(30).default(3),
    hours: z
      .object({
        enabled: z.boolean().default(true),
        scope: z.enum(["autonomous", "all"]).default("autonomous"),
        start: time.default("09:00"),
        end: time.default("22:00"),
        timezone: z
          .string()
          .refine((v) => {
            try {
              new Intl.DateTimeFormat("en", { timeZone: v });
              return true;
            } catch {
              return false;
            }
          }, "INVALID_TIMEZONE")
          .default("Asia/Shanghai"),
      })
      .strict()
      .prefault({}),
    shareTtlMs: z
      .number()
      .int()
      .min(60000)
      .max(7 * 86400000)
      .default(6 * 3600000),
    dedupeMs: z
      .number()
      .int()
      .min(60000)
      .max(30 * 86400000)
      .default(7 * 86400000),
  })
  .strict()
  .prefault({});
/** @param {any} policy @param {Date} date */
export function inAppHours(policy, date, { requested = false } = {}) {
  if (
    policy.hours.enabled === false ||
    (requested && policy.hours.scope !== "all")
  )
    return true;
  const p = new Intl.DateTimeFormat("en-GB", {
    timeZone: policy.hours.timezone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
  const { start, end } = policy.hours;
  return start === end
    ? true
    : start < end
      ? p >= start && p < end
      : p >= start || p < end;
}

export const SUBJECT_APP_TOOLS = [
  "app_capabilities",
  "app_browse",
  "app_search",
  "app_boards",
  "app_read",
  "app_record",
  "app_comments",
  "app_history",
  "qq_read_share_card",
  "app_image",
  "app_screenshot",
  "app_share_propose",
];

/** @param {{platform: string, operation: string}} job */
export function browserCursor(job) {
  return (
    (job.platform === "xiaohongshu" && job.operation === "browse") ||
    (job.platform === "heybox" && job.operation === "search")
  );
}
