// @ts-check
import timers from "node:timers/promises";
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

/** @param {any} runtime @param {any} ctx @param {number} ms */
export async function waitTyping(runtime, ctx, ms) {
  runtime.assertActive(ctx);
  if (ctx.internalDelivery || ms <= 0) return;
  await timers.setTimeout(ms, undefined, { signal: ctx.controller.signal });
  runtime.assertActive(ctx);
}
