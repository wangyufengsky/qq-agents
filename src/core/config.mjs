import fs from "node:fs";
import { appsPolicySchema } from "../apps/policy.mjs";
import {
  selfPolicySchema,
  contextPolicySchema,
  subjectPolicySchema,
} from "./mind-policy.mjs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  behaviorSchema,
  schedulerSchema,
  voiceSchema,
  filesSchema,
  crossGroupSchema,
  slangSchema,
  operationsSchema,
} from "./policy.mjs";

const id = z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/);
const qq = z.string().regex(/^\d{1,20}$/);
const envName = z.string().regex(/^[A-Z][A-Z0-9_]{0,100}$/);
const loopback = z.string().refine((s) => {
  try {
    const u = new URL(s);
    return (
      ["http:", "ws:"].includes(u.protocol) &&
      ["127.0.0.1", "localhost", "[::1]"].includes(u.hostname) &&
      !u.username &&
      !u.password &&
      !u.search &&
      !u.hash
    );
  } catch {
    return false;
  }
}, "Loopback URL required");
const toolServer = z
  .object({
    id,
    transport: z.enum(["stdio", "http", "sse"]).default("stdio"),
    command: z.string().min(1).optional(),
    url: z
      .string()
      .url()
      .refine((s) => {
        const u = new URL(s);
        return (
          !u.username &&
          !u.password &&
          !u.search &&
          !u.hash &&
          (u.protocol === "https:" ||
            (u.protocol === "http:" &&
              ["127.0.0.1", "localhost", "[::1]"].includes(u.hostname)))
        );
      })
      .optional(),
    headers: z.record(z.string().regex(/^[A-Za-z0-9-]+$/), envName).default({}),
    args: z.array(z.string()).default([]),
    env: z.record(z.string(), envName).default({}),
    allowedTools: z.array(z.string()).min(1),
  })
  .strict()
  .refine(
    (s) =>
      s.transport === "stdio" ? !!s.command && !s.url : !!s.url && !s.command,
    "Select a command for stdio or URL for HTTP/SSE",
  );
export const configSchema = z
  .object({
    version: z.literal(1),
    mode: z.enum(["isolated", "live"]).default("isolated"),
    port: z.number().int().min(0).max(65535).default(3210),
    globalPaused: z.boolean().default(true),
    connections: z.array(
      z
        .object({
          id,
          label: z.string(),
          accountId: qq,
          gateway: z.enum(["napcat", "onebot"]).default("napcat"),
          httpUrl: loopback,
          wsUrl: loopback,
          tokenEnv: envName.optional(),
          enabled: z.boolean().default(false),
          deployment: z
            .enum(["external", "native", "docker"])
            .default("external"),
          webUrl: loopback.optional(),
          process: z
            .object({
              command: z.string().min(1),
              args: z.array(z.string()).default([]),
              env: z.record(z.string(), envName).default({}),
            })
            .strict()
            .optional(),
          container: z
            .string()
            .regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/)
            .optional(),
        })
        .strict(),
    ),
    backends: z.array(
      z
        .object({
          id,
          type: z.enum(["dsh", "codex"]),
          label: z.string(),
          provider: z.string().default(""),
          baseUrl: loopback.optional(),
          command: z.string().default("codex"),
          home: z.string().optional(),
          preset: z.string().default("qq-unified"),
          model: z.string().default(""),
          effort: z.string().default("high"),
          toolServers: z.array(toolServer).default([]),
        })
        .strict(),
    ),
    agents: z.array(
      z
        .object({
          id,
          name: z.string().min(1).max(120),
          connectionId: id,
          backendId: id,
          paused: z.boolean().default(true),
          model: z.string().default(""),
          effort: z.string().default(""),
          persona: z.string().max(32000).default(""),
          appearance: z.string().max(2000).default(""),
          selfPolicy: selfPolicySchema,
          contextPolicy: contextPolicySchema,
          subject: subjectPolicySchema,
          behavior: behaviorSchema,
          scheduler: schedulerSchema,
          voice: voiceSchema,
          files: filesSchema,
          apps: appsPolicySchema,
          crossGroup: crossGroupSchema,
          slang: slangSchema,
          operations: operationsSchema,
          aliases: z.array(z.string().min(1).max(80)).default([]),
          ownerIds: z.array(qq).default([]),
          allow: z
            .object({
              groups: z.array(qq).default([]),
              users: z.array(qq).default([]),
            })
            .strict(),
          tools: z
            .array(z.string())
            .default([
              "memory_search",
              "memory_related",
              "memory_read",
              "conversation_read",
              "diary_write",
              "diary_revise",
              "qq_send",
              "qq_mark_read",
            ]),
          wake: z
            .object({
              mentions: z.boolean().default(true),
              names: z.boolean().default(true),
              private: z.boolean().default(true),
              questions: z.boolean().default(false),
              participation: z.number().min(0).max(1).default(0.05),
              peers: z.boolean().default(true),
              keywords: z.array(z.string().min(1).max(80)).max(50).default([]),
              speakerIds: z.array(qq).max(50).default([]),
              poke: z.boolean().default(true),
              joins: z.boolean().default(false),
              cooldownMs: z.number().int().min(0).default(1500),
            })
            .strict()
            .prefault({}),
          silence: z
            .array(
              z
                .object({
                  start: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
                  end: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
                  days: z.array(z.number().int().min(0).max(6)),
                  timezone: z
                    .string()
                    .refine((s) => {
                      try {
                        new Intl.DateTimeFormat("en", { timeZone: s });
                        return true;
                      } catch {
                        return false;
                      }
                    })
                    .default("Asia/Shanghai"),
                })
                .strict(),
            )
            .default([]),
          maxSendsPerTurn: z.number().int().min(1).max(10).default(3),
        })
        .strict(),
    ),
    peerLimit: z
      .object({
        maxMessages: z.number().int().min(1).max(30).default(6),
        cooldownMs: z.number().int().min(1000).default(60000),
      })
      .strict()
      .prefault({}),
  })
  .strict();

