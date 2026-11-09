// @ts-check
import { z } from "zod";
import {
  backendSessionConfig,
  canonical,
} from "../backends/session-contract.mjs";

/** @param {any} backend @param {string} [model] */
export function socialBackendContract(backend, model) {
  if (!backend) return null;
  return canonical({
    ...backendSessionConfig({ ...backend, model: model || backend.model }),
    socialProfile: backend.socialProfile ?? null,
  });
}
import { homeRequestId, homeRevision } from "./policy.mjs";

export const SOCIAL_ADMIN_PRINCIPAL = "instance-administrator";
export const HOME_SOCIAL_DEFAULTS = Object.freeze({
  enabled: false,
  exchangeEnabled: false,
  durationMinutes: 10,
  maxTurns: 12,
  maxMessagesPerTurn: 3,
  invitationTtlHours: 48,
  visitTtlHours: 72,
  maxInvitationsPerDay: 5,
  maxMessagesPerVisitPerDay: 20,
  cooldownHours: 24,
  retentionDays: 30,
  resourceBudget: null,
});
const integer = (/** @type {number} */ max) => z.number().int().min(1).max(max);
export const socialResourceBudgetSchema = z
  .object({
    unit: z.literal("tokens"),
    maxInputTokensPerInference: integer(2097152),
    maxOutputTokensPerInference: integer(393216),
    maxTokensPerTurn: integer(100000000),
    maxTokensPerWindow: integer(1000000000),
    maxTokensPerDay: integer(1000000000),
    maxInferencesPerTurn: integer(32),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (
      v.maxTokensPerTurn <
        v.maxInputTokensPerInference + v.maxOutputTokensPerInference ||
      v.maxTokensPerWindow < v.maxTokensPerTurn ||
      v.maxTokensPerDay < v.maxTokensPerTurn
    )
      ctx.addIssue({
        code: "custom",
        message: "SOCIAL_RESOURCE_BUDGET_INVALID",
      });
  });
export const homeSocialPolicySchema = z
  .object({
    enabled: z.boolean().default(false),
    exchangeEnabled: z.boolean().default(false),
    durationMinutes: integer(30).default(10),
    maxTurns: z.number().int().min(2).max(24).default(12),
    maxMessagesPerTurn: integer(3).default(3),
    invitationTtlHours: integer(168).default(48),
    visitTtlHours: integer(720).default(72),
    maxInvitationsPerDay: integer(100).default(5),
    maxMessagesPerVisitPerDay: integer(200).default(20),
    cooldownHours: integer(168).default(24),
    retentionDays: integer(365).default(30),
    resourceBudget: socialResourceBudgetSchema.nullable().default(null),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (v.exchangeEnabled && !v.enabled)
      ctx.addIssue({
        code: "custom",
        message: "SOCIAL_EXCHANGE_DISABLED",
      });
  })
  .prefault({});
export const socialScope = z
  .array(z.enum(["layout", "intro", "tagline", "work-1", "work-2", "work-3"]))
  .max(6)
  .refine((v) => new Set(v).size === v.length);
export const socialSelectedItems = z
  .array(
    z
      .object({
        slot: z.enum(["intro", "tagline", "work-1", "work-2", "work-3"]),
        itemId: z.uuid(),
        itemRevision: homeRevision,
      })
      .strict(),
  )
  .max(5)
  .refine((v) => new Set(v.map((i) => i.slot)).size === v.length);
const text = (/** @type {number} */ max) =>
  z.string().refine((v) => [...v].length <= max, "SOCIAL_TEXT_LIMIT");
const id = z.uuid();
const pagination = {
  cursor: z.string().max(2048).optional(),
  limit: integer(50).default(20),
};
export const socialTargetSchema = z
  .object({
    kind: z.enum(["compose", "invitation", "visit"]),
    id: z.string().min(1).max(80),
  })
  .strict();
export const socialToolSchemas = {
  home_social_capabilities: z.object({}).strict(),
  home_visit_invite: z
    .object({
      requestId: homeRequestId,
      targetAgentId: z.string().min(1).max(64),
      roomOwnerAgentId: z.string().min(1).max(64),
      purpose: text(300),
      scope: socialScope.default(["layout"]),
      selectedItems: socialSelectedItems.default([]),
    })
    .strict(),
  home_visit_inbox: z.object(pagination).strict(),
  home_visit_invitation_read: z.object({ invitationId: id }).strict(),
  home_visit_decide: z
    .object({
      requestId: homeRequestId,
      invitationId: id,
      expectedInvitationRevision: homeRevision,
      decision: z.enum(["accept", "decline", "defer", "cancel"]),
      reason: text(200).default(""),
      reasonVisible: z.boolean().default(false),
      scope: socialScope.optional(),
      selectedItems: socialSelectedItems.optional(),
    })
    .strict(),
  home_visit_read: z.object({ visitId: id, ...pagination }).strict(),
  home_visit_mark_read: z
    .object({
      requestId: homeRequestId,
      visitId: id,
      lastDisplayedSequence: homeRevision,
      expectedVisitRevision: homeRevision,
    })
    .strict(),
  home_visit_send: z
    .object({
      requestId: homeRequestId,
      visitId: id,
      expectedVisitRevision: homeRevision,
      body: text(2000).refine((v) => v.trim().length > 0),
    })
    .strict(),
  home_visit_end: z
    .object({
      requestId: homeRequestId,
      visitId: id,
      expectedVisitRevision: homeRevision,
    })
    .strict(),
  home_visit_retract: z
    .object({
      requestId: homeRequestId,
      messageId: id,
      expectedMessageRevision: homeRevision,
    })
    .strict(),
  home_visit_room_read: z.object({ visitId: id, ...pagination }).strict(),
  home_visit_grant_reduce: z
    .object({
      requestId: homeRequestId,
      visitId: id,
      expectedGrantRevision: homeRevision,
      scope: socialScope,
      selectedItems: socialSelectedItems.default([]),
      expiresAt: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    })
    .strict(),
  home_social_block: z
    .object({
      requestId: homeRequestId,
      targetAgentId: z.string().min(1).max(64),
      expectedPolicyRevision: homeRevision,
      blocked: z.boolean(),
    })
    .strict(),
  home_social_operation_read: z.object({ requestId: homeRequestId }).strict(),
};
export const adminOverviewSchema = z
  .object({
    agentId: z.string().min(1).max(64).optional(),
    roomOwnerAgentId: z.string().min(1).max(64).optional(),
    kind: z.enum(["invitation", "visit"]).optional(),
    ...pagination,
  })
  .strict();
export const adminReadSchema = z
  .object({ kind: z.enum(["invitation", "visit"]), id, ...pagination })
  .strict();
export const moderateSchema = z
  .object({
    policyRevision: homeRevision,
    requestId: homeRequestId,
    action: z.enum(["hide-message", "close-window", "terminate-visit"]),
    targetId: id,
    expectedRevision: homeRevision,
  })
  .strict();

export const SOCIAL_CORE_TOOLS = Object.freeze(Object.keys(socialToolSchemas));

/** Accepted resource limits can tighten, but removing a configured budget never
 * relaxes an already accepted window. Null represents a turn-only window.
 * @param {any} accepted @param {any} current */
export function effectiveSocialResourceBudget(accepted, current) {
  if (!accepted) return current ? { ...current } : null;
  if (!current) return { ...accepted };
  const result = { ...accepted };
  for (const key of Object.keys(result))
    if (typeof result[key] === "number")
      result[key] = Math.min(result[key], current[key]);
  return result;
}
