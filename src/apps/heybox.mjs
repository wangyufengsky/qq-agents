import https from "node:https";
import net from "node:net";
import { signature } from "../../vendor/heybox/signature.mjs";
import { validateFetchUrl } from "../../vendor/social-reader/safe-fetch.js";
import { contentIdentity } from "./urls.mjs";
const paths = {
  recommend: "/bbs/app/feeds",
  board: "/bbs/app/topic/feeds",
  boards: "/bbs/app/topic/categories",
  search: "/bbs/app/api/general/search/v1",
  read: "/bbs/app/link/tree",
  comments: "/bbs/app/link/tree",
};
export async function requestHeybox(endpoint, params, cookie) {
  const url = new URL("https://api.xiaoheihe.cn" + endpoint);
  url.search = new URLSearchParams({
    os_type: "web",
    version: "999.0.3",
    x_app: "heybox_website",
    x_client_type: "web",
    x_os_type: "Windows",
    ...signature(endpoint),
    ...params,
  }).toString();
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
                /login|登录|relogin/i.test(r.status + " " + message)
                  ? "APP_LOGIN_REQUIRED"
                  : /captcha|验证码|频繁/i.test(message)
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
    : result.links || result.link_list || result.list || result.data || [];
function post(value) {
  const x = value.link || value,
    id = String(x.linkid || x.link_id || x.id || "");
  if (!/^\d+$/.test(id)) return null;
  let body = x.content || x.text || x.description || "";
  if (typeof body === "string") {
    try {
      const a = JSON.parse(body);
      if (Array.isArray(a))
        body = a
          .filter((b) => b.type === "text" || b.type === "html")
          .map((b) => b.text || b.content || "")
          .join("\n");
    } catch {}
  }
  return {
    id,
    title: x.title || "",
    author: x.user?.username || x.user?.nickname || "",
    description: typeof body === "string" ? body : "",
    url: `https://www.xiaoheihe.cn/app/bbs/link/${id}`,
    cover: x.thumb || x.cover || "",
    publishedAt: x.create_at || "",
  };
}
export async function heyboxRead(page, job, { request = requestHeybox } = {}) {
  const cookies = await page.getCookies({ url: "https://api.xiaoheihe.cn" });
  const cookie = cookies
    .filter((x) =>
      [
        "heybox_id",
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
  if (op === "search")
    Object.assign(params, {
      keyword: job.query,
      q: job.query,
      search_type: "link",
      tab_type: "link",
    });
  if (op === "read" || op === "comments")
    params.link_id = contentIdentity(job.url, "heybox").id;
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
      coverage: item.description?.trim() ? "post-text" : "post-metadata",
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
