import fs from "node:fs";
import { catalog } from "../../public/home-preview/catalog.mjs";

// Only packaged shells and assets are served. No user-controlled filesystem paths.
const files = new Map([
  ["/home-preview/", ["index.html", "text/html; charset=utf-8"]],
  ...["app", "catalog", "scene", "templates", "paper-board"].map((name) => [
    `/home-preview/${name}.mjs`,
    [`${name}.mjs`, "text/javascript; charset=utf-8"],
  ]),
  ["/home-preview/style.css", ["style.css", "text/css; charset=utf-8"]],
  ...Object.values(catalog).map((asset) => [
    `/home-preview/${asset.file}`,
    [asset.file, "image/webp"],
  ]),
]);
export function serveHomePreview(req, res, pathname) {
  const live =
    pathname === "/home-space" || pathname.startsWith("/home-space/");
  const liveFiles = new Map([
    ["/home-space/", ["index.html", "text/html; charset=utf-8"]],
    ["/home-space/app.mjs", ["app.mjs", "text/javascript; charset=utf-8"]],
    ["/home-space/book.mjs", ["book.mjs", "text/javascript; charset=utf-8"]],
    [
      "/home-space/scene-decoration.mjs",
      ["scene-decoration.mjs", "text/javascript; charset=utf-8"],
    ],
    [
      "/home-space/interiors.mjs",
      ["interiors.mjs", "text/javascript; charset=utf-8"],
    ],
    [
      "/home-space/social.mjs",
      ["social.mjs", "text/javascript; charset=utf-8"],
    ],
    ["/home-space/social.css", ["social.css", "text/css; charset=utf-8"]],
    ["/home-space/letters.css", ["letters.css", "text/css; charset=utf-8"]],
    ["/home-space/style.css", ["style.css", "text/css; charset=utf-8"]],
    ["/home-space/interiors.css", ["interiors.css", "text/css; charset=utf-8"]],
    [
      "/home-space/paper-nest-hand-v1.530.woff2",
      ["paper-nest-hand-v1.530.woff2", "font/woff2"],
    ],
  ]);
  if (
    !live &&
    pathname !== "/home-preview" &&
    !pathname.startsWith("/home-preview/")
  )
    return false;
  const headers = {
    "cache-control": "no-store",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    "content-security-policy":
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  };
  if (live)
    headers["content-security-policy"] = headers[
      "content-security-policy"
    ].replace("connect-src 'none'", "connect-src 'self'");
  if (!["GET", "HEAD"].includes(req.method)) {
    res.writeHead(405, { ...headers, allow: "GET, HEAD" });
    res.end();
  } else if (pathname === "/home-preview" || pathname === "/home-space") {
    res.writeHead(302, { ...headers, location: pathname + "/" });
    res.end();
  } else {
    const entry = (live ? liveFiles : files).get(pathname);
    if (!entry) {
      res.writeHead(404, headers);
      res.end();
    } else {
      const [name, contentType] = entry;
      const data = fs.readFileSync(
        new URL(
          `../../public/${live ? "home-space" : "home-preview"}/${name}`,
          import.meta.url,
        ),
      );
      res.writeHead(200, {
        ...headers,
        ...(contentType === "font/woff2"
          ? { "cache-control": "public, max-age=31536000, immutable" }
          : {}),
        "content-type": contentType,
        "content-length": data.length,
      });
      res.end(req.method === "HEAD" ? undefined : data);
    }
  }
  return true;
}
