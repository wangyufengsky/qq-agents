import { join } from "node:path";
import { isGardenArtResource } from "../../public/garden-art/art.js";

// Only packaged desktop assets are exposed to the isolated renderer.
export function desktopResourcePath(value, source) {
  let url;
  try {
    url = new URL(value);
  } catch {
    return;
  }
  if (
    url.protocol !== "nest:" ||
    url.host !== "app" ||
    url.username ||
    url.password
  )
    return;
  const path = url.pathname;
  if (
    /^\/desktop\/home\/(?:index\.html|style\.css|renderer(?:-[a-z]+)?\.js|art\/(?:[a-z0-9-]+\.webp|actions\/[a-z0-9/-]+\.webp))$/.test(
      path,
    )
  )
    return join(source, path.slice("/desktop/home/".length));
  if (
    (path.startsWith("/public/garden-art/") &&
      isGardenArtResource(path.slice("/public/garden-art/".length))) ||
    [
      "/public/home-preview/assets/door.webp",
      "/public/home-preview/assets/room-board.webp",
      "/public/home-space/paper-nest-hand-v1.530.woff2",
    ].includes(path)
  )
    return join(source, "../..", path);
}
