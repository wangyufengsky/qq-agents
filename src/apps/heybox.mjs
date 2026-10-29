import https from "node:https";
import net from "node:net";
import { signature } from "../../vendor/heybox/signature.mjs";
import { validateFetchUrl } from "../../vendor/social-reader/safe-fetch.js";
import { contentIdentity } from "./urls.mjs";
const paths = {
  recommend: "/bbs/app/feeds",
  board: "/bbs/app/topic/feeds",
  boards: "/bbs/app/topic/categories",
  read: "/bbs/app/link/tree",
  comments: "/bbs/app/link/tree",
};
export function heyboxUrl(endpoint, params) {
  const url = new URL("https://api.xiaoheihe.cn" + endpoint);
  // Same platform fields as the official web client; without them link/tree hides long post bodies.
  url.search = new URLSearchParams({
    app: "heybox",
    os_type: "web",
    version: "999.0.3",
    x_app: "heybox_website",
    x_client_type: "web",
    client_type: "web",
    web_version: "3.0",
    x_os_type: "Windows",
    ...signature(endpoint),
    ...params,
  }).toString();
  return url;
}
export async function requestHeybox(endpoint, params, cookie) {
  const url = heyboxUrl(endpoint, params);
  const { addresses } = await validateFetchUrl(url.href);
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      {
        signal: AbortSignal.timeout(20000),
        agent: false,
        headers: {
          accept: "application/json",
          "accept-encoding": "identity",
          "user-agent": "Mozilla/5.0",
          referer: "https://www.xiaoheihe.cn/",
          ...(cookie ? { cookie } : {}),
        },
        lookup: (_h, options, cb) => {
          const a = addresses.map((address) => ({
            address,
            family: net.isIP(address),
          }));
          if (options.all) cb(null, a);
          else cb(null, a[0].address, a[0].family);
        },
      },
      (res) => {
        if (res.statusCode !== 200 || res.headers.location) {
          res.destroy();
          reject(
            Error(
              [401, 403].includes(res.statusCode)
                ? "APP_LOGIN_REQUIRED"
                : "APP_UPSTREAM_FAILED",
            ),
          );
          return;
        }
        let bytes = 0;
        const chunks = [];
        res.on("data", (chunk) => {
          bytes += chunk.length;
          if (bytes > 4 * 1024 * 1024) {
            res.destroy();
            reject(Error("APP_OUTPUT_LIMIT"));
          } else chunks.push(chunk);
        });
        res.on("error", () => reject(Error("APP_UPSTREAM_FAILED")));
        res.on("end", () => {
          try {
            const r = JSON.parse(Buffer.concat(chunks).toString("utf8"));
            if (r.status !== "ok") {
              const message = String(r.msg || "");
              throw Error(
                /captcha|lack_token/i.test(r.status) ||
                  /验证码|安全验证/.test(message)
                  ? "APP_VERIFICATION_REQUIRED"
                  : /login|unauthorized|登录|relogin/i.test(
                        r.status + " " + message,
                      )
                    ? "APP_LOGIN_REQUIRED"
                    : /频繁|限流/i.test(message)
                      ? "APP_RATE_LIMITED"
                      : "APP_UPSTREAM_FAILED",
              );
            }
            resolve(r.result || {});
          } catch (e) {
            reject(
              Error(
                /^APP_[A-Z_]+$/.test(e.message)
                  ? e.message
                  : "APP_RESPONSE_INVALID",
              ),
            );
          }
        });
      },
    );
    req.on("error", () => reject(Error("APP_UPSTREAM_FAILED")));
  });
}
const rows = (result) =>
  Array.isArray(result)
    ? result
    : result.items ||
      result.links ||
      result.link_list ||
      result.list ||
      result.data ||
      [];
// &lt;/&gt; stay encoded: later tag stripping in normalizeRows would otherwise eat that text.
const entities = { amp: "&", quot: '"', apos: "'", nbsp: " " };
const decode = (s) =>
  s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] !== "#") return entities[e.toLowerCase()] ?? m;
    const n =
      e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : +e.slice(1);
    return n > 0 && n <= 0x10ffff && n !== 60 && n !== 62
      ? String.fromCodePoint(n)
      : m;
  });
