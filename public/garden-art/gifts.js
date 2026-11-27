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

/** @typedef {{ingredients: {cropName:string,quality:string,maturedDay?:number,carers?:string[]}[]}} GardenCraftOrigin */
/** @param {GardenCraftOrigin|undefined|null} meta */
export function gardenCraftOrigin(meta) {
  if (!meta?.ingredients?.length) return "";
  const qualityNames = /** @type {Record<string, string>} */ ({
    ordinary: "普通",
    fine: "优良",
    perfect: "完美",
  });
  return `原料 · ${meta.ingredients
    .map((item) => {
      const when =
        item.maturedDay == null ? "" : `第 ${item.maturedDay} 天成熟的`;
      const quality = qualityNames[item.quality];
      const who = item.carers?.length
        ? `（${item.carers.join("、")}照料）`
        : "";
      return `${when}${quality ? quality + "品质的" : ""}${item.cropName}${who}`;
    })
    .join("；")}`;
}
