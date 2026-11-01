// @ts-check
import { createHash } from "node:crypto";

export const DEFAULT_TONE_PHRASES = Object.freeze([
  "希望对你有帮助",
  "作为一个AI",
  "作为AI",
  "总结一下",
  "综上所述",
  "有什么可以帮你",
  "如果你还有其他问题",
  "我理解你的感受",
]);

export class ToneReviewSuggested extends Error {
  /** @param {{phrases: string[], tooManyLines: boolean}} matches */
  constructor(matches) {
    super("TONE_REVIEW_SUGGESTED");
    this.matches = Object.freeze({
      phrases: Object.freeze(matches.phrases),
      tooManyLines: matches.tooManyLines,
    });
  }
}

/**
 * @param {{internalDelivery?: boolean, conversation: string, toneReviews?: Map<string, Set<string>>}} ctx
 * @param {{ownerIds: string[], behavior: {toneCheck?: {mode: "off" | "warn", phrases: string[], maxLinesCasual: number}}}} agent
 * @param {string} requestId
 * @param {string} text The plain text that would be delivered to QQ.
 */
export function checkTone(ctx, agent, requestId, text) {
  const policy = agent.behavior.toneCheck;
  if (ctx.internalDelivery || policy?.mode === "off" || !text) return;
  const phrases = [
    ...new Set([...DEFAULT_TONE_PHRASES, ...(policy?.phrases || [])]),
  ].filter((phrase) => text.toLowerCase().includes(phrase.toLowerCase()));
  const ownerPrivate = agent.ownerIds.some(
    (id) => ctx.conversation === `private:${id}`,
  );
  const tooManyLines =
    !ownerPrivate &&
    text.split(/\r\n|\r|\n/).length > (policy?.maxLinesCasual ?? 6);
  if (!phrases.length && !tooManyLines) return;
  // Keep only a digest in the turn context. A reminder never reserves an outbox
  // ID, while another turn cannot inherit this turn's deliberate confirmation.
  const digest = createHash("sha256").update(text).digest("hex");
  ctx.toneReviews ??= new Map();
  const reviewed = ctx.toneReviews.get(requestId) || new Set();
  if (reviewed.has(digest)) return;
  reviewed.add(digest);
  ctx.toneReviews.set(requestId, reviewed);
  throw new ToneReviewSuggested({ phrases, tooManyLines });
}
