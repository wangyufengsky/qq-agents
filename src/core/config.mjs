import fs from "node:fs";
import { TOOL_NAMES } from "../tools/names.mjs";
import { appsPolicySchema } from "../apps/policy.mjs";
import { githubPolicySchema } from "../github/policy.mjs";
import {
  selfPolicySchema,
  contextPolicySchema,
  subjectPolicySchema,
} from "./mind-policy.mjs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import {
  behaviorSchema,
  schedulerSchema,
  voiceSchema,
  filesSchema,
  crossGroupSchema,
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
const loopbackHosts = ["127.0.0.1", "localhost", "[::1]"];
// Names a container network can reach without leaving the machine or LAN: a
// single-label Docker service name, host.docker.internal, an RFC 1918 IPv4
// address or an IPv6 unique-local address. Link-local (cloud metadata),
// CGNAT and public addresses are never private here.
export function privateNetworkHost(hostname) {
  const h = String(hostname).toLowerCase();
  if (loopbackHosts.includes(h) || h === "host.docker.internal") return true;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(h);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return (
      a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
    );
  }
  if (h.startsWith("[")) return /^\[f[cd][0-9a-f]{0,2}:/.test(h);
  return /^[a-z0-9_]([a-z0-9_-]{0,62})$/.test(h);
}
// OneBot endpoints carry the access token in clear text, so the host must stay
// on loopback unless the connection explicitly opts into a private network.
const onebotUrl = z.string().refine((s) => {
  try {
    const u = new URL(s);
    return (
      ["http:", "ws:"].includes(u.protocol) &&
      !u.username &&
      !u.password &&
      !u.search &&
      !u.hash
    );
  } catch {
    return false;
  }
}, "http:// or ws:// URL without credentials, query or hash required");
function onebotHosts(c, ctx) {
  for (const key of ["httpUrl", "wsUrl", "webUrl"]) {
    // An unparsable URL was already reported by the field-level check.
    if (c[key] === undefined || !URL.canParse(c[key])) continue;
    const host = new URL(c[key]).hostname;
    if (loopbackHosts.includes(host)) continue;
    if (c.allowPrivateNetwork === true && privateNetworkHost(host)) continue;
    ctx.addIssue({
      code: "custom",
      path: [key],
      message:
        c.allowPrivateNetwork === true
          ? "Loopback or private-network URL required"
          : "Loopback URL required",
    });
  }
}
// Remote model APIs must use TLS; plain HTTP is only for a local server.
const apiUrl = z.string().refine((s) => {
  try {
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
  } catch {
    return false;
  }
}, "HTTPS or loopback HTTP URL required");
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
          messageIdNamespace: id
            .refine(
              (x) => x !== "archive",
              "archive is reserved for imported records",
            )
            .default("onebot"),
          gateway: z.enum(["napcat", "onebot"]).default("napcat"),
          httpUrl: onebotUrl,
          wsUrl: onebotUrl,
          // Opt-in for Docker/LAN deployments: the OneBot token then crosses
          // the container network in clear text. No default, so existing
          // configs parse unchanged.
          allowPrivateNetwork: z.boolean().optional(),
          tokenEnv: envName.optional(),
          enabled: z.boolean().default(false),
          recovery: z
            .object({
              autoReconnect: z.boolean().default(true),
              maxAttempts: z.number().int().min(1).max(20).default(8),
              initialDelayMs: z
                .number()
                .int()
                .min(1000)
                .max(60000)
                .default(2000),
              maxDelayMs: z
                .number()
                .int()
                .min(5000)
                .max(600000)
                .default(300000),
              // No default, so existing configs parse unchanged; 0 turns the
              // OneBot ping watchdog off.
              heartbeatTimeoutMs: z
                .union([z.literal(0), z.number().int().min(15000).max(600000)])
                .optional(),
            })
            .strict()
            .prefault({})
            .refine((r) => r.maxDelayMs >= r.initialDelayMs, {
              message: "maxDelayMs must be at least initialDelayMs",
            }),
          deployment: z
            .enum(["external", "native", "docker"])
            .default("external"),
          webUrl: onebotUrl.optional(),
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
        .strict()
        .superRefine(onebotHosts),
    ),
    backends: z.array(
      z
        .object({
          id,
          type: z.enum(["dsh", "codex", "openai"]),
          label: z.string(),
          provider: z.string().default(""),
          baseUrl: z.string().optional(),
          // OpenAI-compatible only. No schema defaults: existing DSH/Codex
          // configs must parse unchanged so their session signatures hold.
          apiKeyEnv: envName.optional(),
          contextWindow: z.number().int().min(1024).max(10000000).optional(),
          maxToolRounds: z.number().int().min(1).max(200).optional(),
          requestTimeoutMs: z.number().int().min(5000).max(600000).optional(),
          vision: z.boolean().optional(),
          sendEffort: z.boolean().optional(),
          recovery: z
            .object({
              autoReconnect: z.boolean().default(false),
              dshInstance: z
                .string()
                .regex(/^relay:[a-zA-Z0-9_-]{1,64}$/)
                .optional(),
            })
            .strict()
            .default({ autoReconnect: false }),
          command: z.string().default("codex"),
          env: z
            .record(
              z
                .string()
                .regex(/^[A-Za-z_][A-Za-z0-9_]{0,100}$/)
                .refine(
                  (name) => name.toUpperCase() !== "CODEX_HOME",
                  "Codex home is managed by the bridge",
                ),
              envName,
            )
            .optional(),
          home: z.string().optional(),
          preset: z.string().default("qq-unified"),
          model: z.string().default(""),
          effort: z.string().default("high"),
          toolServers: z.array(toolServer).default([]),
        })
        .strict()
        .refine(
          (backend) =>
            backend.type === "codex" || !Object.keys(backend.env || {}).length,
          "Environment mappings require a Codex subprocess",
        )
        .refine(
          (backend) =>
            backend.baseUrl === undefined ||
            (backend.type === "openai" ? apiUrl : loopback).safeParse(
              backend.baseUrl,
            ).success,
          {
            message: "DSH needs a loopback URL; an OpenAI API needs HTTPS",
            path: ["baseUrl"],
          },
        )
        .refine((backend) => backend.type !== "openai" || !!backend.baseUrl, {
          message: "An OpenAI-compatible backend needs baseUrl",
          path: ["baseUrl"],
        })
        .refine(
          (backend) =>
            backend.type === "openai" ||
            [
              "apiKeyEnv",
              "contextWindow",
              "maxToolRounds",
              "requestTimeoutMs",
              "vision",
              "sendEffort",
            ].every((k) => backend[k] === undefined),
          "These settings apply to an OpenAI-compatible backend",
        ),
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
          github: githubPolicySchema,
          crossGroup: crossGroupSchema,
          operations: operationsSchema,
          aliases: z.array(z.string().min(1).max(80)).default([]),
          ownerIds: z.array(qq).default([]),
          allow: z
            .object({
              groups: z.array(qq).default([]),
              users: z.array(qq).default([]),
            })
            .strict(),
          tools: z.array(z.string()).default(() => [...TOOL_NAMES]),
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
                  allDay: z.boolean().optional(),
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
                .strict()
                .refine(
                  (s) =>
                    s.allDay === true ? s.start === s.end : s.start !== s.end,
                  "EXPLICIT_ALL_DAY_REQUIRED",
                ),
            )
            .default([]),
          network: z
            .object({
              autonomous: z.boolean().default(true),
              publicUrls: z.array(z.string().url()).max(100).default([]),
            })
            .strict()
            .prefault({}),
          maxConsecutiveSends: z.number().int().min(1).max(10).optional(),
          // Compatibility alias for the consecutive-reply batch limit.
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

