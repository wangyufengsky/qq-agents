import { validateFetchUrl } from "../../vendor/social-reader/safe-fetch.js";
import http from "node:http";
import https from "node:https";
import net from "node:net";

export const APP_NAMES = [
  "bilibili",
  "heybox",
  "zhihu",
  "xiaohongshu",
  "tieba",
];
const names = {
  bilibili: "B站",
  heybox: "小黑盒",
  zhihu: "知乎",
  xiaohongshu: "小红书",
  tieba: "贴吧",
};
export const APP_LOGIN = {
  bilibili: "https://www.bilibili.com/",
  heybox: "https://www.xiaoheihe.cn/",
  zhihu: "https://www.zhihu.com/",
  xiaohongshu: "https://www.xiaohongshu.com/explore",
  tieba: "https://tieba.baidu.com/",
};
const domains = {
  bilibili: ["bilibili.com", "b23.tv"],
  heybox: ["xiaoheihe.cn", "heybox.com"],
  zhihu: ["zhihu.com"],
  xiaohongshu: ["xiaohongshu.com", "xhslink.com"],
  tieba: ["tieba.baidu.com", "tieba.com"],
};
const shortHosts = new Set([
  "b23.tv",
  "xhslink.com",
  "www.xhslink.com",
  "url.cn",
]);
export function appInfo(platform) {
  if (!APP_NAMES.includes(platform)) throw Error("APP_PLATFORM_INVALID");
  return { platform, name: names[platform], loginUrl: APP_LOGIN[platform] };
}
export function publicUrl(value) {
  if (
    typeof value !== "string" ||
    value.length > 4096 ||
    /[\x00-\x20\x7f\\]/.test(value)
  )
    throw Error("APP_URL_DENIED");
  let url;
  try {
    url = new URL(value);
  } catch {
    throw Error("APP_URL_DENIED");
  }
  if (
    !["https:", "http:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.port
  )
    throw Error("APP_URL_DENIED");
  if (
    [...url.searchParams.keys()].some((k) =>
      /^(?:access_token|auth_token|authorization|cookie|cookies|password|passwd|secret|api_key|apikey|user_pkey|x_xhh_tokenid|session|sessionid|ticket|code)$/i.test(
        k,
      ),
    )
  )
    throw Error("APP_URL_CREDENTIALS");
  return url;
}
export function platformOf(value) {
  const url = publicUrl(value);
  return (
    APP_NAMES.find((p) =>
      domains[p].some(
        (d) => url.hostname === d || url.hostname.endsWith("." + d),
      ),
    ) || null
  );
}
export function contentIdentity(value, expected) {
  const url = publicUrl(value),
    platform = platformOf(url.href);
  if (!platform || (expected && platform !== expected))
    throw Error("APP_CONTENT_URL_INVALID");
  let id,
    kind = "post",
    canonical;
  if (platform === "bilibili") {
    let m = url.pathname.match(/^\/video\/(BV[A-Za-z0-9]{10})\/?$/);
    if (m) {
      id = m[1];
      kind = "video-metadata";
      canonical = `https://www.bilibili.com/video/${id}`;
    } else if (
      (m = url.pathname.match(/^\/(?:opus\/)?(\d+)\/?$/)) &&
      ["t.bilibili.com", "www.bilibili.com"].includes(url.hostname)
    ) {
      id = m[1];
      canonical = `https://t.bilibili.com/${id}`;
    }
  } else if (platform === "zhihu") {
    const m = url.pathname.match(
      /^\/(question\/\d+(?:\/answer\/\d+)?|p\/\d+)\/?$/,
    );
    if (m) {
      id = m[1];
      kind = id.includes("/answer/")
        ? "answer"
        : id.startsWith("p/")
          ? "article"
          : "question";
      canonical = `https://${kind === "article" ? "zhuanlan" : "www"}.zhihu.com/${id}`;
    }
  } else if (platform === "xiaohongshu") {
    const m = url.pathname.match(
      /^\/(?:explore|discovery\/item|search_result)\/([a-f0-9]{24})\/?$/i,
    );
    if (m) {
      id = m[1].toLowerCase();
      canonical = `https://www.xiaohongshu.com/explore/${id}`;
      const token = url.searchParams.get("xsec_token");
      if (token) {
        if (token.length > 512 || !/^[A-Za-z0-9_=+/-]+$/.test(token))
          throw Error("APP_URL_DENIED");
        canonical += "?" + new URLSearchParams({ xsec_token: token });
      }
    }
  } else if (platform === "tieba") {
    const m = url.pathname.match(/^\/p\/(\d+)\/?$/);
    if (m) {
      id = m[1];
      canonical = `https://tieba.baidu.com/p/${id}`;
    } else if (
      url.pathname === "/hottopic/browse/hottopic" &&
      /^\d+$/.test(url.searchParams.get("topic_id") || "")
    ) {
      id = "topic:" + url.searchParams.get("topic_id");
      kind = "topic-list";
      canonical =
        "https://tieba.baidu.com/hottopic/browse/hottopic?" +
        new URLSearchParams({ topic_id: id.slice(6) });
    }
  } else if (platform === "heybox") {
    const m = url.pathname.match(
      /^\/(?:app\/bbs\/link|bbs\/app\/link|link)\/(\d+)\/?$/,
    );
    const q = url.searchParams.get("link_id") || url.searchParams.get("linkid");
    if (
      m ||
      (/^(?:\/app\/bbs\/link\/web\/view|\/bbs\/app\/link\/web\/view|\/bbs\/link\/view)$/.test(
        url.pathname,
      ) &&
        /^\d+$/.test(q || ""))
    ) {
      id = m?.[1] || q;
      canonical = `https://www.xiaoheihe.cn/app/bbs/link/${id}`;
    }
  }
  if (!id) throw Error("APP_CONTENT_URL_INVALID");
  return { platform, id, key: `${platform}:${id}`, kind, url: canonical };
}
// Validate redirects without consuming a video/file body or forwarding login headers.
export function requestAppUrl(url, addresses, { signal }) {
  return new Promise((resolve, reject) => {
    const req = (url.protocol === "https:" ? https : http).get(
      url,
      {
        signal,
        agent: false,
        headers: { "user-agent": "Mozilla/5.0", accept: "text/html" },
        lookup: (_host, options, cb) => {
          const rows = addresses.map((address) => ({
            address,
            family: net.isIP(address),
          }));
          if (options.all) cb(null, rows);
          else cb(null, rows[0].address, rows[0].family);
        },
      },
      (res) => {
        const status = res.statusCode;
        res.destroy();
        if ([301, 302, 303, 307, 308].includes(status) && res.headers.location)
          resolve({ redirect: res.headers.location });
        else if (status === 200) resolve({ status });
        else reject(Error("APP_LINK_UNAVAILABLE"));
      },
    );
    req.on("error", () =>
      reject(Error(signal.aborted ? "APP_CANCELLED" : "APP_LINK_UNAVAILABLE")),
    );
  });
}
export async function resolveAppUrl(
  value,
  {
    signal,
    validate = validateFetchUrl,
    request = requestAppUrl,
    authorize = () => {},
  } = {},
) {
  let raw = value;
  const visited = new Set();
  const combined = signal
    ? AbortSignal.any([signal, AbortSignal.timeout(25000)])
    : AbortSignal.timeout(25000);
  for (let hop = 0; hop < 6; hop++) {
    combined.throwIfAborted();
    const parsed = publicUrl(raw);
    await authorize(parsed.href);
    if (!platformOf(parsed.href) && !shortHosts.has(parsed.hostname))
      throw Error("APP_URL_PLATFORM_DENIED");
    if (!shortHosts.has(parsed.hostname)) contentIdentity(parsed.href);
    if (visited.has(parsed.href)) throw Error("APP_REDIRECT_LOOP");
    visited.add(parsed.href);
    let checked;
    try {
      checked = await validate(parsed.href);
    } catch {
      throw Error("APP_URL_DENIED");
    }
    // Canonical content URLs are read by a fixed authenticated platform adapter.
    // Only short links need a separate credential-free redirect request.
    if (!shortHosts.has(parsed.hostname))
      return {
        ...contentIdentity(checked.url.href),
        validatedAt: new Date().toISOString(),
        redirects: hop,
      };
    const response = await request(checked.url, checked.addresses, {
      maxBytes: 512 * 1024,
      signal: combined,
    });
    if (response.redirect) {
      raw = new URL(response.redirect, checked.url).href;
      continue;
    }
    const identity = contentIdentity(checked.url.href);
    return {
      ...identity,
      validatedAt: new Date().toISOString(),
      redirects: hop,
    };
  }
  throw Error("APP_REDIRECT_LIMIT");
}
