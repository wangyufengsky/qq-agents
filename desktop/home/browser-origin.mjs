export function parseBrowserOrigin(value) {
  if (typeof value !== "string") return;
  const input = value.trim();
  if (
    input.length > 300 ||
    !/^https?:\/\/[^/?#@\\\s\p{Cc}\p{Cf}]+\/?$/iu.test(input)
  )
    return;
  const origin = URL.parse(input);
  if (origin && !origin.port) return origin.origin;
}
