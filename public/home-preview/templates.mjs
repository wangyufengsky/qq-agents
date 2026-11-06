export const families = {
  desk: ["desk", "desk-simple"],
  shelf: ["shelf", "shelf-wide"],
  plant: ["plant", "plant-tall"],
  curtains: ["curtains", "curtains-short"],
};
function item(id, asset, x, y, w, z = 3, phone = null, zone = "main") {
  return {
    id,
    asset,
    base: { x, y, w },
    phone: phone ? { x: phone[0], y: phone[1], w: phone[2] } : null,
    z,
    zone,
  };
}
function layout(type, count, page) {
  if (type === "room")
    return {
      objects: [
        item("door", "door", 16, 82, 19, 3, [20, 82, 25]),
        item("nameplate", "nameplate", 16, 43, 10, 5, [20, 47, 16]),
        item("shelf", "shelf", 32, 82, 12, 3, [44, 82, 18]),
        item("desk", "desk", 51, 82, 24, 3, [73, 82, 39]),
        item("card", "card", 55, 61, 10, 6, [78, 61, 16]),
        item("lamp", "lamp", 44, 61, 8, 5, [62, 61, 12]),
        item("art", "wall-art", 48, 39, 15, 2, [45, 31, 20]),
        item("envelope", "envelope", 63, 49, 10, 4, [61, 48, 14]),
        item("window", "window", 81, 44, 19, 2, [77, 35, 29]),
        item("curtains", "curtains", 81, 46, 24, 3, [77, 37, 35]),
        item("bed", "bed", 80, 82, 31, 4, [61, 82, 61], "nook"),
        item("plant", "plant", 65, 82, 7, 5, [19, 82, 16], "nook"),
        item("rug", "rug", 55, 94, 39, 1, [53, 94, 62], "nook"),
      ],
      hotspots: {
        door: "back",
        card: "intro",
        shelf: "works",
        envelope: "letters",
      },
    };
  if (type === "living")
    return {
      objects: [
        item("door", "door", 83, 82, 19, 3, [79, 82, 27]),
        item("nameplate", "nameplate", 83, 43, 11, 5, [79, 47, 18]),
        item("board", "noticeboard", 32, 44, 31, 3, [34, 39, 45]),
        item("sofa", "sofa", 29, 82, 34, 3, [30, 82, 43]),
        item("table", "coffee-table", 54, 87, 23, 5, [53, 87, 33]),
        item("guide", "guide", 55, 78, 10, 6, [53, 79, 17]),
        item("plant", "plant-tall", 65, 81, 9, 3, [59, 82, 11]),
        item("lamp", "floor-lamp", 11, 81, 10, 2, [12, 82, 10]),
        item("window", "window", 60, 36, 15, 2, [68, 27, 22]),
        item("rug", "rug", 42, 94, 49, 1, [42, 94, 66]),
      ],
      hotspots: { door: "hall", board: "board", guide: "guide" },
    };
  const start = (page - 1) * 3,
    n = Math.min(3, Math.max(0, count - start));
  const xs = n === 1 ? [50] : n === 2 ? [31, 70] : [22, 51, 80];
  const objects = [],
    hotspots = {};
  for (let i = 0; i < n; i++) {
    const r = start + i + 1;
    objects.push(
      item(`door-${r}`, "door", xs[i], 79, n === 1 ? 21 : 19, 3, [50, 79, 24]),
    );
    objects.push(
      item(
        `sign-${r}`,
        "nameplate",
        xs[i],
        41,
        n === 1 ? 13 : 12,
        5,
        [50, 41, 18],
      ),
    );
    hotspots[`door-${r}`] = `room:${r}`;
    hotspots[`sign-${r}`] = `room:${r}`;
  }
  if (n) objects.push(item("plant", "plant", 9, 82, 7, 3, [16, 82, 10]));
  return { objects, hotspots };
}
function parentOf(o, type) {
  if (o.id.startsWith("sign-")) return `door-${o.id.slice(5)}`;
  return (
    (type === "room"
      ? { card: "desk", lamp: "desk", curtains: "window", nameplate: "door" }
      : { guide: "table", nameplate: "door" })[o.id] || null
  );
}

/** @param {string} type @param {number} count @param {number} page @param {string[]|null} residentIds @returns {import("./scene.mjs").Template} */
export function createTemplate(type, count = 3, page = 1, residentIds = null) {
  if (
    !["living", "hall", "room"].includes(type) ||
    !Number.isInteger(count) ||
    count < 0 ||
    count > 1000 ||
    !Number.isInteger(page) ||
    page < 1 ||
    page > Math.max(1, Math.ceil(count / 3))
  )
    throw Error("HOME_SCENE_INVALID");
  const template = layout(type, count, page);
  if (residentIds) {
    if (
      residentIds.length !== count ||
      new Set(residentIds).size !== count ||
      residentIds.some((id) => !/^[A-Za-z0-9_.-]{1,64}$/.test(id))
    )
      throw Error("HOME_SCENE_INVALID");
    const rename = (id) =>
      id.replace(
        /^(door|sign)-(\d+)$/,
        (_, prefix, n) => `${prefix}-${residentIds[Number(n) - 1]}`,
      );
    template.objects = template.objects.map((o) => ({
      ...o,
      id: rename(o.id),
    }));
    template.hotspots = Object.fromEntries(
      Object.entries(template.hotspots).map(([id, action]) => [
        rename(id),
        action,
      ]),
    );
  }

  return {
    ...template,
    templateId: `paperbook-${type}-v1`,
    boardAssetId: "room-board",
    allInstanceIds:
      type === "hall"
        ? [
            "plant",
            ...Array.from(
              { length: Math.max(count, residentIds ? 0 : 7) },
              (_, i) => [
                `door-${residentIds?.[i] ?? i + 1}`,
                `sign-${residentIds?.[i] ?? i + 1}`,
              ],
            ).flat(),
          ]
        : template.objects.map((o) => o.id),
    objects: template.objects.map((o) => ({
      ...o,
      anchorId: o.id,
      parentId: parentOf(o, type),
      variants: families[o.asset] || [o.asset],
    })),
  };
}
