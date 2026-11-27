import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";
import {
  gardenArtMarkup,
  gardenGifts,
  gardenIconFile,
  gardenLayers,
  isGardenArtImage,
  isGardenArtResource,
} from "../public/garden-art/art.js";

test("all runtime garden artwork is WebP and individually allowlisted", async () => {
  const directory = new URL("../public/garden-art/", import.meta.url);
  const files = (await readdir(directory)).filter((file) =>
    file.endsWith(".webp"),
  );
  assert.equal(files.length, 73);
  assert.equal(isGardenArtResource("gifts.js"), true);
  assert.equal(isGardenArtResource("workspace.js"), true);
  assert.equal(isGardenArtResource("stages.js"), true);
  for (const [group, id] of [
    ["event", "stray-cat"],
    ["gift", "dried-fish"],
    ["supply", "fertilizer"],
    ["crop", "mint"],
    ["crop", "catnip"],
    ["crop", "mistbell"],
  ])
    assert.ok(files.includes(gardenIconFile(group, id)));
  assert.equal(Object.keys(gardenGifts).length, 43);
  for (const [id, gift] of Object.entries(gardenGifts)) {
    if (gift.eventOnly) {
      assert.equal(
        gift.usable,
        [
          "craft-strawberry-jam",
          "craft-mint-tea",
          "craft-roasted-corn",
        ].includes(id),
      );
      assert.equal(gardenIconFile("gift", id), "gift-wrapped.webp");
      assert.equal(isGardenArtImage(`gift-${id}.webp`), false);
      continue;
    }
    const specific = `gift-${id}.webp`;
    assert.equal(gardenIconFile("gift", id), specific);
    assert.ok(files.includes(specific), specific);
    assert.ok(isGardenArtResource(specific), specific);
  }
  for (const id of ["morning-glory", "rattle-pea", "balsam", "lambs-ear"])
    assert.equal(gardenIconFile("crop", id), "plant-seedling.webp");
  assert.equal(gardenIconFile("gift", "../gift"), null);
  assert.equal(gardenIconFile("gift", "constructor"), null);
  for (const file of files) {
    assert.equal(isGardenArtImage(file), true, file);
    const bytes = await readFile(new URL(file, directory));
    assert.equal(bytes.toString("ascii", 0, 4), "RIFF", file);
    assert.equal(bytes.toString("ascii", 8, 12), "WEBP", file);
  }
  assert.equal(isGardenArtResource("art.js"), true);
  assert.equal(isGardenArtResource("../art.js"), false);
  assert.equal(isGardenArtResource("unlisted.webp"), false);
});

test("garden artwork layers follow crop stages and omit an unillustrated crop", () => {
  const plant = {
    cropId: "clover",
    status: "growing",
    growth: 1,
    crop: { hours: 12 },
    water: 9,
    rules: { lowWater: 10 },
  };
  assert.deepEqual(
    gardenLayers({ plant, sheltered: true }).map(({ file }) => file),
    [
      "soil-low.webp",
      "shelter-back.webp",
      "plant-seedling.webp",
      "shelter-front.webp",
    ],
  );
  assert.deepEqual(
    gardenLayers({
      plant: { ...plant, growth: 9, water: 100 },
      sheltered: false,
    }).map(({ file }) => file),
    ["soil-saturated.webp", "plant-clover-growing.webp"],
  );
  const custom = gardenLayers({
    plant: { ...plant, cropId: "new-crop" },
    sheltered: false,
  });
  assert.deepEqual(
    custom.map(({ file }) => file),
    ["soil-low.webp"],
  );
  assert.equal(
    gardenArtMarkup(custom, () => undefined),
    "",
  );
});
