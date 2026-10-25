import { z } from "zod";
import { APP_NAMES } from "./urls.mjs";
const time = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/);
export const appsPolicySchema = z
  .object({
    enabled: z.boolean().default(false),
    sharing: z.boolean().default(false),
    platforms: z.array(z.enum(APP_NAMES)).max(5).default([]),
    maxReadsPerDay: z.number().int().min(1).max(200).default(30),
    maxReadsPerTurn: z.number().int().min(1).max(30).default(6),
    maxSharesPerDay: z.number().int().min(1).max(30).default(3),
    hours: z
      .object({
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
export function inAppHours(policy, date) {
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
