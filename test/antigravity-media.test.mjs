import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { AntigravityMedia } from "../src/backends/antigravity-media.mjs";
import { antigravityToolAllowed } from "../src/backends/antigravity-guard.mjs";
import { safeToolFailure } from "../src/tools/errors.mjs";
import { colorGrid } from "../scripts/fixtures/antigravity-media.mjs";
import { MediaStore } from "../src/tools/media.mjs";
import { gif } from "./gif-fixture.mjs";
const image = (colors) => ({
  type: "image",
  mimeType: "image/png",
  data: colorGrid(colors).toString("base64"),
});
const first = image(["red", "green", "blue", "yellow"]);
const second = image(["blue", "yellow", "red", "green"]);
const fixture = () => ({
  content: [
    { type: "text", text: '{"sampled":true,"complete":false}' },
    first,
    { type: "text", text: "frame 7, 700 ms" },
    second,
  ],
});
const call = (file, extra = {}) => ({
  name: "view_file",
  args: { AbsolutePath: file, ...extra },
});

test("Antigravity registers exact pixels in order and retains partial-frame metadata", (t) => {
  const media = new AntigravityMedia();
  t.after(() => media.close());
  const result = media.result(fixture());
  assert.deepEqual(result.content[0], fixture().content[0]);
  assert.equal(result.content[2].text, "frame 7, 700 ms");
  assert.match(result.content[1].text, /Image 1:.*pixels are not yet visible/);
  assert.match(result.content[3].text, /Image 2:.*view_file/);
  const files = media.catalog();
  assert.deepEqual(
    files.map((f) => fs.readFileSync(f.path).toString("base64")),
    [first.data, second.data],
  );
  for (const f of files)
    assert(antigravityToolAllowed(call(f.path), [], files));
  media.result(fixture());
  assert.equal(media.catalog().length, 2);
  media.close();
  assert(files.every((f) => !fs.existsSync(f.path)));
  assert.equal(antigravityToolAllowed(call(files[0].path), [], files), false);
  assert.throws(() => media.result(fixture()), /ANTIGRAVITY_TURN_INACTIVE/);
});

test("native image grants cannot read other paths, modified pixels, symlinks or old turns", (t) => {
  const media = new AntigravityMedia(),
    next = new AntigravityMedia();
  t.after(() => {
    media.close();
    next.close();
  });
  media.result({ content: [first] });
  next.result({ content: [first] });
  const files = media.catalog(),
    f = files[0];
  assert.equal(
    antigravityToolAllowed(call(f.path, { StartLine: 1 }), [], files),
    false,
  );
  assert.equal(
    antigravityToolAllowed(
      call(path.join(media.directory, "other.png")),
      [],
      files,
    ),
    false,
  );
  assert.equal(antigravityToolAllowed(call(f.path), [], next.catalog()), false);
  const data = fs.readFileSync(f.path);
  data[data.length - 1] ^= 1;
  fs.writeFileSync(f.path, data);
  assert.equal(antigravityToolAllowed(call(f.path), [], files), false);
  fs.rmSync(f.path);
  fs.symlinkSync(next.catalog()[0].path, f.path, "file");
  assert.equal(antigravityToolAllowed(call(f.path), [], files), false);
});

test("image registration fails atomically for unsupported, animated or excessive results", (t) => {
  const media = new AntigravityMedia();
  t.after(() => media.close());
  for (const content of [
    [first, { ...second, mimeType: "image/jpeg" }],
    [first, { ...second, data: Buffer.from("not png").toString("base64") }],
  ])
    assert.throws(() => media.result({ content }), /ANTIGRAVITY_MEDIA_FORMAT/);
  const animated = Buffer.concat([
    Buffer.from(first.data, "base64").subarray(0, 33),
    Buffer.from([0, 0, 0, 8]),
    Buffer.from("acTL"),
    Buffer.alloc(12),
  ]);
  assert.throws(
    () =>
      media.result({
        content: [{ ...first, data: animated.toString("base64") }],
      }),
    /ANTIGRAVITY_MEDIA_FORMAT/,
  );
  assert.throws(
    () => media.result({ content: Array(11).fill(first) }),
    /ANTIGRAVITY_MEDIA_LIMIT/,
  );
  assert.throws(
    () =>
      media.result({
        content: [{ ...first, data: "A".repeat(12 * 1024 * 1024 + 1) }],
      }),
    /ANTIGRAVITY_MEDIA_LIMIT/,
  );
  assert.equal(media.catalog().length, 0);
  const failure = safeToolFailure(Error("ANTIGRAVITY_MEDIA_FORMAT"));
  assert.match(failure.hint, /pixels were not delivered/);
});

test("plain and failed results grant no native file access", (t) => {
  const media = new AntigravityMedia();
  t.after(() => media.close());
  for (const value of [
    { content: [{ type: "text", text: "plain" }] },
    { ...fixture(), isError: true },
  ])
    assert.equal(media.result(value), value);
  assert.equal(media.catalog().length, 0);
});

test("single-frame GIF tool results become visible PNG pixels without changing the source", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "qq-agy-single-gif-"));
  const store = new MediaStore(root),
    media = new AntigravityMedia();
  t.after(() => {
    media.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const source = gif([{ color: 2 }]);
  const saved = store.put("a", source, "image/gif");
  const result = await store.view("a", saved.id);
  assert.equal(result.content[1].mimeType, "image/gif");
  const transformed = await media.fromTool(
    result,
    new AbortController().signal,
  );
  assert.deepEqual(transformed.content[0], result.content[0]);
  const file = media.catalog()[0];
  assert(file.path.endsWith(".png"));
  const pixels = execFileSync(
    "ffmpeg",
    [
      "-v",
      "error",
      "-i",
      file.path,
      "-f",
      "rawvideo",
      "-pix_fmt",
      "rgba",
      "pipe:1",
    ],
    { timeout: 5000 },
  );
  assert.deepEqual([...pixels.subarray(0, 4)], [0, 0, 255, 255]);
  assert.equal(store.read("a", saved.id).data, source.toString("base64"));
  assert(antigravityToolAllowed(call(file.path), [], media.catalog()));
});

test("raw animated GIFs and cancelled conversion never grant image paths", async (t) => {
  const media = new AntigravityMedia();
  t.after(() => media.close());
  const result = {
    content: [
      {
        type: "image",
        mimeType: "image/gif",
        data: gif([{ color: 0 }, { color: 1 }]).toString("base64"),
      },
    ],
  };
  await assert.rejects(
    media.fromTool(result, new AbortController().signal),
    /ANTIGRAVITY_MEDIA_FORMAT/,
  );
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    media.fromTool(fixture(), controller.signal),
    /ANTIGRAVITY_TURN_INACTIVE/,
  );
  assert.equal(media.catalog().length, 0);
});
