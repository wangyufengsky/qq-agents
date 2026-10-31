import fs from "node:fs";
import path from "node:path";
import { randomInt } from "node:crypto";
import { deflateSync } from "node:zlib";
import { execFileSync } from "node:child_process";

const palette = {
  red: [240, 20, 20],
  green: [20, 180, 20],
  blue: [20, 20, 240],
  yellow: [240, 240, 20],
};
function shuffledColors() {
  const colors = Object.keys(palette);
  for (let i = colors.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [colors[i], colors[j]] = [colors[j], colors[i]];
  }
  return colors;
}
function chunk(type, data) {
  const body = Buffer.concat([Buffer.from(type), data]);
  let crc = 0xffffffff;
  for (const value of body) {
    crc ^= value;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  const out = Buffer.alloc(body.length + 8);
  out.writeUInt32BE(data.length);
  body.copy(out, 4);
  out.writeUInt32BE((crc ^ 0xffffffff) >>> 0, out.length - 4);
  return out;
}
// No text chunks, filenames or metadata disclose the pixel-only answer.
export function colorGrid(colors) {
  const size = 320,
    stride = size * 3 + 1;
  const raw = Buffer.alloc(stride * size);
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const rgb =
        palette[colors[(y >= size / 2 ? 2 : 0) + (x >= size / 2 ? 1 : 0)]];
      for (let c = 0; c < 3; c++) raw[y * stride + 1 + x * 3 + c] = rgb[c];
    }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size);
  header.writeUInt32BE(size, 4);
  header[8] = 8;
  header[9] = 2;
  return Buffer.concat([
    Buffer.from("89504e470d0a1a0a", "hex"),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
export function acceptanceMedia(root) {
  const directory = path.join(root, "synthetic-media");
  fs.mkdirSync(directory, { mode: 0o700 });
  const still = shuffledColors(),
    first = shuffledColors();
  // Distinct frames make order and multi-image handling observable.
  const second = [...first.slice(1), first[0]];
  const png = colorGrid(still);
  fs.writeFileSync(path.join(directory, "still.png"), png, { mode: 0o600 });
  for (const [index, colors] of [first, second].entries())
    fs.writeFileSync(
      path.join(directory, `frame-${index}.png`),
      colorGrid(colors),
      { mode: 0o600 },
    );
  const output = path.join(directory, "animation.gif");
  execFileSync(
    "ffmpeg",
    [
      "-v",
      "error",
      "-nostdin",
      "-framerate",
      "1",
      "-i",
      path.join(directory, "frame-%d.png"),
      "-frames:v",
      "2",
      "-loop",
      "0",
      output,
    ],
    { stdio: "pipe", timeout: 30000 },
  );
  fs.chmodSync(output, 0o600);
  return {
    still: { buffer: png, mimeType: "image/png", colors: still },
    animation: {
      buffer: fs.readFileSync(output),
      mimeType: "image/gif",
      colors: [...first, ...second],
    },
  };
}
