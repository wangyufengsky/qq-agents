import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { DAY, HOUR } from "../src/home/garden-rules.mjs";
import { setupGardenStory as setup } from "./garden-story-fixtures.mjs";

test("a turned sign pairs the archived crop of that plot with its actual new occupant", (t) => {
  const f = setup(t, "turned-plot-sign");
  const id = f.sow(4, "mint");
  f.advance(10 * HOUR);
  f.harvest(4, id);
  f.sow(4, "radish");
  f.advance(DAY);
  const actor = f.actors[0];
  const opt = f.pick("then_and_now", actor, { plot: 4 }),
    rid = randomUUID();
  const result = f.act(opt, actor, rid);
  assert.match(result.outcome.detail, /4 号地.*薄荷.*樱桃小萝卜/);
  assert(f.act(opt, actor, rid).replayed);
  assert.equal(
    f
      .view(actor)
      .personalGifts.items.filter((i) => i.giftId === "plot-history-sign")
      .length,
    1,
  );
});
test("seed memory reveals the first actual sowing of a crop even after harvest and resowing", (t) => {
  const f = setup(t, "remember-a-seed");
  const id = f.sow(5, "perilla");
  f.advance(8 * HOUR);
  f.harvest(5, id);
  f.sow(8, "perilla");
  f.advance(DAY);
  f.reopen();
  const actor = f.actors[0];
  assert.equal(f.view(actor).event.actions.length, 1);
  const result = f.act(
    f.pick("turn_seed", actor, { cropId: "perilla" }),
    actor,
  );
  assert.match(result.outcome.detail, /晚霞紫苏.*第 1 天.*5 号地/);
  const card = f
    .view(actor)
    .personalGifts.items.find((i) => i.giftId === "remembered-seed-card");
  assert.equal(card.craftMeta.plantId, id);
});
test("the garden group portrait uses today's care evidence and does not sign for an absent role", (t) => {
  const f = setup(t, "garden-group-photo");
  f.sow(3, "perilla");
  f.advance(DAY);
  const [gardener, guest] = f.actors;
  const plantId = f.act(
    {
      kind: "plant",
      plot: 2,
      cropId: "perilla",
      buyPrice: f.garden.requireState().settings.crops.perilla.seedPrice,
    },
    gardener,
  ).plantId;
  f.act({ kind: "water", plot: 2, plantId }, gardener);
  const photo = f.act(f.pick("photo_can", guest), guest);
  assert.match(photo.outcome.detail, /水壶/);
  const item = f
    .view(guest)
    .personalGifts.items.find((i) => i.giftId === "garden-group-photo");
  assert.deepEqual(item.craftMeta.carers, [gardener.id]);
  assert(item.craftMeta.careFactIds.length);
  assert(!f.view(gardener).communityShelves.length);
});
test("poetry keeps the real first line across days and two visitors can keep a shorter poem", (t) => {
  const f = setup(t, "four-line-poem");
  const [a, b] = f.actors;
  const opening = f.view(a).event.outcome.detail;
  assert(opening.includes("九块地"));
  const event = f.view(a).event.id;
  f.act({ ...f.pick("add_line", a), text: "借一瓣清风给你。" }, a);
  f.advance(DAY);
  f.reopen();
  const optional = f.view(b).gardenProjects.find((p) => p.id === event);
  assert.match(optional.detail, /借一瓣清风/);
  f.act(f.pick("keep_poem", b, {}, event), b);
  const poem = f
    .view(b)
    .personalGifts.items.find((i) => i.giftId === "four-line-poem-card");
  assert.deepEqual(poem.craftMeta.lines, [opening, "借一瓣清风给你。"]);
  assert.equal(
    f.view(a).gardenProjects.some((p) => p.id === event),
    false,
  );
});
test("wind chime can keep the note of an actual vine or release it without damaging the crop", (t) => {
  for (const mode of ["untangle", "keep_tone"]) {
    const f = setup(t, "wind-chime-extra");
    const plantId = f.sow(7, "rattle-pea");
    f.act({ kind: "build_facility", facilityId: "weather_chime", price: 280 });
    f.advance(DAY);
    const actor = f.actors[0],
      result = f.act(f.pick(mode, actor, { plot: 7 }), actor);
    assert.match(result.outcome.detail, /7 号地.*响铃豌豆/);
    assert.equal(f.garden.requireState().plots[6].plant.id, plantId);
  }
});
