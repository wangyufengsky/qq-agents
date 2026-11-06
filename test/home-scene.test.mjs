import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import { createHash } from "node:crypto";
import { catalog } from "../public/home-preview/catalog.mjs";
import { createTemplate } from "../public/home-preview/templates.mjs";
import {
  makeScene,
  validateScene,
  resolveScene,
} from "../public/home-preview/scene.mjs";
import { createServer } from "../src/server.mjs";
import { fixture } from "./helpers.mjs";

const room = () => createTemplate("room");
test("home assets have verified WebP bytes, bounded display rectangles and provenance", () => {
  assert.equal(Object.keys(catalog).length, 27);
  let total = 0;
  for (const [id, a] of Object.entries(catalog)) {
    const b = fs.readFileSync(
      new URL(`../public/home-preview/${a.file}`, import.meta.url),
    );
    assert.equal(b.subarray(8, 12).toString(), "WEBP");
    assert.equal(b.length, a.bytes);
    assert.equal(createHash("sha256").update(b).digest("hex"), a.sha256);
    assert.equal(a.transparent, id !== "room-board");
    assert.match(a.sourceSha256, /^[a-f0-9]{64}$/);
    assert.equal(a.license, "MIT");
    const [x, y, w, h] = a.bounds;
    assert.ok(
      x >= 0 &&
        y >= 0 &&
        w > 0 &&
        h > 0 &&
        x + w <= a.width &&
        y + h <= a.height,
    );
    total += b.length;
  }
  assert.ok(total < 8_000_000);
});
test("home templates use stable anchors, semantic actions and bounded hall pagination", () => {
  for (const count of [0, 1, 2, 3, 4, 7]) {
    const doors = [];
    for (let page = 1; page <= Math.max(1, Math.ceil(count / 3)); page++) {
      const t = createTemplate("hall", count, page);
      const scene = makeScene(t, "hall");
      for (const mobile of [false, true]) {
        const objects = resolveScene(scene, t, catalog, mobile);
        assert.ok(
          objects.every((o) => o.anchorId === o.id && Number.isFinite(o.x)),
        );
      }
      const ds = t.objects.filter((o) => o.id.startsWith("door-"));
      assert.ok(ds.length <= 3);
      doors.push(...ds.map((o) => o.id));
    }
    assert.deepEqual(
      doors,
      Array.from({ length: count }, (_, i) => `door-${i + 1}`),
    );
  }
  assert.throws(() => createTemplate("hall", 7, 4), /HOME_SCENE_INVALID/);
  assert.throws(() => createTemplate("unknown"), /HOME_SCENE_INVALID/);
});
test("home child papers inherit movement, scale, mirror and hiding on both layouts", () => {
  const t = room(),
    scene = makeScene(t, "room-1");
  for (const mobile of [false, true]) {
    const before = resolveScene(scene, t, catalog, mobile);
    scene.objects = {
      desk: { dx: 5, dy: -2, scale: 1.1, hidden: true, flip: true, z: 8 },
    };
    const after = resolveScene(scene, t, catalog, mobile);
    const desk = after.find((o) => o.id === "desk"),
      card = after.find((o) => o.id === "card");
    const oldDesk = before.find((o) => o.id === "desk"),
      oldCard = before.find((o) => o.id === "card");
    assert.ok(
      Math.abs(card.x - (desk.x - (oldCard.x - oldDesk.x) * 1.1)) < 1e-8,
    );
    assert.ok(Math.abs(card.w - oldCard.w * 1.1) < 1e-8);
    assert.equal(card.hidden, true);
    assert.equal(card.flip, true);
    assert.equal(card.z, 9);
    assert.equal(t.hotspots.card, "intro");
    scene.objects = {};
  }
});
test("home catalog variants and palettes preserve semantic entries", () => {
  const t = room(),
    scene = makeScene(t, "room-1");
  scene.objects = {
    desk: { asset: "desk-simple", assetVersion: 1 },
    shelf: { hidden: true },
  };
  scene.palette = "blue";
  const objects = resolveScene(scene, t, catalog, false);
  assert.equal(objects.find((o) => o.id === "desk").asset, "desk-simple");
  assert.equal(objects.find((o) => o.id === "bed").asset, "bed-blue");
  assert.equal(objects.find((o) => o.id === "rug").asset, "rug-blue");
  assert.equal(t.hotspots.shelf, "works");
  assert.equal(t.hotspots.envelope, "letters");
  assert.ok(!JSON.stringify(scene).includes('"base"'));
});
test("home rejects invalid saved layouts, unknown fields, versions and unsafe substitutions", () => {
  const t = room();
  const invalid = [
    null,
    [],
    { ...makeScene(t, "room-1"), schemaVersion: 2 },
    { ...makeScene(t, "room-1"), palette: "unknown" },
    {
      ...makeScene(t, "room-1"),
      hotspots: { card: "https://example.invalid" },
    },
  ];
  for (const objects of [
    { desk: { asset: "bed" } },
    { desk: { assetVersion: 2 } },
    { desk: { scale: NaN } },
    { desk: { dx: Infinity } },
    { desk: { z: 2.5 } },
    { desk: { hidden: "true" } },
    { desk: { dx: 7 } },
    { desk: { scale: 0 } },
    { unknown: {} },
    { desk: { src: "https://example.invalid" } },
    JSON.parse('{"__proto__":{}}'),
  ])
    invalid.push({ ...makeScene(t, "room-1"), objects });
  for (const value of invalid)
    assert.throws(() => validateScene(value, t, catalog), /HOME_SCENE_INVALID/);
  const cycle = room();
  cycle.objects.find((o) => o.id === "desk").parentId = "card";
  assert.throws(
    () => resolveScene(makeScene(cycle, "room-1"), cycle, catalog, false),
    /HOME_SCENE_INVALID/,
  );
  const missing = room();
  missing.objects[0].parentId = "absent";
  assert.throws(
    () => resolveScene(makeScene(missing, "room-1"), missing, catalog, false),
    /HOME_SCENE_INVALID/,
  );
});
test("home sample routes keep console host/origin checks, deny writes and arbitrary files", async (t) => {
  const f = fixture(t),
    app = createServer({
      runtime: f.runtime,
      token: "test-admin-token-placeholder",
    });
  const port = await app.listen();
  t.after(() => app.close());
  const base = `http://127.0.0.1:${port}`;
  const html = await fetch(base + "/home-preview/");
  assert.equal(html.status, 200);
  assert.match(await html.text(), /场景预览 · 全部为示例/);
  assert.match(
    html.headers.get("content-security-policy"),
    /connect-src 'none'/,
  );
  assert.match(
    (await fetch(base + "/home-preview/scene.mjs")).headers.get("content-type"),
    /javascript/,
  );
  const image = await fetch(base + "/home-preview/assets/door.webp", {
    method: "HEAD",
  });
  assert.equal(image.status, 200);
  assert.equal(image.headers.get("content-type"), "image/webp");
  assert.equal(await image.text(), "");
  const font = await fetch(base + "/home-space/paper-nest-hand-v1.530.woff2", {
    method: "HEAD",
  });
  assert.equal(font.status, 200);
  assert.equal(font.headers.get("content-type"), "font/woff2");
  assert.match(font.headers.get("cache-control"), /immutable/);
  assert.equal(await font.text(), "");
  assert.equal((await fetch(base + "/home-space/unknown.woff2")).status, 404);
  assert.equal(
    (await fetch(base + "/home-space/")).headers.get("cache-control"),
    "no-store",
  );
  assert.equal(
    (await fetch(base + "/home-preview/", { method: "POST" })).status,
    405,
  );
  for (const file of [
    "config.json",
    "assets/unknown.webp",
    "%2e%2e%2fpackage.json",
    "assets/%2e%2e/package.json",
  ])
    assert.equal((await fetch(base + "/home-preview/" + file)).status, 404);
  assert.equal(
    (
      await fetch(base + "/home-preview/", {
        headers: { origin: "https://example.invalid" },
      })
    ).status,
    403,
  );
  const foreignHost = await new Promise((resolve, reject) => {
    const req = http.get(
      base + "/home-preview/",
      { headers: { host: "example.invalid" } },
      (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode));
      },
    );
    req.on("error", reject);
  });
  assert.equal(foreignHost, 403);
  assert.equal((await fetch(base + "/api/config")).status, 401);
});
