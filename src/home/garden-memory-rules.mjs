export const memoryStories = {
  "drift-gourd-returns": [
    "drift_gourd",
    "漂流葫芦回来了",
    "找一只已经能浮起来的葫芦送出去，等它带着路上真实的水痕回来。",
  ],
  "turned-plot-sign": ["old_sign", "旧木牌翻过面", "看看地块过去留下了什么。"],
  "old-nine-plot-photo": [
    "old_photo",
    "九格里的旧照片",
    "从花园曾留存的九格照片挑一天，再选一格对照今日。",
  ],
  "future-garden-jar": [
    "future_jar",
    "给未来的自己埋个罐子",
    "选一片真实的叶，等两次花开或三个实际雨日再拆罐。",
  ],
  "paper-moon-shadow": [
    "paper_shadow",
    "纸月拓影夜",
    "夜里拿自己的南瓜灯照一株植物，以真实银荚留下拓影。",
  ],
  "garden-group-photo": [
    "group_photo",
    "园丁缺席的合影",
    "看看今天哪些照料已经留在花园。",
  ],
  "four-line-poem": [
    "poem",
    "一首没写完的四行诗",
    "沿着今天园里已经留下的第一行继续写。",
  ],
  "wind-chime-extra": ["wind_note", "风铃今天多响了一声", "来听听晴雨风铃。"],
  "remember-a-seed": [
    "seed_memory",
    "从种子认出你",
    "从曾经确实播种的种子里挑一粒，翻开第一次落土的年月和地块。",
  ],
  "seasonal-door-display": [
    "gate_display",
    "这一季门口挂什么",
    "从自己的几件花园纪念物里选一种样式，原物还归自己。",
  ],
};

export const memoryStoryIds = Object.values(memoryStories).map(
  ([story]) => story,
);
export const memoryPresets = Object.fromEntries(
  Object.entries(memoryStories).map(([id, [story, name]]) => [
    id,
    {
      name,
      effect: { kind: "memory", story },
      weight: 2,
      enabled: true,
      mode: "all",
      conditions: [],
    },
  ]),
);
export const memoryDescription = (story) =>
  Object.values(memoryStories).find(([id]) => id === story)?.[2];
export const memorySeason = (day) => Math.floor((day - 1) / 7) + 1;
export const memorySceneIds = [
  "old_sign",
  "group_photo",
  "poem",
  "wind_note",
  "seed_memory",
];
export const gateStyleIds = [
  "perilla-half-cloth",
  "craft-corn-rattle",
  "craft-paper-moon-string",
  "drift-gourd",
];
export const lampIds = ["pumpkin-lantern", "craft-pumpkin-lantern"];

export const windSources = (plots) =>
  plots.flatMap(({ id, plant }) => {
    if (!plant) return [];
    const material =
      plant.status === "withered"
        ? plant.crop.name + "的干叶"
        : ["rattle-pea", "drift-gourd"].includes(plant.cropId)
          ? plant.crop.name + "的藤梢"
          : null;
    return material ? [{ plot: id, material, plantId: plant.id }] : [];
  });

export function memoryAvailable(story, ctx) {
  const live = (ctx.plots ?? []).some(
    ({ plant }) => plant && plant.status !== "withered",
  );
  switch (story) {
    case "drift_gourd":
      return ctx.memoryLots?.includes("drift-gourd:floating");
    case "old_photo":
      return ctx.memoryHasPhotos;
    case "future_jar":
      return live;
    case "paper_shadow":
      return (
        live &&
        ctx.memoryLots?.includes("paper-moon:silver") &&
        lampIds.some((id) => ctx.memoryItems?.includes(id))
      );
    case "gate_display":
      return (
        !ctx.memoryGateUsed &&
        gateStyleIds.some((id) => ctx.memoryItems?.includes(id))
      );
    case "old_sign":
      return ctx.hasOldSign;
    case "group_photo":
      return (
        live ||
        ["perilla-half-cloth", "perilla-printed-cloth"].some((id) =>
          ctx.memoryItems?.includes(id),
        )
      );
    case "poem":
      return true;
    case "wind_note":
      return ctx.hasWeatherChime && windSources(ctx.plots ?? []).length > 0;
    case "seed_memory":
      return ctx.hasKnownSeed;
    default:
      return false;
  }
}
