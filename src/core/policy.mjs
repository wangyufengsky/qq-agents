import path from "node:path";
import os from "node:os";
import { z } from "zod";

const ms = (min, max, def) => z.number().int().min(min).max(max).default(def);
const probability = z.number().min(0).max(1);
export const timezone = z.string().refine((s) => {
  try {
    new Intl.DateTimeFormat("en", { timeZone: s });
    return true;
  } catch {
    return false;
  }
}, "INVALID_TIMEZONE");
export const behaviorSchema = z
  .object({
    batchWindowMs: ms(0, 60000, 0),
    maxWakePerMinute: ms(1, 60, 6),
    maxWakePerHour: ms(1, 360, 60),
    noActionLimit: ms(1, 10, 3),
    replyCheckMs: ms(1000, 3600000, 30000),
    turnTimeoutMs: ms(60000, 7200000, 1800000),
    preSleepWaitMs: ms(0, 600000, 300000),
    waitMaxMs: ms(1000, 600000, 600000),
    quietAfterNewMs: ms(0, 60000, 10000),
    maxSendPerMinute: ms(1, 60, 8),
    maxSendPerHour: ms(1, 1000, 60),
    burstMax: ms(1, 10, 8),
    burstMinMs: ms(0, 10000, 1000),
    burstMaxMs: ms(0, 10000, 3000),
    longGapProbability: probability.default(0.2),
    longGapMs: ms(0, 30000, 8000),
    proactive: z
      .object({
        enabled: z.boolean().default(false),
        minMs: ms(60000, 86400000, 1800000),
        maxMs: ms(60000, 86400000, 5400000),
        idleMs: ms(0, 86400000, 900000),
        probability: probability.default(0.3),
        timezone: timezone.default("Asia/Shanghai"),
        nightFactor: probability.default(0.3),
      })
      .strict()
      .prefault({}),
  })
  .strict()
  .prefault({})
  .refine(
    (x) =>
      x.burstMaxMs >= x.burstMinMs && x.proactive.maxMs >= x.proactive.minMs,
    "INVALID_TIME_RANGE",
  );

export const schedulerSchema = z
  .object({
    enabled: z.boolean().default(false),
    timezone: timezone.default("Asia/Shanghai"),
    allowAiPrivate: z.boolean().default(true),
    allowAiOtherTargets: z.boolean().default(false),
    maxTasks: ms(1, 200, 20),
    perTaskPerDay: ms(1, 288, 12),
    totalPerDay: ms(1, 2000, 50),
    perGroupPerDay: ms(1, 500, 10),
    minIntervalMin: ms(1, 1440, 10),
    missedGraceMin: ms(0, 1440, 10),
    jitterMin: ms(0, 30, 2),
    quietEnabled: z.boolean().default(true),
    quietStart: z
      .string()
      .regex(/^([01]\d|2[0-3]):[0-5]\d$/)
      .default("00:00"),
    quietEnd: z
      .string()
      .regex(/^([01]\d|2[0-3]):[0-5]\d$/)
      .default("07:00"),
    holidays: z
      .array(z.string().regex(/^\d{4}-\d{2}-\d{2}$/))
      .max(1000)
      .default([]),
  })
  .strict()
  .prefault({});

export const voiceSchema = z
  .object({
    maxBytes: ms(1024, 20971520, 20971520),
    maxSeconds: ms(1, 1800, 300),
    ffmpegCommand: z.string().min(1).default("ffmpeg"),
    ffprobeCommand: z.string().min(1).default("ffprobe"),
    localRoots: z.array(z.string().min(1).max(4096)).max(10).default([]),
  })
  .strict()
  .prefault({});
export const crossGroupSchema = z
  .object({
    enabled: z.boolean().default(false),
    links: z
      .array(
        z
          .object({
            from: z.string().regex(/^\d+$/),
            to: z.string().regex(/^\d+$/),
            allow: z.array(z.enum(["presence", "activity"])),
          })
          .strict(),
      )
      .max(100)
      .default([]),
  })
  .strict()
  .prefault({});
export const slangSchema = z
  .object({
    enabled: z.boolean().default(false),
    autoResearch: z.boolean().default(false),
    minMessages: ms(1, 1000, 10),
    cooldownMs: ms(60000, 86400000, 300000),
    maxCandidates: ms(1, 2000, 200),
    researchServerId: z.string().default(""),
    researchTool: z.string().default(""),
  })
  .strict()
  .prefault({});
export const operationsSchema = z
  .object({
    enabled: z.boolean().default(false),
    workspace: z.string().default(""),
    allowL3: z.boolean().default(false),
    totpEnv: z
      .string()
      .regex(/^[A-Z][A-Z0-9_]{0,100}$/)
      .optional(),
    allowedCommands: z.array(z.string().min(1)).max(30).default([]),
    idleMs: ms(60000, 14400000, 1800000),
    maxLevelMs: ms(60000, 14400000, 3600000),
  })
  .strict()
  .prefault({});

export const filesSchema = z
  .object({
    enabled: z.boolean().default(false),
    download: z.boolean().default(true),
    receive: z.boolean().default(true),
    send: z.boolean().default(true),
    create: z.boolean().default(true),
    maxBytes: ms(1024, 52428800, 20971520),
    maxTotalBytes: ms(1024, 5368709120, 209715200),
    maxFiles: ms(1, 10000, 1000),
    localRoots: z
      .array(
        z
          .string()
          .min(1)
          .max(4096)
          .refine(
            (root) =>
              path.isAbsolute(root) &&
              ![
                path.parse(root).root,
                os.homedir(),
                path.dirname(os.homedir()),
              ].includes(path.resolve(root)),
          ),
      )
      .max(10)
      .default([]),
  })
  .strict()
  .prefault({})
  .refine((p) => p.maxTotalBytes >= p.maxBytes, "FILE_QUOTA_TOO_SMALL");