// Slang learning was removed in 0.5.3. Earlier configs still carry its
// settings and tool names; drop them so they load and are not written back.
function withoutSlang(input) {
  if (!Array.isArray(input?.agents)) return input;
  return {
    ...input,
    agents: input.agents.map((a) => {
      if (!a || typeof a !== "object" || Array.isArray(a)) return a;
      const { slang, ...agent } = a;
      if (Array.isArray(agent.tools))
        agent.tools = agent.tools.filter(
          (t) => typeof t !== "string" || !t.startsWith("slang_"),
        );
      return agent;
    }),
  };
}
export function validateConfig(input) {
  const c = configSchema.parse(withoutSlang(input));
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
const configRevision = (value) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
function readConfig(file) {
  let text, input;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (cause) {
    throw Error("CONFIG_READ_FAILED", { cause });
  }
  try {
    input = JSON.parse(text);
  } catch (cause) {
    throw Error("CONFIG_INVALID_JSON", { cause });
  }
  try {
    const migrationWarnings = new Set();
    // Only persisted legacy settings are migrated. New API saves must make
    // the all-day choice explicitly, so an accidental equal pair is rejected.
    for (const a of Array.isArray(input?.agents) ? input.agents : []) {
      for (const s of Array.isArray(a?.silence) ? a.silence : []) {
        if (
          s &&
          typeof s.start === "string" &&
          s.start === s.end &&
          s.allDay === undefined
        ) {
          s.allDay = true;
          migrationWarnings.add("SILENCE_EQUAL_TIME_MIGRATED");
        }
      }
      const s = a?.scheduler;
      if (
        s &&
        typeof s.quietStart === "string" &&
        s.quietStart === s.quietEnd &&
        s.quietAllDay === undefined
      ) {
        s.quietEnabled = false;
        s.quietAllDay = false;
        migrationWarnings.add("SCHEDULER_EQUAL_TIME_MIGRATED");
      }
    }
    return {
      value: validateConfig(input),
      migrationWarnings: [...migrationWarnings],
    };
  } catch (cause) {
    throw Error("CONFIG_SCHEMA_INVALID", { cause });
  }
}
export class ConfigStore {
  constructor(file, initial) {
    this.file = file;
    const loaded = fs.existsSync(file)
      ? readConfig(file)
      : { value: validateConfig(initial), migrationWarnings: [] };
    this.value = loaded.value;
    this.migrationWarnings = loaded.migrationWarnings;
    // Derived from the persisted configuration, never reset by a process restart.
    this.revision = configRevision(this.value);
    if (!fs.existsSync(file)) atomicJSON(file, this.value);
  }
  save(next, revision) {
    if (revision !== this.revision) throw Error("CONFIG_CONFLICT");
    const c = validateConfig(next);
    try {
      atomicJSON(this.file, c);
    } catch (cause) {
      throw Error("CONFIG_SAVE_FAILED", { cause });
    }
    this.value = c;
    this.revision = configRevision(c);
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
