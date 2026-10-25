import { z } from "zod";
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const times = z.array(time).min(1).max(24),
  weekday = z.number().int().min(1).max(7),
  day = z.union([z.literal(-1), z.number().int().min(1).max(31)]),
  window = z.array(time).length(2);
const common = {
  startDate: date.nullish(),
  endDate: date.nullish(),
  excludeDates: z.array(date).max(1000).optional(),
  excludeHolidays: z.boolean().optional(),
};
const rule = (type, shape) =>
  z.object({ ...common, type: z.literal(type), ...shape }).strict();
// Calendar validity, quiet hours, quotas and next occurrences remain authoritative
// in the scheduler. These wire shapes make the model-facing contract usable.
export const modelScheduleSchema = z
  .discriminatedUnion("type", [
    rule("once", { date, time }),
    rule("daily", { times }),
    rule("weekly", { weekdays: z.array(weekday).min(1).max(7), times }),
    rule("workdays", { times }),
    rule("monthly", { days: z.array(day).min(1).max(32), times }),
    rule("monthlyWeekday", {
      nth: z.union([z.literal(-1), z.number().int().min(1).max(5)]),
      weekday,
      times,
    }),
    rule("yearly", {
      dates: z
        .array(z.string().regex(/^\d{2}-\d{2}$/))
        .min(1)
        .max(366),
      times,
    }),
    rule("dates", {
      items: z.array(z.object({ date, time }).strict()).min(1).max(100),
    }),
    rule("everyNDays", {
      every: z.number().int().min(2).max(365),
      startDate: date,
      times,
    }),
    rule("interval", {
      everyMinutes: z.number().int().min(10).max(1440),
      window: window.optional(),
    }),
    rule("dailyRandom", {
      count: z.number().int().min(1).max(24),
      window: window.optional(),
      minGapMin: z.number().int().min(0).max(720).optional(),
    }),
    rule("monthlyRandom", {
      count: z.number().int().min(1).max(31),
      dayRange: z.array(z.number().int().min(1).max(31)).length(2).optional(),
      window: window.optional(),
      minGapMin: z.number().int().min(0).max(720).optional(),
    }),
  ])
  .describe(
    "Structured schedule. Daily/weekly/workdays/monthly/yearly rules use times (array of HH:mm), while once uses a single time. Weekday 1=Monday, 7=Sunday; day/nth -1 means last. Cron is console-only.",
  );
