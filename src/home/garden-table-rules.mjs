export const tableStories = {
  "half-perilla-cloth": [
    "perilla_cloth",
    "只印了一半的方巾",
    "挑一株已有叶子的紫苏印半块方巾。可以收好，也可以把空出来的半边留给后来者。",
  ],
  "first-popcorn": [
    "popcorn",
    "玉米爆出第一朵花",
    "从真正晒干的玉米中挑一份爆香，为先跳起来的那颗留个名字。",
  ],
  "pumpkin-face": [
    "pumpkin_face",
    "南瓜刻脸铺",
    "用一只硬皮小南瓜开始刻脸，刻过眼睛就可以点灯，也可补刻嘴巴。",
  ],
  "last-spoon-jam": [
    "jam_spoon",
    "果酱瓶底还剩一勺",
    "从自己真实做成的草莓果酱瓶里刮出最后一勺，留下来源。",
  ],
  "wobbly-bench": [
    "bench",
    "一把不够长的长椅",
    "长椅有一条短腿。用木片或倒扣的空花盆垫高，坐下看看园里。",
  ],
  "melting-mint-ice": [
    "mint_ice",
    "薄荷冰块慢慢化",
    "盛夏的冰格里有三块薄荷冰。早来尝碎冰，晚来还有薄荷水。",
  ],
  "nest-materials": [
    "nest_edge",
    "织巢师傅挑材料",
    "选真实收成给巢缘加材料，明天看看不同材料留下的样子。",
  ],
  "mixed-menu": [
    "menu",
    "写错名字的菜牌",
    "用一份园中收成做小菜，一起尝味猜原料，或者给这桌菜起个名字。",
  ],
  "exchange-color": [
    "color_swap",
    "交换一个颜色",
    "选两种真正收获过的花材或紫苏，各调一道，留下一张色样卡。",
  ],
  "last-window-lamp": [
    "window_lamp",
    "请把最后一盏留在窗边",
    "物主可主动借出自己的南瓜灯，在窗边留一夜。明早归还原物。",
  ],
};

export const tableStoryIds = Object.values(tableStories).map(
  ([story]) => story,
);
export const tablePresets = Object.fromEntries(
  Object.entries(tableStories).map(([id, [story, name]]) => [
    id,
    {
      name,
      effect: { kind: "table", story },
      weight: 2,
      enabled: true,
      mode: "all",
      conditions: [],
    },
  ]),
);
export const tableDescription = (story) =>
  Object.values(tableStories).find(([id]) => id === story)?.[2];
export const colorCrops = [
  "sunflower",
  "moonflower",
  "mistbell",
  "catnip",
  "hydrangea",
  "chamomile",
  "perilla",
  "morning-glory",
  "balsam",
];

export function tableAvailable(story, ctx, weather) {
  const stock = (id) => (ctx.harvests[id] ?? 0) > 0;
  switch (story) {
    case "popcorn":
      return ctx.tableLots?.some(
        (row) => row.crop_id === "sweet-corn" && row.harvest_stage === "dry",
      );
    case "bench":
      return Boolean(ctx.plots?.length);
    case "mint_ice":
      return weather?.kind === "sun" && stock("mint");
    case "menu":
      return Object.values(ctx.harvests).some((quantity) => quantity > 0);
    case "perilla_cloth":
      return ctx.plots?.some(
        ({ plant }) => plant?.cropId === "perilla" && plant.status === "mature",
      );
    case "pumpkin_face":
      return ctx.tableLots?.some(
        (row) =>
          row.crop_id === "pocket-pumpkin" && row.harvest_stage === "hard",
      );
    case "jam_spoon":
      return (ctx.tableItems?.["craft-strawberry-jam"] ?? 0) > 0;
    case "nest_edge":
      return stock("lambs-ear") || stock("sweet-corn");
    case "color_swap":
      return colorCrops.filter(stock).length >= 2;
    case "window_lamp":
      return (
        (ctx.tableItems?.["pumpkin-lantern"] ?? 0) +
          (ctx.tableItems?.["craft-pumpkin-lantern"] ?? 0) >
        0
      );
    default:
      return false;
  }
}
