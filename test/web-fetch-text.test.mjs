import test from "node:test";
import assert from "node:assert/strict";
import { fixture, config, context, disclosureApproval } from "./helpers.mjs";
import {
  WEB_FETCH_DOWNLOAD_CHARS,
  htmlToText,
  looksLikeHtml,
  webPage,
} from "../src/tools/web-text.mjs";

const filler = "Synthetic article sentence for paging. ".repeat(12);
const article = `<!doctype html>
<html><head><title>Fixture &amp; Page</title>
<meta charset="utf-8"><style>body{color:red}</style>
<script>var nav = "<nav>script text</nav>";</script></head>
<body>
<header><nav><a href="/">Site home</a><a href="/x">Menu item</a></nav></header>
<aside>Sidebar promo</aside>
<form><input name="q"><button>Search button</button></form>
<main>
  <header><h1>Main heading</h1></header>
  <p>First&nbsp;paragraph &lt;kept&gt; &#x1F600; &#20013;&#25991; &unknown;</p>
  <ul><li>alpha<li>beta</ul>
  <div class="hidden md:block">responsive text</div>
  <span aria-hidden="true">[edit]</span>
  <pre>  indented
    code</pre>
  <table><tr><th>k</th><td>v</td></tr></table>
  <p>${filler}</p>
  <svg><title>icon title</title><text>svg text</text></svg>
  <noscript>enable scripts</noscript>
</main>
<footer>Copyright footer</footer>
</body></html>`;

test("HTML pages return the main region as readable text without page chrome", () => {
  const { title, text } = htmlToText(article);
  assert.equal(title, "Fixture & Page");
  assert.match(
    text,
    /^Main heading\n\nFirst paragraph <kept> 😀 中文 &unknown;/,
  );
  assert.match(text, /• alpha\n• beta/);
  assert.match(text, /responsive text/);
  assert.match(text, /\n {2}indented\n {4}code\n/);
  assert.match(text, /k v/);
  for (const chrome of [
    "Site home",
    "Menu item",
    "Sidebar promo",
    "Search button",
    "Copyright footer",
    "script text",
    "color:red",
    "[edit]",
    "icon title",
    "svg text",
    "enable scripts",
  ])
    assert.doesNotMatch(text, new RegExp(chrome.replace(/[[\]]/g, "\\$&")));
  assert.doesNotMatch(text, /\n{3}/);
});

test("article is preferred inside main, and pages without regions keep body text", () => {
  const story = `<main><nav>crumbs</nav><article><h2>Story</h2><p>${filler}</p></article><section>related links list</section></main>`;
  const picked = htmlToText(story).text;
  assert.match(picked, /^Story\n\n/);
  assert.doesNotMatch(picked, /related links|crumbs/);
  const plain = htmlToText(
    "<body><header>banner</header><div>Short body text</div><footer>f</footer></body>",
  ).text;
  assert.equal(plain, "Short body text");
  // A page wrapped in one <form> still yields its content.
  const wrapped = htmlToText(`<body><form><div>${filler}</div></form></body>`);
  assert.match(wrapped.text, /Synthetic article sentence/);
});

test("class and id words drop widgets but keep content wrappers", () => {
  const { text } = htmlToText(`<main>
    <div class="vector-dropdown mw-portlet-lang"><ul><li>Deutsch</li></ul></div>
    <h2>Rules<span class="mw-editsection">[edit]</span></h2>
    <div class="has-sidebar main-content"><p>${filler}</p></div>
    <table class="navbox"><tr><td>Board games navbox</td></tr></table>
    <div id="catlinks" class="catlinks">Categories: Fixture</div>
    <div class="share-buttons">Share this</div>
  </main>`);
  assert.match(text, /^Rules\n\nSynthetic article sentence/);
  assert.doesNotMatch(text, /Deutsch|\[edit\]|navbox|Categories|Share this/);
});

test("hostile markup stays linear and unterminated tags do not leak", () => {
  const started = Date.now();
  htmlToText("<p x='".repeat(50000) + "<div>".repeat(50000));
  htmlToText("<div>".repeat(50000) + "</span>".repeat(100000));
  htmlToText("<p>abc def </p>".repeat(60000));
  assert.ok(Date.now() - started < 5000);
  assert.equal(htmlToText("<p>kept</p><a href='x").text, "kept");
  assert.equal(htmlToText('<a title="1 > 0">link</a>').text, "link");
});

test("content type decides extraction; non-HTML text is returned verbatim", () => {
  assert.equal(looksLikeHtml("text/html; charset=utf-8", ""), true);
  assert.equal(looksLikeHtml("application/json", "<html>"), false);
  assert.equal(looksLikeHtml("", "\uFEFF<!DOCTYPE html><p>x"), true);
  assert.equal(looksLikeHtml("", "plain <b>text</b>"), false);
  const json = '{\n  "a": "<b>x</b>"\n}';
  const page = webPage(
    {
      url: "https://example.com/a.json",
      body: json,
      contentType: "application/json",
    },
    {},
  );
  assert.equal(page.format, "text");
  assert.equal(page.text, json);
  assert.equal(page.totalChars, json.length);
  assert.equal(page.nextOffset, null);
  const raw = webPage(
    { body: article, contentType: "text/html" },
    { mode: "raw", maxChars: 16000 },
  );
  assert.equal(raw.format, "raw");
  assert.equal(raw.text, article);
  const empty = webPage(
    {
      body: "<html><body><div id=app></div><script>render()</script></body></html>",
    },
    {},
  );
  assert.equal(empty.text, "");
  assert.match(empty.notice, /mode raw/);
});

