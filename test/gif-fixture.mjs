// Tiny synthetic GIF encoder: clear the LZW dictionary before each palette index
// so the test fixture has an independently understandable, fixed 3-bit encoding.
export function gif(frames, { width = 3, height = 2 } = {}) {
  const screen = Buffer.alloc(7);
  screen.writeUInt16LE(width, 0);
  screen.writeUInt16LE(height, 2);
  screen[4] = 0x81;
  screen[5] = 3;
  const parts = [
    Buffer.from("GIF89a"),
    screen,
    Buffer.from([255, 0, 0, 0, 255, 0, 0, 0, 255, 0, 0, 0]),
    // Infinite looping must still decode only one cycle.
    Buffer.from([0x21, 0xff, 11]),
    Buffer.from("NETSCAPE2.0"),
    Buffer.from([3, 1, 0, 0, 0]),
  ];
  for (const frame of frames) {
    const control = Buffer.from([
      0x21,
      0xf9,
      4,
      ((frame.disposal ?? 1) << 2) | 1,
      0,
      0,
      3,
      0,
    ]);
    control.writeUInt16LE(frame.delay ?? 10, 4);
    const w = frame.width ?? width,
      h = frame.height ?? height;
    const descriptor = Buffer.alloc(10);
    descriptor[0] = 0x2c;
    descriptor.writeUInt16LE(frame.x ?? 0, 1);
    descriptor.writeUInt16LE(frame.y ?? 0, 3);
    descriptor.writeUInt16LE(w, 5);
    descriptor.writeUInt16LE(h, 7);
    const pixels = frame.pixels ?? Array(w * h).fill(frame.color ?? 0);
    const codes = [...pixels.flatMap((p) => [4, p]), 5];
    const data = Buffer.alloc(Math.ceil((codes.length * 3) / 8));
    codes.forEach((code, i) => {
      const bit = i * 3,
        byte = Math.floor(bit / 8),
        shift = bit % 8;
      data[byte] |= code << shift;
      if (shift > 5) data[byte + 1] |= code >> (8 - shift);
    });
    parts.push(control, descriptor, Buffer.from([2]));
    for (let p = 0; p < data.length; p += 255) {
      const block = data.subarray(p, p + 255);
      parts.push(Buffer.from([block.length]), block);
    }
    parts.push(Buffer.from([0]));
  }
  return Buffer.concat([...parts, Buffer.from([0x3b])]);
}
