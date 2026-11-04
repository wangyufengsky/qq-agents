import fs from "node:fs";
import { catalog } from "../../public/home-preview/catalog.mjs";

// Only packaged public sample files are served. No user-controlled filesystem paths.
const files = new Map([
  ["/home-preview/", ["index.html", "text/html; charset=utf-8"]],
  ...["app", "catalog", "scene", "templates"].map((name) => [
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
  if (pathname !== "/home-preview" && !pathname.startsWith("/home-preview/"))
    return false;
  const headers = {
    "cache-control": "no-store",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    "content-security-policy":
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  };
  if (!["GET", "HEAD"].includes(req.method)) {
    res.writeHead(405, { ...headers, allow: "GET, HEAD" });
    res.end();
  } else if (pathname === "/home-preview") {
    res.writeHead(302, { ...headers, location: "/home-preview/" });
    res.end();
  } else {
    const entry = files.get(pathname);
    if (!entry) {
      res.writeHead(404, headers);
      res.end();
    } else {
      const [name, contentType] = entry;
      const data = fs.readFileSync(
        new URL(`../../public/home-preview/${name}`, import.meta.url),
      );
      res.writeHead(200, {
        ...headers,
        "content-type": contentType,
        "content-length": data.length,
      });
      res.end(req.method === "HEAD" ? undefined : data);
    }
  }
  return true;
}
