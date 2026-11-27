export const explorers = {
  "pea-guess": [
    "pea_guess",
    "豆荚里住着几个",
    "挑定一株成熟响豆。先听豆荚里的轻响，可以各自猜数，再由一位伙伴开荚。",
  ],
  "snail-silver-map": [
    "snail_map",
    "蜗牛走过的银地图",
    "两块地之间有一道银亮的痕迹。可以跟着去看叶背，也可以画下它走的路线。",
  ],
  "bamboo-rain": [
    "bamboo_rain",
    "竹筒滴答",
    "雨水沿竹筒往下淌。给一块地引水，或放一个空罐听雨。",
  ],
  "sparrow-sandbath": [
    "sparrow_bath",
    "麻雀沙浴场",
    "麻雀在空地边找软沙。留一块空地看脚印，或把软沙挪到过道。",
  ],
  "balsam-dishes": [
    "balsam_game",
    "凤仙弹射赛",
    "园里的凤仙果荚已经成熟。挑左、中、右的一只碟子接弹出的花籽。",
  ],
  "shadow-measure": [
    "shadow_measure",
    "给影子量身高",
    "挑一株在长的植物，为它记下花园标尺。明天这个点再来对照。",
  ],
  "boot-pond": [
    "boot_pond",
    "雨靴里的小池塘",
    "雨靴里攒了水。可以倒给最干的地，或放一只小叶舟。",
  ],
  "leaf-identity": [
    "leaf_identity",
    "两张叶子谁是谁",
    "取两株实在田里长着的植物做题。看叶面线索，从两个候选里认出这张叶子。",
  ],
  "windmill-search": [
    "windmill",
    "小风车找风",
    "选一块地放小风车，再挪一个位置对照，看看哪边的风更适合。",
  ],
  "doorstep-peas": [
    "door_peas",
    "门口留一把豆",
    "有响豆收成时，可以自愿包一份留在门口。后来者能领走豆种，也可以添一幅小画。",
  ],
};

export const explorerStoryIds = Object.values(explorers).map(
  ([story]) => story,
);

export const explorerPresets = Object.fromEntries(
  Object.entries(explorers).map(([id, [story, name]]) => [
    id,
    {
      name,
      effect: { kind: "explorer", story },
      weight: 2,
      enabled: true,
      mode: "all",
      conditions: [],
    },
  ]),
);

export function explorerDescription(story) {
  return Object.values(explorers).find(([key]) => key === story)?.[2];
}

export function explorerAvailable(story, ctx, weather) {
  const plots = ctx.plots ?? [];
  const growing = plots.filter(({ plant }) => plant?.status === "growing");
  const live = plots.filter(
    ({ plant }) => plant && plant.status !== "withered",
  );
  const rain = ["drizzle", "storm"].includes(weather?.kind);
  switch (story) {
    case "pea_guess":
      return plots.some(
        ({ plant }) =>
          plant?.cropId === "rattle-pea" && plant.status === "mature",
      );
    case "snail_map":
      return live.length >= 2;
    case "bamboo_rain":
      return rain;
    case "sparrow_bath":
      return plots.some(({ plant }) => !plant);
    case "balsam_game":
      return plots.some(
        ({ plant }) =>
          plant?.cropId === "balsam" &&
          plant.status === "mature" &&
          !plant.podPopped,
      );
    case "shadow_measure":
      return growing.length > 0;
    case "boot_pond":
      return rain || ["drizzle", "storm"].includes(ctx.previous?.weather?.kind);
    case "leaf_identity":
      return new Set(live.map(({ plant }) => plant.cropId)).size >= 2;
    case "windmill":
      return plots.length >= 2;
    case "door_peas":
      return (ctx.harvests["rattle-pea"] ?? 0) > 0;
    default:
      return false;
  }
}
