export function spriteWindowSize(percent) {
  const scale = percent / 100;
  return [
    Math.max(194, Math.ceil(((105 * 16) / 9) * scale)),
    Math.max(156, Math.ceil(105 * scale) + 51),
  ];
}

export function desktopBodyBounds(
  type,
  { x, y, width = 194, height = 156 },
  spriteSize = 100,
) {
  // The interactive body excludes transparent padding and transient bubbles.
  return type === "door"
    ? { x: x + 9, y: y + 6, width: 82, height: 101 }
    : {
        x: x + width / 2 - (53 * spriteSize) / 100,
        y: y + height - 4 - (107 * spriteSize) / 100,
        width: (106 * spriteSize) / 100,
        height: (107 * spriteSize) / 100,
      };
}

function fitsWorkArea(bounds, area) {
  return (
    bounds.x >= area.x &&
    bounds.y >= area.y &&
    bounds.x + bounds.width <= area.x + area.width &&
    bounds.y + bounds.height <= area.y + area.height
  );
}

export function clampToWorkArea(point, width, height, area) {
  return {
    x: Math.round(
      Math.min(
        Math.max(point.x, area.x),
        Math.max(area.x, area.x + area.width - width),
      ),
    ),
    y: Math.round(
      Math.min(
        Math.max(point.y, area.y),
        Math.max(area.y, area.y + area.height - height),
      ),
    ),
  };
}

export function restoreWindowPoint(bounds, displays, fallback) {
  if (displays.some(({ workArea }) => fitsWorkArea(bounds, workArea)))
    return { x: bounds.x, y: bounds.y };
  const best = displays
    .map(({ workArea }) => {
      const width =
        Math.min(bounds.x + bounds.width, workArea.x + workArea.width) -
        Math.max(bounds.x, workArea.x);
      const height =
        Math.min(bounds.y + bounds.height, workArea.y + workArea.height) -
        Math.max(bounds.y, workArea.y);
      return { workArea, overlap: Math.max(0, width) * Math.max(0, height) };
    })
    .reduce(
      (best, candidate) =>
        !best || candidate.overlap > best.overlap ? candidate : best,
      null,
    );
  if (best?.overlap)
    return clampToWorkArea(bounds, bounds.width, bounds.height, best.workArea);
  return fallback();
}