const absolute = (url) => (url.startsWith("//") ? "https:" + url : url);
// Long posts store one HTML block; keep paragraph breaks and lift lazy-loaded image links.
function htmlText(html, images) {
  return decode(
    String(html)
      .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, "")
      .replace(/<img\b[^>]*>/gi, (tag) => {
        const src =
          /\sdata-original\s*=\s*["']([^"']+)/i.exec(tag) ||
          /\ssrc\s*=\s*["']([^"']+)/i.exec(tag);
        if (src) images.push(absolute(decode(src[1])));
        return "\n";
      })
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(
        /<\/?(?:p|div|h[1-6]|blockquote|li|ul|ol|pre|figure|figcaption|table|tr|hr)\b[^>]*>/gi,
        "\n",
      )
      .replace(/<[^>]*>/g, ""),
  )
    .replace(/[^\S\n]+/g, " ")
    .replace(/ ?\n ?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
// link.text is a JSON block list: a single "html" block, or text/url/img blocks like the web client renders.
function richText(raw) {
  const images = [];
  if (typeof raw !== "string") return { text: "", images };
  let blocks;
  try {
    blocks = JSON.parse(raw);
  } catch {
    return { text: raw, images };
  }
  if (!Array.isArray(blocks)) return { text: "", images };
  const text = blocks
    .map((b) => {
      if (b?.type === "html")
        return htmlText(b.text || b.content || "", images);
      if (b?.type === "img" && typeof b.url === "string")
        images.push(absolute(b.url));
      return b?.type === "text" || b?.type === "url"
        ? String(b.text || b.content || "")
        : "";
    })
    .filter((s) => s.trim())
    .join("\n");
  return { text, images };
}
function post(value) {
  const x = value.link || value.info || value.post || value,
    id = String(x.linkid || x.link_id || x.id || "");
  if (!/^\d+$/.test(id)) return null;
  const { text, images } = richText(x.content || x.text);
  const summary = !text.trim() && typeof x.description === "string";
  return {
    id,
    title: x.title || "",
    author: x.user?.username || x.user?.nickname || "",
    description: summary ? x.description : text,
    url: `https://www.xiaoheihe.cn/app/bbs/link/${id}`,
    cover: x.thumb || x.cover || images[0] || "",
    images,
    publishedAt: x.create_at || "",
    ...(summary && x.description.trim() ? { truncated: true } : {}),
  };
}
export async function heyboxRead(page, job, { request = requestHeybox } = {}) {
  if (job.operation === "search") return heyboxBrowserSearch(page, job);
  const cookies = await page.getCookies({ url: "https://api.xiaoheihe.cn" });
  const cookie = cookies
    .filter(
      (x) =>
        (!x.domain || /(^|\.)xiaoheihe\.cn$/.test(x.domain)) &&
        [
          "heybox_id",
          "user_heybox_id",
          "x_xhh_heyboxid",
          "user_pkey",
          "pkey",
          "x_xhh_tokenid",
        ].includes(x.name),
    )
    .map((x) => `${x.name}=${x.value}`)
    .join("; ");
  if (job.operation === "status")
    return {
      loggedIn: null,
      status: cookie ? "credential-present-unverified" : "login-required",
      loginUrl: "https://www.xiaoheihe.cn/",
    };
  const op = job.operation === "browse" ? job.entry : job.operation,
    endpoint = paths[op];
  if (!endpoint) throw Error("APP_ENTRY_UNSUPPORTED");
  const offset = Number(job.cursor?.offset) || 0,
    limit = Math.min(20, Math.max(1, Number(job.limit) || 5));
  const params = { offset: String(offset), limit: String(limit) };
  if (op === "recommend")
    Object.assign(params, { pull: offset ? "0" : "1", dw: "800" });
  if (op === "board") {
    if (!/^\d{1,20}$/.test(job.board || "")) throw Error("APP_BOARD_REQUIRED");
    params.topic_id = job.board;
  }
  if (op === "read" || op === "comments")
    params.link_id = contentIdentity(job.url, "heybox").id;
  if (op === "read")
    Object.assign(params, {
      is_first: "1",
      page: "1",
      index: "1",
      owner_only: "0",
    });
  const result = await request(endpoint, params, cookie);
  if (op === "boards")
    return {
      items: (result.categories || [])
        .flatMap((category) => category.children || [])
        .slice(0, 80)
        .map((x) => ({
          id: String(x.topic_id || x.id || ""),
          name: String(x.topic_name || x.name || "").slice(0, 100),
        }))
        .filter((x) => /^\d+$/.test(x.id)),
      next: null,
      coverage: "board-catalog",
    };
  if (op === "read") {
    const item = post(result.link || {});
    if (!item) throw Error("APP_BODY_UNAVAILABLE");
    return {
      items: [item],
      next: null,
      coverage: !item.description.trim()
        ? "post-metadata"
        : item.truncated
          ? "post-summary"
          : "post-text",
    };
  }
  if (op === "comments") {
    const comments = (result.comments || [])
      .flatMap((g) => g.comment || [])
      .map((c) => ({
        id: c.commentid,
        author: c.user?.username || "",
        text: c.text || c.content || "",
        url: job.url,
      }));
    return {
      items: comments,
      next: result.has_more_floors
        ? { offset: offset + (result.comments?.length || limit) }
        : null,
      coverage: "thread-comments",
    };
  }
  const list = rows(result);
  if (!Array.isArray(list)) throw Error("APP_RESPONSE_INVALID");
  return {
    items: list.map(post).filter(Boolean),
    next: list.length >= limit ? { offset: offset + list.length } : null,
    coverage:
      op === "recommend"
        ? cookie
          ? "recommendations-with-local-session"
          : "public-recommendations"
        : op === "board"
          ? "forum-posts"
          : "search-results",
  };
}

// Use the authenticated official web UI for search: its browser owns verification and cookies.
export async function heyboxBrowserSearch(page, job) {
  const target =
    "https://www.xiaoheihe.cn/app/search/list?" +
    new URLSearchParams({ q: job.query, search_type: "link" });
  const step = Math.min(50, Math.max(1, Number(job.cursor?.page) || 1));
  if (step === 1) await page.goto(target);
  const data = await page.evaluate(`async () => {
    const expected = new URL(${JSON.stringify(target)});
    if (location.origin !== expected.origin || location.pathname !== expected.pathname || new URL(location.href).searchParams.get('q') !== expected.searchParams.get('q')) return {error:'APP_CURSOR_RESTARTED'};
    const selector = 'a.hb-cpt__bbs-list-content[href*="/app/bbs/link/"]';
    const before = document.querySelectorAll(selector).length;
    if (${step} > 1) { window.scrollTo(0,document.body.scrollHeight); document.scrollingElement?.scrollTo(0,document.scrollingElement.scrollHeight); }
    const deadline = Date.now()+8000;
    while (Date.now()<deadline) {
      await new Promise(r=>setTimeout(r,500));
      const count=document.querySelectorAll(selector).length;
      if ((${step}===1 && count>0) || (${step}>1 && count>before)) break;
    }
    const nodes=Array.from(document.querySelectorAll(selector));
    if (!nodes.length) {
      const text=document.body.innerText;
      if (/验证码|安全验证/.test(text)) return {error:'APP_VERIFICATION_REQUIRED'};
      if (/登录后搜索|请先登录/.test(text)) return {error:'APP_LOGIN_REQUIRED'};
      if (!/暂无|没有找到|无相关/.test(text)) return {error:'APP_SEARCH_UNAVAILABLE'};
    }
    return {items:nodes.slice(-40).map(a=>({url:a.href,title:a.querySelector('.bbs-content__title')?.innerText||'',author:a.querySelector('.list-content__username')?.innerText||'',description:a.querySelector('.bbs-content__content')?.innerText||'',cover:a.querySelector('.bbs-content__imgs-wrapper img')?.src||''})),more:nodes.length>0 && (${step}===1 || nodes.length>before)};
  }`);
  if (data?.error) throw Error(data.error);
  if (!Array.isArray(data?.items)) throw Error("APP_RESPONSE_INVALID");
  return {
    items: data.items,
    next: data.more && step < 50 ? { page: step + 1 } : null,
    coverage: "search-results-scroll",
  };
}
