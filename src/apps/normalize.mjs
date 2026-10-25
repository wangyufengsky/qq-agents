// Preserve exact IDs from source URLs before considering JSON numeric fields.
function exactId(value) {
  if (typeof value === "number" && !Number.isSafeInteger(value)) return "";
  const id = String(value ?? "");
  return /^\d+$/.test(id) ? id : "";
}
function sourceIdentity(value) {
  try {
    const u = new URL(value);
    if (
      u.protocol !== "https:" ||
      u.username ||
      u.password ||
      u.port ||
      !["api.zhihu.com", "www.zhihu.com", "zhuanlan.zhihu.com"].includes(
        u.hostname,
      )
    )
      return null;
    let m = u.pathname.match(/^\/question\/(\d+)\/answer\/(\d+)\/?$/);
    if (m) return { kind: "answer", id: m[2], questionId: m[1] };
    m = u.pathname.match(
      /^\/(?:api\/v[34]\/)?(articles|answers|questions)\/(\d+)\/?$/,
    );
    if (m)
      return {
        kind: { articles: "article", answers: "answer", questions: "question" }[
          m[1]
        ],
        id: m[2],
      };
    m = u.pathname.match(/^\/(question|p)\/(\d+)\/?$/);
    if (m) return { kind: m[1] === "p" ? "article" : "question", id: m[2] };
  } catch {}
  return null;
}
export function zhihuSearchRows(data) {
  return (data.data || []).flatMap((entry) => {
    const value = entry.target || entry.object || entry,
      source = sourceIdentity(value.url),
      kind = source?.kind || value.type,
      id = source?.id || exactId(value.id),
      question = sourceIdentity(value.question?.url);
    let url;
    if (!id) return [];
    if (kind === "article") url = `https://zhuanlan.zhihu.com/p/${id}`;
    if (kind === "question") url = `https://www.zhihu.com/question/${id}`;
    if (kind === "answer") {
      const questionId =
        source?.questionId ||
        (question?.kind === "question"
          ? question.id
          : exactId(value.question?.id));
      if (questionId)
        url = `https://www.zhihu.com/question/${questionId}/answer/${id}`;
    }
    return url
      ? [
          {
            type: kind,
            title: value.question?.title || value.title,
            author: value.author?.name,
            description: value.excerpt,
            url,
          },
        ]
      : [];
  });
}

// Modern browser/Node JSON reviver source preserves integers before IEEE-754 rounding.
export function parseExactJson(text) {
  return JSON.parse(text, (_key, value, context) => {
    if (
      typeof value === "number" &&
      Number.isInteger(value) &&
      !Number.isSafeInteger(value)
    ) {
      if (!/^-?\d+$/.test(context?.source || ""))
        throw Error("APP_RESPONSE_INVALID");
      return context.source;
    }
    return value;
  });
}
