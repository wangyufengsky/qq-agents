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
  // Never split a UTF-16 surrogate pair across pages.
  offset = Math.min(offset, text.length);
  const from =
    offset > 0 && /[\uDC00-\uDFFF]/.test(text[offset] || "")
      ? offset - 1
      : offset;
  let end = Math.min(text.length, from + maxChars);
  if (end < text.length && /[\uDC00-\uDFFF]/.test(text[end])) end--;
  return {
    fileId: meta.fileId,
    name: meta.name,
    createdAt: meta.createdAt,
    format: /\.md$/i.test(meta.name) ? "markdown" : "text",
    text: text.slice(from, end),
    offset: from,
    totalChars: text.length,
    nextOffset: end < text.length ? end : null,
    ...(query ? { matches, matchesLimited: matches.length === 100 } : {}),
  };
}
