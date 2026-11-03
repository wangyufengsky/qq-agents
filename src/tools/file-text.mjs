export const TEXT_FILE = /\.(txt|md|csv|json|tsv|log|xml|yaml|yml)$/i;

// Both the model and administrator read the same verified bytes. A preview is
// a view of the immutable file, never a replacement or a claimed model read.
export function readFileText(files, agentId, fileId, options = {}) {
  let { offset = 0, maxChars = 8000, maxBytes = 50 * 1024 * 1024 } = options;
  if (
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    !Number.isSafeInteger(maxChars) ||
    maxChars < 512 ||
    maxChars > 16000
  )
    throw Error("FILE_READ_RANGE_INVALID");
  const { meta, text } = loadFileText(files, agentId, fileId, maxBytes);
  const matches = [];
  const query = String(options.query || "").slice(0, 200);
  if (query) {
    let start = 0;
    while (matches.length < 100) {
      const at = text.indexOf(query, start);
      if (at < 0) break;
      matches.push(at);
      start = at + query.length;
    }
  }
  // Segment by grapheme, so modifiers, flags and joined emoji stay together.
  offset = Math.min(offset, text.length);
  const graphemes = new Intl.Segmenter("und", {
    granularity: "grapheme",
  }).segment(text);
  let from = offset < text.length ? graphemes.containing(offset).index : offset;
  const markdown = /\.md$/i.test(meta.name);
  const fenceLine = (at) => {
    if (at === 0) return 0;
    const start = text.lastIndexOf("\n", Math.max(0, at - 1)) + 1;
    return /^[ \t]*```/.test(text.slice(start, start + 100)) ? start : at;
  };
  if (markdown) from = fenceLine(from);
  let end = Math.min(text.length, from + maxChars);
  if (end < text.length) end = graphemes.containing(end).index;
  if (markdown && end < text.length) end = Math.max(from, fenceLine(end));
  if (end === from && from < text.length)
    throw Error("FILE_TEXT_CLUSTER_TOO_LONG");
  // A paged Markdown reader must know whether the page starts inside a code
  // block. This is rendering context, never an instruction or a model read.
  const prefix = text.slice(0, from);
  const codeFence = (prefix.match(/^[ \t]*```.*$/gm) || []).length % 2 === 1;
  return {
    fileId: meta.fileId,
    name: meta.name,
    createdAt: meta.createdAt,
    format: markdown ? "markdown" : "text",
    codeFence,
    text: text.slice(from, end),
    offset: from,
    totalChars: text.length,
    nextOffset: end < text.length ? end : null,
    ...(query ? { matches, matchesLimited: matches.length === 100 } : {}),
  };
}

export function loadFileText(
  files,
  agentId,
  fileId,
  maxBytes = 50 * 1024 * 1024,
) {
  const meta = files.metadata(agentId, fileId);
  if (!TEXT_FILE.test(meta.name)) throw Error("FILE_NOT_TEXT");
  const { buffer } = files.read(agentId, fileId, maxBytes);
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    throw Error("FILE_NOT_TEXT");
  }
  if (text.includes("\0")) throw Error("FILE_NOT_TEXT");
  return { meta, text };
}

const SEARCH_RESULTS = 20,
  SEARCH_COUNT_LIMIT = 10000,
  SEARCH_CONTEXT_LINES = 2,
  SEARCH_CONTEXT_CHARS = 300;

// Searching finds a passage without paging through a long text by guessing
// offsets. Offsets share file_read's coordinates so a hit can be read in full.
// The query is escaped into a literal pattern: no user-controlled regex syntax
// reaches the engine, so matching stays linear and cannot backtrack.
export function searchFileText(files, agentId, fileId, options = {}) {
  const { offset = 0, maxBytes = 50 * 1024 * 1024 } = options;
  const query = typeof options.query === "string" ? options.query : "";
  if (!query.trim() || query.length > 200)
    throw Error("FILE_SEARCH_QUERY_INVALID");
  if (!Number.isSafeInteger(offset) || offset < 0)
    throw Error("FILE_READ_RANGE_INVALID");
  const { meta, text } = loadFileText(files, agentId, fileId, maxBytes);
  const start = Math.min(offset, text.length);
  const pattern = new RegExp(RegExp.escape(query), "giu");
  pattern.lastIndex = start;
  const matches = [];
  let count = 0,
    line = 1,
    counted = 0,
    resume = null,
    match;
  while (count < SEARCH_COUNT_LIMIT && (match = pattern.exec(text))) {
    count++;
    if (matches.length === SEARCH_RESULTS) continue;
    const at = match.index,
      end = at + match[0].length;
    // Lines are counted once, forward from the previous hit, so the whole
    // search stays a single pass even when hits are far into a large file.
    for (let i = text.indexOf("\n", counted); i >= 0 && i < at;) {
      line++;
      i = text.indexOf("\n", i + 1);
    }
    counted = at;
    let from = text.lastIndexOf("\n", at - 1) + 1;
    for (let n = 0; n < SEARCH_CONTEXT_LINES && from > 0; n++)
      from = text.lastIndexOf("\n", from - 2) + 1;
    let to = text.indexOf("\n", end);
    for (let n = 0; n < SEARCH_CONTEXT_LINES && to >= 0; n++)
      to = text.indexOf("\n", to + 1);
    if (to < 0) to = text.length;
    from = Math.max(from, at - SEARCH_CONTEXT_CHARS);
    to = Math.min(to, end + SEARCH_CONTEXT_CHARS);
    // A clipped edge must not split a surrogate pair into invalid text.
    if (from < at && /[\udc00-\udfff]/.test(text[from])) from++;
    if (to > end && /[\ud800-\udbff]/.test(text[to - 1])) to--;
    matches.push({
      offset: at,
      line,
      contextOffset: from,
      context: text.slice(from, to),
    });
    resume = end;
  }
  const truncated = count > matches.length;
  return {
    fileId: meta.fileId,
    name: meta.name,
    createdAt: meta.createdAt,
    format: /\.md$/i.test(meta.name) ? "markdown" : "text",
    query,
    offset: start,
    totalChars: text.length,
    matches,
    matchCount: count,
    matchCountLimited: count === SEARCH_COUNT_LIMIT,
    truncated,
    nextOffset: truncated ? resume : null,
  };
}
