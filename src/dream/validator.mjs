// @ts-check
import { z } from "zod";

const bounded = (/** @type {number} */ max) =>
  z.string().trim().min(1).max(max);
const requiredText = z.string().trim().min(1);
const score = z.number().min(0).max(1);
export const category = z.enum([
  "fact",
  "preference",
  "world_context",
  "topic_thread",
  "reflection",
]);
export const scopeId = z
  .string()
  .regex(/^(?:global|desktop|(?:group|private):\d+)$/);
const change = {
  content: bounded(400),
  epistemicStatus: z.enum([
    "observed",
    "reported",
    "inferred",
    "subjective",
    "planned",
    "disputed",
    "fictional",
  ]),
  evidenceIds: z.array(requiredText).min(1),
  reason: requiredText,
};

const target = {
  targetId: requiredText,
  expectedVersion: z.number().int().min(1),
  reason: requiredText,
};
const adjustment = {
  ...target,
  evidenceIds: change.evidenceIds,
  confidence: score.optional(),
  importance: score.optional(),
};
export const cognitionPatch = z.strictObject({
  schemaVersion: z.literal(1),
  operations: z.array(
    z.discriminatedUnion("op", [
      z.strictObject({
        op: z.literal("ADD"),
        category,
        scopeId,
        subjectKey: z.string().regex(/^[a-z0-9:_-]{2,96}$/),
        importance: score,
        confidence: score,
        ...change,
      }),
      z.strictObject({
        op: z.literal("MERGE"),
        ...target,
        sourceIds: z.array(requiredText).min(1),
        content: change.content,
        evidenceIds: change.evidenceIds,
      }),
      z.strictObject({
        op: z.literal("LINK"),
        fromId: requiredText,
        toId: requiredText,
        reason: requiredText,
        relation: z.enum([
          "related_to",
          "supports",
          "contradicts",
          "supersedes",
          "follows_up",
        ]),
      }),
      z.strictObject({ op: z.literal("ARCHIVE"), ...target }),
      z.strictObject({ op: z.literal("REINFORCE"), ...adjustment }),
      z.strictObject({ op: z.literal("WEAKEN"), ...adjustment }),
      z.strictObject({
        op: z.literal("UPDATE"),
        targetId: requiredText,
        expectedVersion: z.number().int().min(1),
        importance: score.optional(),
        confidence: score.optional(),
        ...change,
      }),
    ]),
  ),
  awakeningSummary: z.string().trim().max(500),
  noChangesReason: bounded(200).nullable(),
});

/** @typedef {z.infer<typeof cognitionPatch>} CognitionPatch */
/** @typedef {import("./source-filter.mjs").DreamSource} Source */
/** @param {unknown} input @param {number} maxOps */
export function parsePatch(input, maxOps) {
  const parsed = cognitionPatch.safeParse(input);
  if (
    !parsed.success ||
    parsed.data.operations.length > maxOps ||
    (!parsed.data.operations.length && !parsed.data.noChangesReason)
  )
    throw Error("DREAM_INVALID_PATCH");
  return parsed.data;
}

/** @param {{evidenceIds:string[],epistemicStatus:string}} operation @param {string} scope @param {string} category @param {(id:string) => Source|null|undefined} read @param {Set<string>} displayed @param {Map<string,string>} fingerprints */
export function validateEvidence(
  operation,
  scope,
  category,
  read,
  displayed,
  fingerprints,
) {
  if (operation.epistemicStatus === "fictional")
    throw Error("DREAM_FICTIONAL_IN_COGNITION");
  if (operation.epistemicStatus === "subjective" && category !== "reflection")
    throw Error("DREAM_INVALID_PATCH");
  const sources = [...new Set(operation.evidenceIds)].map((id) => {
    const item = read(id);
    if (!item)
      throw Error(
        item === null
          ? "RECALL_SOURCE_NOT_ALLOWED"
          : "DREAM_EVIDENCE_NOT_FOUND",
      );
    if (!displayed.has(id) || fingerprints.get(id) !== item.fingerprint)
      throw Error("DREAM_EVIDENCE_NOT_SHOWN");
    return item;
  });
  const scopes = new Set(sources.flatMap((item) => item.sourceScopes));
  if (scope !== "global" && !scopes.has(scope))
    throw Error("DREAM_SCOPE_VIOLATION");
  if (
    operation.epistemicStatus === "observed" &&
    !sources.some((item) => item.observed)
  )
    throw Error("DREAM_SELF_EVIDENCE_ONLY");
  return { sources, scopes };
}
