// @ts-check
import { z } from "zod";
import { mdToPlain } from "../../vendor/dsh-qq/md-to-plain.js";
import { qqFace, qqFaceText } from "../transport/qq-faces.mjs";

export const qqSegmentsSchema = z
  .array(
    z.discriminatedUnion("type", [
      z
        .object({ type: z.literal("text"), text: z.string().min(1).max(8000) })
        .strict(),
      z
        .object({ type: z.literal("face"), id: z.string().regex(/^\d{1,6}$/) })
        .strict(),
    ]),
  )
  .min(1)
  .max(32)
  .describe(
    "按顺序发送文字和标准 QQ 表情，例如 [{type:'text',text:'好呀'},{type:'face',id:'20'}]；20=偷笑。不能传入原始 OneBot data、图片地址或其他消息段。",
  );

/** @typedef {z.infer<typeof qqSegmentsSchema>} QQSegments */
/** @typedef {{type: string, data: Record<string, string>}} WireSegment */

/**
 * Validate before reserving a receipt; callers also use this to preflight a burst.
 * @param {{text?: string, segments?: QQSegments}} input
 * @param {number} maxText
 */
export function qqMessage(input, maxText = 8000) {
  if (input.segments !== undefined && input.text !== undefined)
    throw Error("INVALID_MESSAGE");
  if (input.segments === undefined) {
    const source = input.text === undefined ? "" : input.text;
    if (typeof source !== "string" || source.length > maxText)
      throw Error("INVALID_MESSAGE");
    const text = mdToPlain(source);
    return {
      text,
      sourceText: source,
      body: text,
      typingText: text,
      segments: /** @type {WireSegment[]} */ (
        text ? [{ type: "text", data: { text } }] : []
      ),
    };
  }
  const parsed = qqSegmentsSchema.safeParse(input.segments);
  if (!parsed.success) throw Error("INVALID_MESSAGE");
  let length = 0,
    text = "",
    sourceText = "",
    body = "",
    typingText = "";
  const segments = /** @type {WireSegment[]} */ ([]);
  for (const part of parsed.data) {
    if (part.type === "text") {
      length += part.text.length;
      if (length > maxText) throw Error("INVALID_MESSAGE");
      const plain = mdToPlain(part.text);
      sourceText += part.text;
      text += plain;
      body += plain;
      typingText += plain;
      if (plain) segments.push({ type: "text", data: { text: plain } });
    } else {
      const face = qqFace({ id: part.id });
      if (face.id === null || !face.name) throw Error("INVALID_QQ_FACE");
      segments.push({ type: "face", data: { id: face.id } });
      body += qqFaceText({ id: face.id });
      typingText += "◻";
    }
  }
  if (!segments.length) throw Error("EMPTY_MESSAGE");
  return { text, sourceText, body, typingText, segments };
}
