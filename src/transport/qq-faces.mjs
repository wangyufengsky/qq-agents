import names from "./qq-face-names.json" with { type: "json" };

// Standard QQ identifier/name facts, not image recognition. Source and blob
// hash are recorded in docs/QQ-FACES.md; unknown IDs are never guessed.
export function qqFace(data) {
  const value = data?.id;
  const text =
    typeof value === "string" || typeof value === "number" ? String(value) : "";
  const id = /^\d{1,6}$/.test(text) ? String(Number(text)) : null;
  return {
    id,
    name: id !== null && Object.hasOwn(names, id) ? names[id] : null,
  };
}

export function qqFaceText(data) {
  const { id, name } = qqFace(data);
  return name
    ? `[QQ表情：${name}]`
    : id !== null
      ? `[QQ表情：未知名称，id=${id}]`
      : "[QQ表情：无效编号]";
}

export function qqFaces(segments) {
  if (!Array.isArray(segments)) return undefined;
  const items = [];
  let total = 0;
  for (const [index, segment] of segments.entries()) {
    if (segment?.type !== "face") continue;
    total++;
    if (items.length < 32)
      items.push({ segmentIndex: index, ...qqFace(segment.data) });
  }
  return total
    ? {
        items,
        total,
        truncated: items.length < total,
        notice:
          "QQ标准表情编号的名称说明，不是图片识别结果，也不等于发送者的真实情绪；完整原始消息段保存在记录的 payload.segments 中。",
      }
    : undefined;
}
