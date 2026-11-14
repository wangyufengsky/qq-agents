import { videoTime } from "./frames.mjs";

const maxCues = 6000;
const maxCueChars = 180;

function cue(from, to, text, duration) {
  if (
    !Number.isFinite(from) ||
    !Number.isFinite(to) ||
    from < 0 ||
    from >= duration ||
    to <= from ||
    typeof text !== "string"
  )
    return null;
  const clean = text
    .replace(/[\p{Cc}\p{Cf}\s]+/gu, " ")
    .trim()
    .slice(0, maxCueChars);
  return clean
    ? {
        fromMs: Math.floor(from),
        toMs: Math.min(Math.ceil(to), duration),
        text: clean,
      }
    : null;
}

export function bilibiliCues(payload, duration) {
  if (!Array.isArray(payload?.body)) return [];
  return payload.body
    .slice(0, maxCues)
    .map((item) =>
      typeof item?.from === "number" && typeof item?.to === "number"
        ? cue(item.from * 1000, item.to * 1000, item.content, duration)
        : null,
    )
    .filter(Boolean)
    .sort((a, b) => a.fromMs - b.fromMs);
}

function srtTime(value) {
  const parts = value.split(/[:,]/).map(Number);
  return ((parts[0] * 60 + parts[1]) * 60 + parts[2]) * 1000 + parts[3];
}

export function srtCues(srt, duration, offset = 0) {
  const result = [];
  for (const block of srt
    .replaceAll("\r", "")
    .split(/\n[ \t]*\n/)
    .slice(0, maxCues)) {
    const item =
      /^(?:\s*\d+\n)?(\d{2,}:\d{2}:\d{2},\d{3}) --> (\d{2,}:\d{2}:\d{2},\d{3})[^\n]*\n([\s\S]+)$/.exec(
        block.trim(),
      );
    if (!item) continue;
    const [, start, end, text] = item;
    const value = cue(
      offset + srtTime(start),
      offset + srtTime(end),
      text,
      duration,
    );
    if (value) result.push(value);
  }
  return result.sort((a, b) => a.fromMs - b.fromMs);
}

export function overviewCaptions(images, cues) {
  return images.map(({ timestampsMs }) =>
    timestampsMs.flatMap((time, index) => {
      const item = cues.find(
        ({ fromMs, toMs }) => fromMs <= time && time < toMs,
      );
      return item
        ? [
            {
              tile: index + 1,
              atMs: time,
              ...item,
              text: item.text.slice(0, 90),
            },
          ]
        : [];
    }),
  );
}

export function segmentCaptions(cues, startMs, endMs) {
  return cues
    .filter(({ fromMs, toMs }) => fromMs < endMs && toMs > startMs)
    .slice(0, 24)
    .map((item) => ({
      ...item,
      fromMs: Math.max(startMs, item.fromMs),
      toMs: Math.min(endMs, item.toMs),
    }));
}

export function captionLine({ fromMs, toMs, text }) {
  return `${videoTime(fromMs)}–${videoTime(toMs)} ${text}`;
}
