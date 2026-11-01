// @ts-check
import path from "node:path";
import os from "node:os";
import { z } from "zod";

/** @param {number} min @param {number} max @param {number} def */
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
    batchMaxMs: ms(0, 60000, 0),
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
    conversationMaxSendPerMinute: z.number().int().min(1).max(60).optional(),
    conversationMaxSendPerHour: z.number().int().min(1).max(1000).optional(),
    elsewhere: z
      .object({
        enabled: z.boolean().default(true),
        windowMs: ms(600000, 86400000, 21600000),
      })
      .strict()
      .prefault({}),
    actions: z
      .object({
        react: z.boolean().default(false),
        reactMaxPerMinute: ms(1, 60, 3),
        recall: z.boolean().default(false),
        recallWindowMs: ms(1, 110000, 110000),
        recallMaxPerHour: ms(1, 60, 3),
      })
      .strict()
      .prefault({}),
    burstMax: ms(1, 10, 8),
    burstMinMs: ms(0, 10000, 1000),
    burstMaxMs: ms(0, 10000, 3000),
    longGapProbability: probability.default(0.2),
    longGapMs: ms(0, 30000, 8000),
    rhythm: z
      .object({
        enabled: z.boolean().default(false),
        timezone: timezone.optional(),
        sleep: z
          .object({
            start: z
              .string()
              .regex(/^([01]\d|2[0-3]):[0-5]\d$/)
              .default("01:00"),
            end: z
              .string()
              .regex(/^([01]\d|2[0-3]):[0-5]\d$/)
              .default("08:30"),
          })
          .strict()
          .prefault({}),
        sleepMode: z.enum(["defer", "slow"]).default("defer"),
        urgentOwners: z.boolean().default(true),
        wakeJitterMs: ms(0, 7200000, 1800000),
        lateReply: z
          .object({
            probability: probability.default(0.1),
            minMs: ms(0, 3600000, 60000),
            maxMs: ms(0, 3600000, 600000),
          })
          .strict()
          .prefault({}),
      })
      .strict()
      .prefault({})
      .refine(
        (r) =>
          r.sleep.start !== r.sleep.end &&
          r.lateReply.maxMs >= r.lateReply.minMs,
        "INVALID_TIME_RANGE",
      ),
    typing: z
      .object({
        enabled: z.boolean().default(true),
        indicator: z.boolean().default(true),
        msPerChar: ms(0, 2000, 180),
        jitter: probability.default(0.35),
        minMs: ms(0, 30000, 600),
        maxMs: ms(0, 30000, 12000),
        firstReply: z.boolean().default(true),
        firstReplyMaxMs: ms(0, 30000, 6000),
      })
      .strict()
      .prefault({})
      .refine((x) => x.maxMs >= x.minMs, "INVALID_TIME_RANGE"),
    toneCheck: z
      .object({
        mode: z.enum(["off", "warn"]).default("warn"),
        phrases: z.array(z.string().trim().min(1).max(100)).max(50).default([]),
        maxLinesCasual: ms(1, 100, 6),
      })
      .strict()
      .prefault({}),
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
    // A fixed line, written by the administrator, for a turn someone
    // addressed directly that failed before saying anything. Off by default.
    failureNotice: z
      .object({
        enabled: z.boolean().default(false),
        text: z
          .string()
          .trim()
          .min(1)
          .max(200)
          .default("我刚才没接上，稍后再回你。"),
        cooldownMs: ms(60000, 86400000, 600000),
      })
      .strict()
      .prefault({}),
    // Fixed lines another online agent sends this agent's owners when this
    // agent's QQ goes offline or auto-reconnect gives up. Off by default.
    outageNotice: z
      .object({
        enabled: z.boolean().default(false),
        text: z
          .string()
          .trim()
          .min(1)
          .max(200)
          .default("{agent} 的 QQ 掉线了：{reason}。请到 NapCat 看一下。"),
        recoveredText: z
          .string()
          .trim()
          .min(1)
          .max(200)
          .default("{agent} 的 QQ 已经恢复连接。"),
        notifyRecovered: z.boolean().default(false),
        cooldownMs: ms(60000, 86400000, 1800000),
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
    enabled: z.boolean().default(true),
    timezone: timezone.default("Asia/Shanghai"),
    allowAiPrivate: z.boolean().default(true),
    allowAiOtherTargets: z.boolean().default(false),
    confirmAiOtherTargets: z.boolean().default(true),
    maxTasks: ms(1, 200, 20),
    perTaskPerDay: ms(1, 288, 12),
    totalPerDay: ms(1, 2000, 50),
    perGroupPerDay: ms(1, 500, 10),
    minIntervalMin: ms(1, 1440, 10),
    missedGraceMin: ms(0, 1440, 10),
    jitterMin: ms(0, 30, 2),
    quietEnabled: z.boolean().default(true),
    quietAllDay: z.boolean().optional(),
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
  .prefault({})
  .refine(
    (s) =>
      !s.quietEnabled || s.quietAllDay === true || s.quietStart !== s.quietEnd,
    "EXPLICIT_ALL_DAY_REQUIRED",
  );

const argumentName = z
  .string()
  .regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/)
  .refine((k) => !["__proto__", "constructor", "prototype"].includes(k));
// Received voice is sent to this administrator-chosen MCP tool for a
// transcript. Off by default: enabling it and naming the tool is the consent
// to hand chat audio to that service.
export const asrSchema = z
  .object({
    enabled: z.boolean().default(false),
    serverId: z.string().max(64).default(""),
    tool: z.string().max(200).default(""),
    audioArgument: argumentName.default("audio"),
    mimeArgument: z.union([argumentName, z.literal("")]).default("mimeType"),
    arguments: z
      .record(
        argumentName,
        z.union([z.string().max(500), z.number(), z.boolean()]),
      )
      .refine((x) => Object.keys(x).length <= 10, "TOO_MANY_ARGUMENTS")
      .default({}),
    maxSeconds: ms(1, 600, 90),
    maxBytes: ms(65536, 20971520, 8388608),
    timeoutMs: ms(1000, 300000, 60000),
    // How long a turn may wait at its start for a transcript still running.
    waitMs: ms(0, 30000, 8000),
    maxPerHour: ms(1, 1000, 60),
  })
  .strict()
  .prefault({})
  .refine(
    (x) => !x.enabled || (x.serverId !== "" && x.tool !== ""),
    "ASR_TOOL_REQUIRED",
  )
  .refine(
    (x) =>
      x.audioArgument !== x.mimeArgument &&
      ![x.audioArgument, x.mimeArgument].some((k) =>
        Object.hasOwn(x.arguments, k),
      ),
    "ASR_ARGUMENT_COLLISION",
  );
export const voiceSchema = z
  .object({
    tts: z
      .object({
        enabled: z.boolean().default(true),
        voice: z.string().min(1).max(100).default("Tingting"),
      })
      .strict()
      .prefault({}),
    maxBytes: ms(1024, 20971520, 20971520),
    maxSeconds: ms(1, 1800, 300),
    ffmpegCommand: z.string().min(1).default("ffmpeg"),
    ffprobeCommand: z.string().min(1).default("ffprobe"),
    localRoots: z.array(z.string().min(1).max(4096)).max(10).default([]),
    asr: asrSchema,
  })
  .strict()
  .prefault({});
export const crossGroupSchema = z
  .object({
    enabled: z.boolean().default(true),
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
export const operationsSchema = z
  .object({
    enabled: z.boolean().default(true),
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
    enabled: z.boolean().default(true),
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
