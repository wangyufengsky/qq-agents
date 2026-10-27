import { SaxesParser } from "saxes";
import { platformOf, publicUrl, contentIdentity } from "./urls.mjs";
const MAX = 65536;
const text = (value, max = 1000) =>
  typeof value === "string"
    ? // eslint-disable-next-line no-control-regex -- deliberately strips control characters
      value.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "").slice(0, max)
    : "";
function depthCheck(root) {
  let nodes = 0;
  const walk = (value, depth) => {
    if (++nodes > 2000 || depth > 12) throw Error("CARD_STRUCTURE_LIMIT");
    if (value && typeof value === "object")
      for (const [k, v] of Object.entries(value)) {
        if (["__proto__", "constructor", "prototype"].includes(k))
          throw Error("CARD_UNSAFE_KEY");
        walk(v, depth + 1);
      }
  };
  walk(root, 0);
}
function urlValue(value) {
  const raw = text(value, 4096);
  if (!raw) return "";
  try {
    return publicUrl(raw.startsWith("//") ? "https:" + raw : raw).href;
  } catch {
    return "";
  }
}
function shape(value, format) {
  const target = urlValue(
    value.url ||
      value.qqdocurl ||
      value.jumpUrl ||
      value.jump_url ||
      value.link ||
      value.target,
  );
  let platform = null;
  try {
    platform = target ? platformOf(target) : null;
  } catch {
    // Unknown or unsupported URL: leave the platform unset.
  }
  let identity;
  try {
    if (target) identity = contentIdentity(target);
  } catch {
    // No stable content identity for this URL: leave it unset.
  }
  const appPath = text(
    value.pagepath || value.path || value.appid || value.appId,
    200,
  );
  return {
    format,
    platform,
    ...(identity
      ? { key: identity.key, id: identity.id, kind: identity.kind }
      : {}),
    title: text(value.title || value.desc || value.prompt, 500),
    summary: text(value.desc || value.summary || value.content, 2000),
    image: urlValue(
      value.preview || value.cover || value.image || value.picurl,
    ),
    url: target || null,
    availability: target
      ? "card-summary-only"
      : appPath
        ? "app-only"
        : "missing-target",
    untrustedContent: true,
    readingScope: "card-summary",
  };
}
export function parseCards(segments) {
  if (!Array.isArray(segments)) return [];
  const out = [];
  for (const segment of segments.slice(0, 50)) {
    if (segment?.type === "text") {
      for (const match of String(segment.data?.text || "")
        .slice(0, 65536)
        .matchAll(/https?:\/\/[^\s<>"'，。！）)]+/g)) {
        const card = shape({ url: match[0] }, "text-link");
        if (
          card.url &&
          (card.platform ||
            ["url.cn", "b23.tv", "xhslink.com", "www.xhslink.com"].includes(
              new URL(card.url).hostname,
            ))
        )
          out.push(card);
        if (out.length >= 10) break;
      }
      continue;
    }
    if (!["json", "xml", "miniapp"].includes(segment?.type)) continue;
    try {
      let raw = segment.data?.data ?? segment.data?.xml ?? segment.data;
      if (typeof raw === "object" && raw) {
        raw = JSON.stringify(raw);
      }
      if (typeof raw !== "string" || Buffer.byteLength(raw) > MAX)
        throw Error("CARD_SIZE_LIMIT");
      if (segment.type === "xml") {
        const attrs = Object.create(null),
          bodies = Object.create(null),
          stack = [];
        let nodes = 0;
        const parser = new SaxesParser({ xmlns: false });
        parser.on("doctype", () => {
          throw Error("CARD_XML_DTD_DENIED");
        });
        parser.on("error", () => {
          throw Error("CARD_XML_INVALID");
        });
        parser.on("opentag", (node) => {
          if (++nodes > 150 || stack.length >= 12)
            throw Error("CARD_STRUCTURE_LIMIT");
          stack.push(node.name);
          if (["msg", "item", "picture", "source"].includes(node.name))
            for (const k of ["url", "title", "brief", "summary", "cover"])
              if (!attrs[k]) attrs[k] = node.attributes[k];
        });
        const body = (value) => {
          const name = stack.at(-1);
          if (["title", "summary"].includes(name))
            bodies[name] = text((bodies[name] || "") + value, 8000);
        };
        parser.on("text", body);
        parser.on("cdata", body);
        parser.on("closetag", () => stack.pop());
        parser.write(raw).close();
        out.push(
          shape(
            {
              url: attrs.url,
              title: bodies.title || attrs.title || attrs.brief,
              summary: bodies.summary || attrs.summary,
              preview: attrs.cover,
            },
            "xml",
          ),
        );
      } else {
        const value = JSON.parse(raw);
        depthCheck(value);
        const meta = value.meta;
        if (!value || typeof value !== "object" || Array.isArray(value))
          throw Error("CARD_JSON_INVALID");
        let found = false;
        for (const key of ["news", "detail_1", "detail", "music", "video"])
          if (meta?.[key] && typeof meta[key] === "object") {
            out.push(
              shape(
                { ...meta[key], prompt: value.prompt },
                meta[key].appid ? "miniapp" : "json",
              ),
            );
            found = true;
          }
        if (!found && (segment.type === "miniapp" || value.appid || value.url))
          out.push(
            shape(value, segment.type === "miniapp" ? "miniapp" : "json"),
          );
        if (!found && !(segment.type === "miniapp" || value.appid || value.url))
          out.push({
            format: "json",
            availability: "unsupported-shape",
            readingScope: "card-summary",
            untrustedContent: true,
          });
      }
    } catch (error) {
      out.push({
        format: segment.type,
        availability: "invalid-card",
        error: /^CARD_[A-Z_]+$/.test(error.message)
          ? error.message
          : "CARD_PARSE_FAILED",
        untrustedContent: true,
      });
    }
    if (out.length >= 10) break;
  }
  return out.slice(0, 10);
}
