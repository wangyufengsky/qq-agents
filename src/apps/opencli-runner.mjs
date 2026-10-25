// Isolated child: fixed read adapters only. Never load model-provided code or commands.
import { heyboxRead } from "./heybox.mjs";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { contentIdentity, APP_LOGIN, appInfo } from "./urls.mjs";
async function main() {
  let input = "";
  for await (const part of process.stdin) {
    input += part;
    if (input.length > 16000) throw Error("APP_INPUT_LIMIT");
  }
  const job = JSON.parse(input);
  appInfo(job.platform);
  if (
    !["status", "browse", "search", "read", "comments", "boards"].includes(
      job.operation,
    )
  )
    throw Error("APP_OPERATION_INVALID");
  const limit = Math.min(20, Math.max(1, Number(job.limit) || 5));
  const pageNo = Math.min(50, Math.max(1, Number(job.cursor?.page) || 1));
  const candidates = (process.env.PATH || "")
    .split(path.delimiter)
    .map((p) => path.join(p, "opencli"));
  const bin =
    process.env.SOCIAL_OPENCLI || candidates.find((p) => fs.existsSync(p));
  if (!bin) throw Error("APP_BACKEND_MISSING");
  let root = path.dirname(fs.realpathSync(bin));
  while (path.dirname(root) !== root) {
    const f = path.join(root, "package.json");
    if (
      fs.existsSync(f) &&
      JSON.parse(fs.readFileSync(f)).name === "@jackwener/opencli"
    )
      break;
    root = path.dirname(root);
  }
  const version = JSON.parse(
    fs.readFileSync(path.join(root, "package.json")),
  ).version;
  if (version !== "1.8.4") throw Error("APP_OPENCLI_VERSION_UNTESTED");
  const imp = (p) => import(pathToFileURL(path.join(root, p)).href);
  const { executeCommand } = await imp("dist/src/execution.js");
  const { getRegistry, Strategy } = await imp("dist/src/registry-api.js");
  const unwrap = (x) =>
    x && typeof x === "object" && "session" in x && "data" in x ? x.data : x;
  const builtin = async (page, name, args = {}) => {
    await imp(`clis/${job.platform}/${name === "whoami" ? "auth" : name}.js`);
    const c = getRegistry().get(`${job.platform}/${name}`);
    if (!c || c.access === "write" || typeof c.func !== "function")
      throw Error("APP_ADAPTER_UNAVAILABLE");
    return c.func(page, args);
  };
  const evalJson = async (page, url) => {
    const u = new URL(url);
    if (
      u.protocol !== "https:" ||
      !["www.zhihu.com", "zhuanlan.zhihu.com"].includes(u.hostname) ||
      !/^\/api\/v[34]\//.test(u.pathname)
    )
      throw Error("APP_CURSOR_DENIED");
    const data = unwrap(
      await page.evaluate(
        `async () =>{const r=await fetch(${JSON.stringify(u.href)},{credentials:'include',redirect:'error'});if(!r.ok)return {__httpError:r.status};return await r.json()}`,
      ),
    );
    if (!data || typeof data !== "object") throw Error("APP_RESPONSE_INVALID");
    if (data?.__httpError || data?.error)
      throw Error(
        [401, 403].includes(data?.__httpError)
          ? "APP_LOGIN_REQUIRED"
          : "APP_UPSTREAM_FAILED",
      );
    return data;
  };
  const listing = (rows, next = null, coverage = "listing") => ({
    items: rows,
    next,
    coverage,
  });
  const stream = String(job.streamId || "default");
  if (!/^[a-zA-Z0-9-]{1,64}$/.test(stream)) throw Error("APP_STREAM_INVALID");
  const cmd = {
    site: `qqapps-${job.platform}-${stream}`,
    name: job.operation,
    domain: new URL(APP_LOGIN[job.platform]).hostname,
    access: "read",
    browser: true,
    strategy: Strategy.COOKIE,
    navigateBefore: false,
    args: [],
    func: async (page) => {
      if (job.platform === "heybox") return heyboxRead(page, job);
      if (job.operation === "status") {
        if (job.platform === "tieba")
          return {
            loggedIn: null,
            status: "public-read",
            loginUrl: APP_LOGIN.tieba,
          };
        const rows = await builtin(page, "whoami");
        return {
          loggedIn: !!(Array.isArray(rows)
            ? rows[0]?.logged_in
            : rows?.logged_in),
          status: "checked",
        };
      }
      if (job.platform === "bilibili") {
        if (job.operation === "browse" && job.entry === "following") {
          await page.goto(APP_LOGIN.bilibili);
          const { apiGet } = await imp("clis/bilibili/utils.js");
          const r = await apiGet(page, "/x/polymer/web-dynamic/v1/feed/all", {
            params: {
              timezone_offset: -480,
              type: "all",
              page: pageNo,
              ...(job.cursor?.offset ? { offset: job.cursor.offset } : {}),
            },
          });
          if (r?.code !== 0)
            throw Error(
              r?.code === -101 ? "APP_LOGIN_REQUIRED" : "APP_UPSTREAM_FAILED",
            );
          const data = r.data || {};
          const rows = (data.items || []).map((x) => {
            const d = x.modules?.module_dynamic || {},
              a = d.major?.archive,
              u = x.modules?.module_author || {};
            return {
              id: x.id_str,
              title:
                a?.title || d.major?.opus?.title || d.desc?.text || "[动态]",
              url: a?.bvid
                ? `https://www.bilibili.com/video/${a.bvid}`
                : `https://t.bilibili.com/${x.id_str}`,
              author: u.name,
              description: d.desc?.text || "",
              publishedAt: u.pub_time,
              cover: a?.cover,
            };
          });
          return listing(
            rows,
            data.has_more && data.offset
              ? { page: pageNo + 1, offset: String(data.offset) }
              : null,
            "following-timeline",
          );
        }
        if (job.operation === "browse" && job.entry === "hot") {
          await page.goto(APP_LOGIN.bilibili);
          const { apiGet } = await imp("clis/bilibili/utils.js");
          const r = await apiGet(page, "/x/web-interface/popular", {
            params: { pn: pageNo, ps: limit },
          });
          if (r?.code !== 0) throw Error("APP_UPSTREAM_FAILED");
          return listing(
            (r.data?.list || []).map((x) => ({
              id: x.bvid,
              title: x.title,
              description: x.desc,
              author: x.owner?.name,
              url: `https://www.bilibili.com/video/${x.bvid}`,
              cover: x.pic,
            })),
            r.data?.no_more ? null : { page: pageNo + 1 },
            "popular-list",
          );
        }
        if (job.operation === "browse" && job.entry === "ranking")
          return listing(
            await builtin(page, "ranking", { limit }),
            null,
            "ranking",
          );
        if (job.operation === "search")
          return listing(
            await builtin(page, "search", {
              query: job.query,
              type: "video",
              page: pageNo,
              limit: 50,
            }),
            { page: pageNo + 1 },
            "search-results",
          );
        await page.goto(APP_LOGIN.bilibili);
        const identity = contentIdentity(job.url, "bilibili");
        if (identity.kind === "video-metadata")
          return listing(
            await builtin(
              page,
              job.operation === "comments" ? "comments" : "video",
              { bvid: identity.id, limit },
            ),
            null,
            job.operation === "comments"
              ? "sampled-comments"
              : "video-metadata",
          );
        if (job.operation === "read")
          return listing(
            await builtin(page, "feed-detail", { id: identity.id }),
            null,
            "dynamic-text",
          );
        throw Error("APP_ENTRY_UNSUPPORTED");
      }
      if (job.platform === "zhihu") {
        if (job.operation === "browse" && job.entry === "hot")
          return listing(
            await builtin(page, "hot", { limit }),
            null,
            "hot-list",
          );
        if (job.operation === "browse" && job.entry === "recommend") {
          await page.goto(APP_LOGIN.zhihu);
          const next =
            job.cursor?.next ||
            `https://www.zhihu.com/api/v3/feed/topstory/recommend?limit=${Math.max(10, limit)}&desktop=true`;
          if (
            !new URL(next).pathname.startsWith(
              "/api/v3/feed/topstory/recommend",
            )
          )
            throw Error("APP_CURSOR_DENIED");
          const data = await evalJson(page, next);
          const rows = (data.data || []).map((x) => {
            const t = x.target || {},
              id = String(t.id || "");
            return {
              title: t.question?.title || t.title,
              author: t.author?.name,
              type: t.type,
              description: t.excerpt,
              url:
                t.type === "answer"
                  ? `https://www.zhihu.com/question/${t.question?.id}/answer/${id}`
                  : t.type === "article"
                    ? `https://zhuanlan.zhihu.com/p/${id}`
                    : t.type === "question"
                      ? `https://www.zhihu.com/question/${id}`
                      : "",
            };
          });
          return listing(
            rows,
            !data.paging?.is_end && data.paging?.next
              ? { next: data.paging.next }
              : null,
            "personalized-recommendations",
          );
        }
        if (job.operation === "search") {
          await page.goto(APP_LOGIN.zhihu);
          const offset = Number(job.cursor?.offset) || 0;
          const data = await evalJson(
            page,
            "https://www.zhihu.com/api/v4/search_v3?" +
              new URLSearchParams({
                q: job.query,
                t: "general",
                correction: "1",
                offset: String(offset),
                limit: String(limit),
              }),
          );
          const rows = (data.data || []).map((x) => {
            const o = x.object || x,
              target = o.question || o;
            return {
              title: target.title,
              author: o.author?.name,
              description: o.excerpt,
              url:
                o.url
                  ?.replace("api.zhihu.com", "www.zhihu.com")
                  .replace("/answers/", `/question/${o.question?.id}/answer/`)
                  .replace("/questions/", "/question/") || "",
            };
          });
          return listing(
            rows,
            data.paging?.is_end
              ? null
              : { offset: offset + (data.data?.length || limit) },
            "search-results",
          );
        }
        const ident = contentIdentity(job.url, "zhihu");
        if (ident.kind === "answer")
          return listing(
            await builtin(
              page,
              job.operation === "comments"
                ? "answer-comments"
                : "answer-detail",
              {
                id: ident.id.split("/").at(-1),
                limit,
                "max-content": 12000,
                "replies-limit": 2,
              },
            ),
            null,
            job.operation === "comments" ? "sampled-comments" : "answer-text",
          );
        if (ident.kind === "question" && job.operation === "read")
          return listing(
            await builtin(page, "question", {
              id: ident.id.split("/").at(-1),
              limit,
            }),
            null,
            "answer-samples",
          );
        if (ident.kind === "article" && job.operation === "read") {
          await page.goto(ident.url);
          const r = unwrap(
            await page.evaluate(
              `()=>({title:document.querySelector('h1')?.textContent||'',content:document.querySelector('.Post-RichText')?.textContent||'',url:location.href})`,
            ),
          );
          if (!r.content) throw Error("APP_BODY_UNAVAILABLE");
          return listing([r], null, "article-text");
        }
        throw Error("APP_ENTRY_UNSUPPORTED");
      }
      if (job.platform === "xiaohongshu") {
        if (job.operation === "browse" && job.entry === "recommend") {
          const { runFeed } = await imp("clis/xiaohongshu/feed.js");
          if (!job.cursor)
            return listing(
              await runFeed(page, { limit }, "www.xiaohongshu.com"),
              { page: 2 },
              "personalized-recommendations",
            );
          const rows = unwrap(
            await page.evaluate(
              `async () =>{const wait=ms=>new Promise(r=>setTimeout(r,ms));const s=document.querySelector('.feeds-container')?.parentElement||document.scrollingElement;window.scrollTo(0,document.body.scrollHeight);s?.scrollTo(0,s.scrollHeight);await wait(1800);const items=[];for(const a of document.querySelectorAll('a[href*="/explore/"]')){const u=new URL(a.href,location.href);if(!u.searchParams.get('xsec_token'))continue;const card=a.closest('section')||a.parentElement;items.push({url:u.href,title:card?.querySelector('.title')?.textContent||a.textContent,author:card?.querySelector('.author')?.textContent||'',cover:card?.querySelector('img')?.src||''});}return items.slice(-40)}`,
            ),
          );
          return listing(
            rows,
            rows?.length && pageNo < 50 ? { page: pageNo + 1 } : null,
            "personalized-recommendations-scroll",
          );
        }
        if (job.operation === "search")
          return listing(
            await builtin(page, "search", { query: job.query, limit }),
            null,
            "search-first-page",
          );
        const id = contentIdentity(job.url, "xiaohongshu"),
          rows = await builtin(
            page,
            job.operation === "comments" ? "comments" : "note",
            { "note-id": id.url, limit, "with-replies": true },
          );
        return listing(
          rows,
          null,
          job.operation === "comments"
            ? "sampled-comments"
            : rows.some((x) => x.field === "content" && x.value)
              ? "note-text"
              : "note-metadata",
        );
      }
      if (job.platform === "tieba") {
        if (job.operation === "browse" && job.entry === "hot")
          return listing(
            await builtin(page, "hot", { limit }),
            null,
            "hot-topics",
          );
        if (job.operation === "browse" && job.entry === "board")
          return listing(
            await builtin(page, "posts", {
              forum: job.board,
              page: pageNo,
              limit: 30,
            }),
            { page: pageNo + 1 },
            "forum-posts",
          );
        if (job.operation === "search")
          return listing(
            await builtin(page, "search", {
              keyword: job.query,
              page: 1,
              limit,
            }),
            null,
            "search-first-page",
          );
        const id = contentIdentity(job.url, "tieba");
        if (id.kind === "topic-list") {
          if (job.operation !== "read") throw Error("APP_ENTRY_UNSUPPORTED");
          await page.goto(id.url);
          const rows = unwrap(
            await page.evaluate(
              `()=>Array.from(document.querySelectorAll('a[href]')).filter(a=>a.href.startsWith('https://tieba.baidu.com/p/')).map(a=>({url:a.href,title:a.textContent||''})).slice(0,100)`,
            ),
          );
          return listing(rows, null, "topic-post-links");
        }
        return listing(
          await builtin(page, "read", { id: id.id, page: pageNo, limit: 100 }),
          { page: pageNo + 1 },
          job.operation === "comments" ? "thread-replies" : "thread-text",
        );
      }
      throw Error("APP_ENTRY_UNSUPPORTED");
    },
  };
  try {
    const result = await executeCommand(cmd, {}, false, {
      prepared: true,
      trace: "off",
      siteSession:
        job.platform === "xiaohongshu" && job.operation === "browse"
          ? "persistent"
          : "ephemeral",
      keepTab: "false",
      windowMode: "background",
    });
    process.stdout.write(JSON.stringify({ ok: true, result }));
  } catch (error) {
    if (process.env.APPS_ACCEPTANCE_DEBUG === "1")
      console.error(
        JSON.stringify({
          name: error.name,
          code: error.code,
          message: String(error.message)
            .replace(/https?:\/\/[^\s]+/g, "[url]")
            .slice(0, 240),
        }),
      );
    const msg = String(error.message || "");
    const code = /^APP_[A-Z_]+$/.test(msg)
      ? msg
      : /login|AUTH_REQUIRED|登录/i.test(msg)
        ? "APP_LOGIN_REQUIRED"
        : /captcha|429|验证码/i.test(msg)
          ? "APP_RATE_LIMITED"
          : /timeout|TIMEOUT/i.test(msg)
            ? "APP_TIMEOUT"
            : "APP_BACKEND_FAILED";
    process.stdout.write(JSON.stringify({ ok: false, error: code }));
    process.exitCode = 1;
  }
}
await main().catch((error) => {
  const code = /^APP_[A-Z_]+$/.test(error.message)
    ? error.message
    : "APP_BACKEND_FAILED";
  process.stdout.write(JSON.stringify({ ok: false, error: code }));
  process.exitCode = 1;
});
