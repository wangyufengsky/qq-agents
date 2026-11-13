import { z } from "zod";

// An absent list preserves installations that previously inherited P2 roles.
export const observationRoles = (policy) =>
  policy.observationRoles ?? policy.activityRoles;

// Settings metadata is shared with the desktop management form.
export const DESKTOP_PUBLIC_FIELDS = {
  nearbyDip: ["普通动作感知距离（DIP）", 32, 2000, 320],
  firstMin: ["首次活动最短等待（分钟）", 1, 60, 5],
  firstMax: ["首次活动最长等待（分钟）", 1, 60, 8],
  idleMin: ["空闲活动最短间隔（分钟）", 1, 120, 15],
  idleMax: ["空闲活动最长间隔（分钟）", 1, 120, 25],
  resumeMin: ["恢复后最短等待（分钟）", 1, 60, 2],
  resumeMax: ["恢复后最长等待（分钟）", 1, 60, 5],
  waitMin: ["角色自主等待下限（分钟）", 1, 120, 2],
  waitMax: ["角色自主等待上限（分钟）", 1, 120, 30],
  restMin: ["角色免打扰下限（分钟）", 1, 120, 5],
  restMax: ["角色免打扰上限（分钟）", 1, 120, 30],
  greetingSeconds: ["点名招呼有效期（秒）", 5, 300, 60],
  arrivalSeconds: ["入场招呼有效期（秒）", 5, 180, 30],
  mergeSeconds: ["事件合并时间（秒）", 0, 30, 5],
  recentMinutes: ["近期公共事件保留（分钟）", 1, 60, 10],
  recentLimit: ["每轮最多带入的近期事件", 1, 20, 5],
  idleLimit: ["每小时空闲活动上限", 1, 24, 3],
  totalLimit: ["每小时自主活动总上限", 1, 24, 4],
};

export const DESKTOP_PUBLIC_DEFAULTS = {
  enabled: false,
  ...Object.fromEntries(
    Object.entries(DESKTOP_PUBLIC_FIELDS).map(([key, [, , , value]]) => [
      key,
      value,
    ]),
  ),
};

const desktopPublicPolicy = z
  .object({
    enabled: z.boolean().default(false),
    ...Object.fromEntries(
      Object.entries(DESKTOP_PUBLIC_FIELDS).map(
        ([key, [, min, max, value]]) => [
          key,
          z.number().int().min(min).max(max).default(value),
        ],
      ),
    ),
  })
  .strict()
  .refine(
    (policy) =>
      ["first", "idle", "resume", "wait", "rest"].every(
        (key) => policy[key + "Min"] <= policy[key + "Max"],
      ) && policy.idleLimit <= policy.totalLimit,
  )
  .prefault({});

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
    publicPerception: desktopPublicPolicy,
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
