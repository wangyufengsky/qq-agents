// @ts-check
export const giftShelfCapacity = 16;
export const giftShelfSlots = Array.from(
  { length: giftShelfCapacity },
  (_, index) => index + 1,
);
export const gardenGifts = {
  "dried-fish": { name: "小鱼干", price: 12, usable: true },
  "yarn-ball": { name: "毛线球", price: 18, usable: false },
  "pressed-bookmark": { name: "压花书签", price: 24, usable: false },
  "catnip-candy": { name: "薄荷糖罐", price: 15, usable: true },
  "sunflower-cookie": { name: "葵花籽曲奇", price: 16, usable: true },
  "strawberry-milk": { name: "草莓牛奶", price: 20, usable: true },
  "watercolor-postcard": { name: "花园水彩明信片", price: 22, usable: false },
  "scented-sachet": { name: "干花香囊", price: 26, usable: false },
  "clover-charm": { name: "四叶草挂坠", price: 28, usable: false },
  "origami-dragon": { name: "纸折小龙摆件", price: 32, usable: false },
  "ceramic-mug": { name: "手绘小猫马克杯", price: 36, usable: false },
  "raindrop-bell": { name: "晴雨小风铃", price: 42, usable: false },
  "moonlight-lantern": { name: "夜来香小夜灯", price: 48, usable: false },
  "bubble-tea-jelly": { name: "海盐冒泡汽水冻", price: 16, usable: true },
  "sea-glass-bottle": { name: "海玻璃漂流瓶", price: 26, usable: false },
  "coral-pen-rest": { name: "迷你珊瑚笔搁", price: 30, usable: false },
  "water-lily-bowl": { name: "迷你睡莲水碗", price: 34, usable: false },
  "shell-music-box": { name: "贝壳珍珠八音盒", price: 45, usable: false },
  "craft-pressed-flower": {
    name: "手作压花书签",
    price: 0,
    usable: false,
    eventOnly: true,
  },
  "craft-lambs-ear-bookmark": {
    name: "绒耳叶压花书签",
    price: 0,
    usable: false,
    eventOnly: true,
  },
  "craft-strawberry-jam": {
    name: "手作草莓果酱",
    price: 0,
    usable: true,
    eventOnly: true,
  },
  "craft-mint-tea": {
    name: "冰薄荷茶",
    price: 0,
    usable: true,
    eventOnly: true,
  },
  "craft-chamomile-sachet": {
    name: "洋甘菊香囊",
    price: 0,
    usable: false,
    eventOnly: true,
  },
  "craft-flower-bouquet": {
    name: "晴雨干花束",
    price: 0,
    usable: false,
    eventOnly: true,
  },
  "craft-mistbell-jar": {
    name: "星雾夜光瓶",
    price: 0,
    usable: false,
    eventOnly: true,
  },
  "craft-perilla-print": {
    name: "晚霞紫苏叶拓",
    price: 0,
    usable: false,
    eventOnly: true,
  },
  "craft-roasted-corn": {
    name: "烤奶油甜玉米",
    price: 0,
    usable: true,
    eventOnly: true,
  },
  "craft-corn-rattle": {
    name: "玉米沙锤",
    price: 0,
    usable: false,
    eventOnly: true,
  },
  "craft-pumpkin-lantern": {
    name: "手刻南瓜灯",
    price: 0,
    usable: false,
    eventOnly: true,
  },
  "perilla-half-cloth": {
    name: "紫苏半块方巾",
    price: 0,
    usable: false,
    eventOnly: true,
  },
  "perilla-printed-cloth": {
    name: "紫苏对印方巾",
    price: 0,
    usable: false,
    eventOnly: true,
  },
  "pumpkin-lantern": {
    name: "南瓜灯",
    price: 0,
    usable: false,
    eventOnly: true,
  },
  "mixed-color-swatches": {
    name: "合色样卡",
    price: 0,
    usable: false,
    eventOnly: true,
  },
  "craft-paper-moon-string": {
    name: "纸月串",
    price: 0,
    usable: false,
    eventOnly: true,
  },
  "gourd-dipper": {
    name: "漂流葫芦水瓢",
    price: 0,
    usable: false,
    eventOnly: true,
  },
  "drift-gourd": { name: "漂流葫芦", price: 0, usable: false, eventOnly: true },
  "paper-moon-night-card": {
    name: "纸月拓影卡",
    price: 0,
    usable: false,
    eventOnly: true,
  },
  "plot-history-sign": {
    name: "地块双面木牌",
    price: 0,
    usable: false,
    eventOnly: true,
  },
  "garden-group-photo": {
    name: "园丁缺席的合影",
    price: 0,
    usable: false,
    eventOnly: true,
  },
  "four-line-poem-card": {
    name: "园里的四行诗",
    price: 0,
    usable: false,
    eventOnly: true,
  },
  "remembered-seed-card": {
    name: "初播种子卡",
    price: 0,
    usable: false,
    eventOnly: true,
  },
  "garden-sketch-card": {
    name: "花园速写画",
    price: 0,
    usable: false,
    eventOnly: true,
  },
  "migratory-feather": {
    name: "候鸟羽毛书签",
    price: 0,
    usable: false,
    eventOnly: true,
  },
};

