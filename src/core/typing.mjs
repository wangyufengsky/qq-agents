// @ts-check
import timers from "node:timers/promises";
import { humanInput } from "./input-progress.mjs";
import { mdToPlain } from "../../vendor/dsh-qq/md-to-plain.js";

/** @typedef {import("zod").infer<typeof import("./policy.mjs").behaviorSchema>} Behavior */
const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** @param {string} text @param {Behavior["typing"]} typing @param {() => number} random */
export function typingDelay(text, typing, random) {
  // Treat rich items as one keystroke, and never split a joined emoji into code points.
  const plain = text
    .replace(/!?\[[^\]\n]{0,500}\]\([^\s)]{1,2000}\)/g, "◻")
    .replace(/https?:\/\/[^\s<>，。！？、）]+/gi, "◻")
    .replace(
      /\[(?:CQ:(?:face|image)[^\]]*|QQ表情[：:][^\]]*|图片(?:[：:][^\]]*)?)\]/g,
      "◻",
    );
  const count = [...graphemes.segment(mdToPlain(plain))].length;
  const base = count * typing.msPerChar;
  return Math.round(
    Math.max(
      typing.minMs,
      Math.min(typing.maxMs, base * (1 + (random() * 2 - 1) * typing.jitter)),
    ),
  );
}

/** @param {string} text @param {Behavior} behavior @param {() => number} random @param {number | undefined} gapMs */
export function burstDelay(text, behavior, random, gapMs) {
  if (gapMs !== undefined) return gapMs;
  // The disabled branch preserves both the old distribution and random-call order.
  if (!behavior.typing.enabled)
    return random() < behavior.longGapProbability
      ? behavior.longGapMs
      : behavior.burstMinMs +
          Math.round(random() * (behavior.burstMaxMs - behavior.burstMinMs));
  const extra = random() < behavior.longGapProbability ? behavior.longGapMs : 0;
  return typingDelay(text, behavior.typing, random) + extra;
}

/** @param {any} runtime @param {any} ctx @param {number} ms @param {{reviewNewInput?: boolean}} options */
export async function waitTyping(
  runtime,
  ctx,
  ms,
  { reviewNewInput = false } = {},
) {
  runtime.assertActive(ctx);
  if (ctx.internalDelivery || ms <= 0) return;
  const mem = runtime.memory.bind(ctx.agentId);
  const snapshot =
    reviewNewInput && ms > 3000
      ? mem.db
          .prepare(
            "SELECT COALESCE(MAX(seq),0) AS seq FROM events WHERE agent_id=? AND conversation=?",
          )
          .get(ctx.agentId, ctx.conversation).seq
      : null;
  await timers.setTimeout(ms, undefined, { signal: ctx.controller.signal });
  runtime.assertActive(ctx);
  if (snapshot === null) return;
  const observed = Math.max(ctx.inputBaseline || 0, ctx.replyInputSeq || 0);
  const fresh = mem.db
    .prepare(
      "SELECT id,seq FROM events WHERE agent_id=? AND conversation=? AND seq>? ORDER BY seq DESC",
    )
    .all(ctx.agentId, ctx.conversation, Math.max(snapshot, observed))
    .find((/** @type {any} */ row) => humanInput(runtime, ctx, row.id));
  if (fresh) {
    // Persist the review fence for this turn: merely retrying must not hide unread input.
    ctx.typingReviewSeq = fresh.seq;
    throw Error("TYPING_NEW_INPUT_REVIEW_REQUIRED");
  }
}

/** @param {any} runtime @param {any} ctx @param {string | undefined} text @param {number | undefined} fallbackMs */
export function waitFirstReply(runtime, ctx, text, fallbackMs) {
  const a = runtime.assertActive(ctx),
    typing = a.behavior.typing;
  if (ctx.internalDelivery || text === undefined) return;
  if (
    (ctx.typingReviewSeq || 0) >
    Math.max(ctx.inputBaseline || 0, ctx.replyInputSeq || 0)
  )
    throw Error("TYPING_NEW_INPUT_REVIEW_REQUIRED");
  if (!typing.enabled || !typing.firstReply || ctx.confirmedSends) return;
  const ms = Math.min(
    text
      ? typingDelay(text, typing, runtime.random)
      : (fallbackMs ?? typingDelay(text, typing, runtime.random)),
    typing.firstReplyMaxMs,
  );
  return waitTyping(runtime, ctx, ms, { reviewNewInput: true });
}
