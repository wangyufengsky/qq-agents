// @ts-check
// Readable text and cursor paging for web_fetch. This runs bridge-side on the
// body that safeFetch already downloaded through its address, DNS and redirect
// checks; it never fetches anything itself.

// Upper bound for one download. It is deliberately independent of the page
// window (maxChars), so a continuation slices the same extracted text instead
// of re-reading only the first window of HTML.
export const WEB_FETCH_DOWNLOAD_CHARS = 1_000_000;

const VOID = new Set(
  "area base br col embed hr img input link meta param source track wbr keygen".split(
    " ",
  ),
);
// Raw-text elements: their content is never markup, so skip to the end tag.
const RAW = new Set([
  "script",
  "style",
  "noscript",
  "template",
  "xmp",
  "textarea",
]);
// Page chrome and non-text widgets. `form` is handled separately because some
// sites wrap the whole page in one form element.
const CHROME = new Set(
  "nav footer aside svg math iframe object canvas button select dialog".split(
    " ",
  ),
);
const CHROME_ROLES = new Set([
  "navigation",
  "banner",
  "contentinfo",
  "search",
  "complementary",
  "dialog",
]);
const PARAGRAPH = new Set(
  "p h1 h2 h3 h4 h5 h6 blockquote pre table ul ol dl figure section article main header details hr address".split(
    " ",
  ),
);
const LINE = new Set(
  "div br li tr dt dd figcaption summary caption fieldset legend center".split(
    " ",
  ),
);
const CELL = new Set(["td", "th"]);
// Implied end tags (HTML parsing spec, simplified): a start tag closes an open
// element it cannot nest in, searching down to a boundary. Without this, a
// hidden <p> or <li> would hide every following sibling.
const SCOPE = ["button", "table", "td", "th", "caption", "object", "template"];
const CLOSES_P = new Set(
  "address article aside blockquote details dialog div dl dd dt fieldset figcaption figure footer form h1 h2 h3 h4 h5 h6 header hr li main menu nav ol p pre section table ul".split(
    " ",
  ),
);
/** @type {Record<string, [Set<string>, Set<string>]>} */
const IMPLIED = {
  li: [new Set(["li"]), new Set(["ul", "ol", "menu", ...SCOPE])],
  dt: [new Set(["dt", "dd"]), new Set(["dl", ...SCOPE])],
  dd: [new Set(["dt", "dd"]), new Set(["dl", ...SCOPE])],
  // Popping back to the previous row also closes its open cells.
  tr: [
    new Set(["tr"]),
    new Set(["table", "thead", "tbody", "tfoot", "template"]),
  ],
  td: [new Set(["td", "th"]), new Set(["tr", "table", "template"])],
  th: [new Set(["td", "th"]), new Set(["tr", "table", "template"])],
  option: [new Set(["option"]), new Set(["select", "datalist", "optgroup"])],
  optgroup: [new Set(["option", "optgroup"]), new Set(["select", "datalist"])],
};
const P_SCOPE = new Set(SCOPE);
// Real implied closes sit near the top of the stack; the cap keeps a deep
// stack of unrelated elements from making each start tag a full scan.
const IMPLIED_DEPTH = 256;
/** @type {Record<string, string>} */
const NAMED = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ensp: " ",
  emsp: " ",
  thinsp: " ",
  shy: "",
  zwnj: "",
  zwj: "",
  copy: "©",
  reg: "®",
  trade: "™",
  hellip: "…",
  mdash: "—",
  ndash: "–",
  lsquo: "‘",
  rsquo: "’",
  sbquo: "‚",
  ldquo: "“",
  rdquo: "”",
  bdquo: "„",
  laquo: "«",
  raquo: "»",
  middot: "·",
  bull: "•",
  times: "×",
  divide: "÷",
  deg: "°",
  plusmn: "±",
  para: "¶",
  sect: "§",
  euro: "€",
  pound: "£",
  yen: "¥",
  cent: "¢",
  larr: "←",
  rarr: "→",
  uarr: "↑",
  darr: "↓",
};
const TAG_NAME = /<(\/?)([a-zA-Z][a-zA-Z0-9:-]*)/y;
const TAG_STOP = /[>"']/g;

/** @param {string} text */
export function decodeEntities(text) {
  return text.replace(
    /&(?:#(\d{1,7})|#[xX]([0-9a-fA-F]{1,6})|([a-zA-Z][a-zA-Z0-9]{1,31}));?/g,
    (all, dec, hex, name) => {
      if (name) return Object.hasOwn(NAMED, name) ? NAMED[name] : all;
      const code = dec ? Number(dec) : parseInt(hex, 16);
      // Surrogates, NUL and out-of-range values are not characters.
      if (code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff))
        return "�";
      return String.fromCodePoint(code);
    },
  );
}

/**
 * Parse attribute names and values by index. A regex with optional quoted
 * groups rescans to the end of the tag at every name after an unclosed quote,
 * which is quadratic on one hostile tag.
 * @param {string} attrs
 */
function parseAttributes(attrs) {
  /** @type {Map<string, string>} */
  const values = new Map();
  const space = (/** @type {string} */ c) => c <= " ";
  let i = 0;
  while (i < attrs.length) {
    while (i < attrs.length && (space(attrs[i]) || attrs[i] === "/")) i++;
    const start = i;
    while (i < attrs.length && !space(attrs[i]) && !"=/>".includes(attrs[i]))
      i++;
    if (i === start) {
      i++;
      continue;
    }
    const name = attrs.slice(start, i).toLowerCase();
    let j = i;
    while (j < attrs.length && space(attrs[j])) j++;
    let value = "";
    if (attrs[j] === "=") {
      j++;
      while (j < attrs.length && space(attrs[j])) j++;
      const quote = attrs[j];
      if (quote === '"' || quote === "'") {
        const close = attrs.indexOf(quote, j + 1);
        const stop = close < 0 ? attrs.length : close;
        value = attrs.slice(j + 1, stop);
        j = stop + 1;
      } else {
        const from = j;
        while (j < attrs.length && !space(attrs[j])) j++;
        value = attrs.slice(from, j);
      }
      i = j;
    }
    if (!values.has(name)) values.set(name, value);
  }
  return values;
}

// Class/id words that mark widgets around the text (Wikipedia language menus,
// navboxes and category bars, share and cookie bars). Only whole words split on
// "-"/"_" count, and a content-like word keeps the element, so wrappers such as
// "has-sidebar main-content" are not dropped.
const CHROME_WORDS = new Set(
  "dropdown navbox catlinks editsection breadcrumb breadcrumbs sidebar navbar menu toolbar share sharing social cookie cookies banner advert ads sponsor popup modal pagination pager".split(
    " ",
  ),
);
const CONTENT_WORDS = new Set(["content", "article", "main", "body", "text"]);

/** @param {string} value */
function chromeWords(value) {
  const words = value.toLowerCase().split(/[\s_-]+/);
  return (
    words.some((word) => CHROME_WORDS.has(word)) &&
    !words.some((word) => CONTENT_WORDS.has(word))
  );
}

/** @param {string} attrs */
function chromeByAttributes(attrs) {
  // Cheap prefilter: skip tags that carry none of these attribute names.
  if (!/hidden|role|style|class|id/i.test(attrs)) return false;
  const values = parseAttributes(attrs);
  if (values.has("hidden")) return true;
  if (values.get("aria-hidden")?.toLowerCase() === "true") return true;
  if (CHROME_ROLES.has(String(values.get("role")).toLowerCase())) return true;
  if (/display\s*:\s*none/i.test(values.get("style") || "")) return true;
  return (
    chromeWords(values.get("class") || "") ||
    chromeWords(values.get("id") || "")
  );
}

/**
 * Index of the `>` that ends a tag whose attributes start at `from`, or -1.
 * Quoted values may contain `>`. An unclosed quote falls back to the next `>`,
 * and `noClose` remembers that, so hostile markup stays linear overall.
 * @param {string} html @param {number} from @param {Set<string>} noClose
 */
function tagEnd(html, from, noClose) {
  TAG_STOP.lastIndex = from;
  for (let m; (m = TAG_STOP.exec(html));) {
    if (m[0] === ">") return m.index;
    if (noClose.has(m[0])) continue;
    const close = html.indexOf(m[0], m.index + 1);
    if (close < 0) {
      noClose.add(m[0]);
      continue;
    }
    TAG_STOP.lastIndex = close + 1;
  }
  return -1;
}

// Tail scans by index: `/\n*$/` or `/ +$/` restart at every position of a long
// run and are quadratic on preformatted text.
/** @param {string} text @param {string} char */
function trailing(text, char) {
  let n = 0;
  while (n < text.length && text[text.length - 1 - n] === char) n++;
  return n;
}
/** @param {string} line */
function trimSpacesEnd(line) {
  let end = line.length;
  while (end && (line[end - 1] === " " || line[end - 1] === "\t")) end--;
  return end === line.length ? line : line.slice(0, end);
}

/**
 * Append-only text buffer that tracks its own tail. Inspecting a growing
 * concatenated string (out[out.length - 1]) flattens it each time, which is
 * quadratic on a megabyte page.
 */
class Out {
  /** @type {string[]} */
  parts = [];
  newlines = 0;
  space = false;
  started = false;
  /** @param {string} text @param {boolean} pre */
  text(text, pre) {
    if (!pre && (!this.started || this.newlines || this.space))
      text = text.trimStart();
    if (!text) return;
    this.parts.push(text);
    this.started ||= /\S/.test(text);
    const newlines = trailing(text, "\n");
    this.newlines =
      newlines === text.length ? this.newlines + newlines : newlines;
    this.space = text.endsWith(" ");
  }
  /** @param {number} count */
  breakLine(count) {
    if (this.space) {
      const last = this.parts.length - 1;
      const part = this.parts[last];
      this.parts[last] = part.slice(0, part.length - trailing(part, " "));
      this.space = false;
      const newlines = trailing(this.parts[last], "\n");
      if (newlines) this.newlines = newlines;
    }
    if (!this.started) return;
    if (this.newlines < count) {
      this.parts.push("\n".repeat(count - this.newlines));
      this.newlines = count;
    }
  }
  join() {
    return this.parts.join("");
  }
}

/**
 * One scanner pass. Text is collected into three buckets (whole body, inside
 * <article>, inside <main>) so the caller can pick the main region without a
 * second parse.
 * @param {string} html
 * @param {{ dropForms: boolean }} options
 */
function collect(html, { dropForms }) {
  const buckets = { body: new Out(), article: new Out(), main: new Out() };
  /** @type {string[]} */
  const stack = [];
  // Open-element counts let a stray end tag be ignored without scanning the
  // stack; a matched one pops what it scans, so the work stays amortized.
  /** @type {Map<string, number>} */
  const open = new Map();
  /** @type {Set<string>} */
  const noClose = new Set();
  let skipAt = -1;
  let inArticle = 0;
  let inMain = 0;
  let inPre = 0;
  let title = "";
  const targets = () => [
    buckets.body,
    ...(inArticle ? [buckets.article] : []),
    ...(inMain ? [buckets.main] : []),
  ];
  /** @param {number} count */
  const breakLine = (count) => {
    for (const out of targets()) out.breakLine(count);
  };
  /** @param {string} raw */
  const emit = (raw) => {
    let text = decodeEntities(raw);
    // \s includes U+00A0, so decoded &nbsp; collapses like other spaces.
    if (!inPre) text = text.replace(/\s+/g, " ");
    if (text) for (const out of targets()) out.text(text, inPre > 0);
  };
  /** @param {number} index */
  const popTo = (index) => {
    while (stack.length > index) {
      const name = /** @type {string} */ (stack.pop());
      open.set(name, (open.get(name) || 1) - 1);
      if (name === "article") inArticle--;
      if (name === "main") inMain--;
      if (name === "pre") inPre--;
    }
    if (skipAt >= stack.length) skipAt = -1;
  };
  /** @param {Set<string>} names @param {Set<string>} stops */
  const closeOpen = (names, stops) => {
    if (![...names].some((name) => open.get(name))) return;
    const floor = Math.max(0, stack.length - IMPLIED_DEPTH);
    for (let i = stack.length - 1; i >= floor; i--) {
      if (names.has(stack[i])) return popTo(i);
      if (stops.has(stack[i])) return;
    }
  };
  const P_ONLY = new Set(["p"]);
  let pos = 0;
  while (pos < html.length) {
    const lt = html.indexOf("<", pos);
    if (lt < 0) {
      if (skipAt < 0) emit(html.slice(pos));
      break;
    }
    if (lt > pos && skipAt < 0) emit(html.slice(pos, lt));
    if (html.startsWith("<!--", lt)) {
      const end = html.indexOf("-->", lt + 4);
      pos = end < 0 ? html.length : end + 3;
      continue;
    }
    if (html[lt + 1] === "!" || html[lt + 1] === "?") {
      const end = html.indexOf(">", lt);
      pos = end < 0 ? html.length : end + 1;
      continue;
    }
    TAG_NAME.lastIndex = lt;
    const m = TAG_NAME.exec(html);
    if (!m) {
      if (skipAt < 0) emit("<");
      pos = lt + 1;
      continue;
    }
    const end = tagEnd(html, TAG_NAME.lastIndex, noClose);
    if (end < 0) break; // an unterminated tag runs to the end of the input
    const name = m[2].toLowerCase();
    const attrs = html.slice(TAG_NAME.lastIndex, end);
    pos = end + 1;
    if (m[1]) {
      if (!open.get(name)) continue;
      const index = stack.lastIndexOf(name);
      const visible = skipAt < 0;
      popTo(index);
      if (visible && skipAt < 0) {
        if (PARAGRAPH.has(name)) breakLine(2);
        else if (LINE.has(name)) breakLine(1);
      }
      continue;
    }
    if (RAW.has(name) || name === "title") {
      const close = new RegExp(`</${name}[\\s/>]`, "ig");
      close.lastIndex = pos;
      const found = close.exec(html);
      const stop = found ? found.index : html.length;
      if (name === "title" && !title && skipAt < 0)
        title = decodeEntities(html.slice(pos, stop))
          .replace(/\s+/g, " ")
          .trim();
      const after = found ? html.indexOf(">", stop) : -1;
      pos = after < 0 ? html.length : after + 1;
      continue;
    }
    // Closing an implied element may also end a hidden one, so do it before
    // deciding visibility and line breaks for this tag.
    if (CLOSES_P.has(name)) closeOpen(P_ONLY, P_SCOPE);
    if (Object.hasOwn(IMPLIED, name)) closeOpen(...IMPLIED[name]);
    if (VOID.has(name) || attrs.endsWith("/")) {
      if (skipAt < 0 && (name === "br" || name === "hr"))
        breakLine(name === "hr" ? 2 : 1);
      continue;
    }
    if (skipAt < 0) {
      if (PARAGRAPH.has(name)) breakLine(2);
      else if (LINE.has(name)) breakLine(1);
      else if (CELL.has(name)) emit(" ");
    }
    stack.push(name);
    open.set(name, (open.get(name) || 0) + 1);
    if (name === "article") inArticle++;
    if (name === "main") inMain++;
    if (name === "pre") inPre++;
    // Outside <main>/<article>, a <header> is the site banner; inside one it
    // usually carries the page title, so keep it there.
    const chrome =
      CHROME.has(name) ||
      (dropForms && name === "form") ||
      (name === "header" && !inArticle && !inMain) ||
      chromeByAttributes(attrs);
    if (skipAt < 0 && chrome) skipAt = stack.length - 1;
    if (name === "li" && skipAt < 0) emit("• ");
  }
  return {
    title,
    buckets: {
      body: buckets.body.join(),
      article: buckets.article.join(),
      main: buckets.main.join(),
    },
  };
}

/** @param {string} text */
function tidy(text) {
  return text
    .split("\n")
    .map(trimSpacesEnd)
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** @param {{ body: string, article: string, main: string }} buckets */
function mainText(buckets) {
  const article = tidy(buckets.article);
  const main = tidy(buckets.main);
  if (article.length >= 200 && article.length * 2 >= main.length)
    return article;
  if (main.length >= 200) return main;
  return tidy(buckets.body);
}

/**
 * Extract readable text from an HTML document, preferring <article>/<main>.
 * @param {string} html
 * @returns {{ title: string, text: string }}
 */
export function htmlToText(html) {
  const first = collect(html, { dropForms: true });
  let text = mainText(first.buckets);
  // Some frameworks wrap the entire page in one <form>; dropping it would
  // leave almost nothing, so fall back to keeping forms when that happens.
  if (text.length < 200) {
    const kept = mainText(collect(html, { dropForms: false }).buckets);
    if (kept.length > text.length) text = kept;
  }
  return { title: first.title, text };
}

/**
 * @param {string} contentType
 * @param {string} body
 */
export function looksLikeHtml(contentType, body) {
  const type = String(contentType || "")
    .split(";")[0]
    .trim()
    .toLowerCase();
  if (type) return type === "text/html" || type === "application/xhtml+xml";
  // Without a header, only sniff unambiguous document starts. Leading
  // comments are skipped by index; a nested repeated regex backtracks
  // exponentially on many comments followed by plain text.
  let i = body.startsWith("\uFEFF") ? 1 : 0;
  for (;;) {
    while (i < body.length && body[i] <= " ") i++;
    if (!body.startsWith("<!--", i)) break;
    const end = body.indexOf("-->", i + 4);
    if (end < 0) return false;
    i = end + 3;
  }
  return /^<(?:!doctype\s+html|html[\s>]|head[\s>]|body[\s>])/i.test(
    body.slice(i, i + 64),
  );
}

/**
 * Turn a safeFetch result into one page window of readable text.
 * Offsets are UTF-16 indices aligned to grapheme boundaries, matching file_read.
 * @param {{ url?: string, statusCode?: number, truncated?: boolean, body?: string, contentType?: string }} page
 * @param {{ offset?: number, maxChars?: number, mode?: "text" | "raw" }} options
 */
export function webPage(page, { offset = 0, maxChars = 12000, mode = "text" }) {
  const body = typeof page.body === "string" ? page.body : "";
  const html = looksLikeHtml(page.contentType || "", body);
  let title = "";
  let text = body;
  let format = "raw";
  if (mode === "text" && html) {
    ({ title, text } = htmlToText(body));
    format = "html-text";
  } else if (mode === "text") format = "text";
  const graphemes = new Intl.Segmenter("und", {
    granularity: "grapheme",
  }).segment(text);
  // Only called with an index inside the text, where a segment always exists.
  const cluster = (/** @type {number} */ at) =>
    /** @type {Intl.SegmentData} */ (graphemes.containing(at));
  const at = Math.min(Math.max(0, offset), text.length);
  const from = at < text.length ? cluster(at).index : at;
  let end = Math.min(text.length, from + maxChars);
  if (end < text.length) end = cluster(end).index;
  // A single cluster longer than the window still has to make progress.
  if (end === from && from < text.length)
    end = from + cluster(from).segment.length;
  const downloadTruncated = page.truncated === true;
  const notices = [];
  if (downloadTruncated)
    notices.push(
      "页面超过单次下载上限，availableChars 之后的内容未下载；读到 nextOffset 为 null 也不算读完全文。",
    );
  if (format === "html-text" && !text && body.trim())
    notices.push(
      "未提取到网页正文，页面可能依赖脚本渲染；需要源码时可用 mode raw。",
    );
  return {
    url: page.url,
    statusCode: page.statusCode,
    ...(page.contentType ? { contentType: page.contentType } : {}),
    format,
    ...(title ? { title } : {}),
    text: text.slice(from, end),
    offset: from,
    nextOffset: end < text.length ? end : null,
    // A truncated download cuts the source, so the full length is unknown.
    totalChars: downloadTruncated ? null : text.length,
    ...(downloadTruncated
      ? { downloadTruncated: true, availableChars: text.length }
      : {}),
    ...(notices.length ? { notice: notices.join(" ") } : {}),
  };
}