/** @param {string} id */
export function isGardenMerchantGift(id) {
  const gift = gardenGifts[/** @type {keyof typeof gardenGifts} */ (id)];
  return Object.hasOwn(gardenGifts, id) && !("eventOnly" in gift);
}

/** @typedef {{ingredients: {cropName:string,quality:string,maturedDay?:number,carers?:string[],leafShape?:string,ear?:number,harvestStage?:"tender"|"dry"|"hard"|"floating"|"bloom"|"green"|"silver",leafFront?:string,leafBack?:string,color?:string}[],makers?:string[],makerRefs?:{kind:string,id:string,name:string}[],mothMark?:boolean}} GardenCraftOrigin */
/** @param {GardenCraftOrigin|undefined|null} meta */
export function gardenCraftOrigin(meta) {
  if (!meta?.ingredients?.length) return "";
  const qualityNames = /** @type {Record<string, string>} */ ({
    ordinary: "普通",
    fine: "优良",
    perfect: "完美",
  });
  const materials = `原料 · ${meta.ingredients
    .map((item) => {
      const when =
        item.maturedDay == null ? "" : `第 ${item.maturedDay} 天成熟的`;
      const quality = qualityNames[item.quality];
      const who = item.carers?.length
        ? `（${item.carers.join("、")}照料）`
        : "";
      const descriptors = [
        item.leafShape,
        item.color ? `色样${item.color}` : "",
        item.leafFront ? `叶面${item.leafFront}` : "",
        item.leafBack ? `叶背${item.leafBack}` : "",
        item.ear ? `第 ${item.ear} 穗` : "",
        item.harvestStage &&
          {
            tender: "鲜嫩",
            dry: "干熟",
            hard: "硬皮",
            floating: "适合漂流",
            bloom: "花期",
            green: "青荚",
            silver: "银荚",
          }[item.harvestStage],
      ].filter(Boolean);
      const shape = descriptors.length ? `（${descriptors.join("、")}）` : "";
      return `${when}${quality ? quality + "品质的" : ""}${item.cropName}${shape}${who}`;
    })
    .join("；")}`;
  const refs = meta.makerRefs ?? [];
  const signatures = refs.length
    ? refs.map(({ name, id }) =>
        refs.filter((ref) => ref.name === name).length > 1
          ? `${name}（${id}）`
          : name,
      )
    : (meta.makers ?? []);
  return [
    materials,
    ...(signatures.length ? [`署名 · ${signatures.join("、")}`] : []),
    ...(meta.mothMark ? ["窗边留下一道蛾灰印"] : []),
  ].join(" · ");
}
