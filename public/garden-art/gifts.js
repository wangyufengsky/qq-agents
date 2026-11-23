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
};