test("offset pages through the same extracted text until nextOffset is null", () => {
  const page = { body: article, contentType: "text/html", statusCode: 200 };
  const full = htmlToText(article).text;
  let offset = 0;
  let joined = "";
  let pages = 0;
  for (;;) {
    const r = webPage(page, { offset, maxChars: 100 });
    assert.equal(r.offset, offset);
    assert.equal(r.totalChars, full.length);
    assert.equal(r.format, "html-text");
    assert.equal(r.title, "Fixture & Page");
    joined += r.text;
    pages++;
    if (r.nextOffset === null) break;
    assert.equal(r.nextOffset, offset + r.text.length);
    offset = r.nextOffset;
  }
  assert.equal(joined, full);
  assert.ok(pages > 3);
  const past = webPage(page, { offset: full.length + 50 });
  assert.equal(past.text, "");
  assert.equal(past.nextOffset, null);
  assert.equal(past.offset, full.length);
  assert.equal(webPage(page, { offset: -5, maxChars: 10 }).offset, 0);
});

test("page windows never split a grapheme cluster", () => {
  const body = "ab👍🏽cd";
  const first = webPage({ body, contentType: "text/plain" }, { maxChars: 3 });
  assert.equal(first.text, "ab");
  assert.equal(first.nextOffset, 2);
  const second = webPage(
    { body, contentType: "text/plain" },
    { offset: 3, maxChars: 4 },
  );
  assert.equal(second.offset, 2);
  assert.equal(second.text, "👍🏽");
});

test("a truncated download reports unknown total length instead of a finished read", () => {
  const r = webPage(
    { body: "partial body", contentType: "text/plain", truncated: true },
    {},
  );
  assert.equal(r.text, "partial body");
  assert.equal(r.nextOffset, null);
  assert.equal(r.totalChars, null);
  assert.equal(r.downloadTruncated, true);
  assert.equal(r.availableChars, 12);
  assert.match(r.notice, /不算读完全文/);
});

function setup(t) {
  const cfg = config(1);
  cfg.agents[0].tools.push("web_fetch");
  const f = fixture(t, { cfg });
  const calls = [];
  f.runtime.fetchPublicPage = async (url, limit, { authorize }) => {
    await authorize(url);
    calls.push({ url, limit });
    return { url, statusCode: 200, contentType: "text/html", body: article };
  };
  return { ...f, calls };
}

test("web_fetch downloads with its own limit and pages the extracted text", async (t) => {
  const f = setup(t);
  const url = "https://example.com/article";
  f.runtime.agent("agent-0").network.publicUrls = [url];
  const ctx = context(f.runtime);
  const first = await f.runtime.callTool(ctx, "web_fetch", {
    url,
    maxChars: 100,
  });
  assert.equal(f.calls[0].limit, WEB_FETCH_DOWNLOAD_CHARS);
  assert.equal(first.result.offset, 0);
  assert.equal(first.result.nextOffset, 100);
  assert.match(first.result.text, /^Main heading/);
  const next = await f.runtime.callTool(ctx, "web_fetch", {
    url,
    offset: first.result.nextOffset,
    maxChars: 16000,
  });
  assert.equal(next.result.nextOffset, null);
  assert.equal(first.result.text + next.result.text, htmlToText(article).text);
  const raw = await f.runtime.callTool(ctx, "web_fetch", {
    url,
    mode: "raw",
    maxChars: 16000,
  });
  assert.equal(raw.result.text, article);
  assert.ok(f.calls.every((call) => call.limit === WEB_FETCH_DOWNLOAD_CHARS));
});

test("offset and mode stay out of the external authorization request", async (t) => {
  const f = setup(t);
  const url = "https://example.com/approved";
  const ctx = context(f.runtime);
  ctx.privateRead.add("operations:synthetic");
  await assert.rejects(
    f.runtime.callTool(ctx, "web_fetch", { url, offset: 40, mode: "raw" }),
    /EXTERNAL_CALL_BLOCKED/,
  );
  const pending = JSON.stringify(ctx.disclosureRequest);
  assert.match(pending, /example\.com\/approved/);
  assert.doesNotMatch(pending, /"offset"|"mode"|"maxChars"/);
  f.runtime.grant(disclosureApproval(ctx));
  const read = await f.runtime.callTool(ctx, "web_fetch", {
    url,
    offset: 40,
    mode: "text",
    maxChars: 200,
  });
  assert.equal(read.result.offset, 40);
  assert.equal(f.calls.length, 1);
});