export function validateConfig(input) {
  const c = configSchema.parse(input);
  for (const rows of [c.connections, c.backends, c.agents])
    if (new Set(rows.map((r) => r.id)).size !== rows.length)
      throw Error("DUPLICATE_ID");
  if (
    new Set(c.connections.map((r) => r.accountId)).size !== c.connections.length
  )
    throw Error("DUPLICATE_QQ_ACCOUNT");
  for (const a of c.agents) {
    if (
      !c.connections.some((x) => x.id === a.connectionId) ||
      !c.backends.some((x) => x.id === a.backendId)
    )
      throw Error("INVALID_REFERENCE");
  }
  // An account is one public identity; multiple backend choices do not create ambiguous authors.
  if (new Set(c.agents.map((a) => a.connectionId)).size !== c.agents.length)
    throw Error("QQ_IDENTITY_ALREADY_BOUND");
  return c;
}
export function atomicJSON(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = file + "." + randomUUID() + ".tmp";
  try {
    fs.writeFileSync(temp, JSON.stringify(value, null, 2) + "\n", {
      mode: 0o600,
    });
    fs.renameSync(temp, file);
  } finally {
    if (fs.existsSync(temp)) fs.unlinkSync(temp);
  }
}
export class ConfigStore {
  constructor(file, initial) {
    this.file = file;
    this.value = validateConfig(
      fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : initial,
    );
    this.revision = 0;
    if (!fs.existsSync(file)) atomicJSON(file, this.value);
  }
  save(next, revision) {
    if (revision !== this.revision) throw Error("CONFIG_CONFLICT");
    const c = validateConfig(next);
    atomicJSON(this.file, c);
    this.value = c;
    this.revision++;
    return this.value;
  }
}
export function allowed(agent, conversation) {
  const [kind, target] = String(conversation).split(":");
  return kind === "group"
    ? agent.allow.groups.includes(target)
    : kind === "private" && agent.allow.users.includes(target);
}
export function inSilence(agent, date = new Date()) {
  return agent.silence.some((s) => {
    const p = Object.fromEntries(
      new Intl.DateTimeFormat("en-US", {
        timeZone: s.timezone,
        weekday: "short",
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
      })
        .formatToParts(date)
        .map((p) => [p.type, p.value]),
    );
    const day = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(
        p.weekday,
      ),
      time = p.hour + ":" + p.minute;
    if (s.start < s.end)
      return s.days.includes(day) && time >= s.start && time < s.end;
    return (
      (s.days.includes(day) && time >= s.start) ||
      (s.days.includes((day + 6) % 7) && time < s.end)
    );
  });
}
