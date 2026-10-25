// Translate only content identities from fixed read API responses; never forward API URLs.
export function zhihuSearchRows(data) {
  return (data.data || []).flatMap((entry) => {
    const value = entry.object || entry,
      question = value.question || value;
    let id = String(value.id || ""),
      kind = value.type,
      url;
    try {
      const source = new URL(value.url);
      if (
        ["api.zhihu.com", "www.zhihu.com", "zhuanlan.zhihu.com"].includes(
          source.hostname,
        )
      ) {
        const m = source.pathname.match(
          /\/(articles|answers|questions)\/(\d+)/,
        );
        if (m) {
          id = m[2];
          kind = {
            articles: "article",
            answers: "answer",
            questions: "question",
          }[m[1]];
        }
      }
    } catch {}
    if (!/^\d+$/.test(id)) return [];
    if (kind === "article") url = `https://zhuanlan.zhihu.com/p/${id}`;
    if (kind === "question") url = `https://www.zhihu.com/question/${id}`;
    if (kind === "answer" && /^\d+$/.test(String(value.question?.id || "")))
      url = `https://www.zhihu.com/question/${value.question.id}/answer/${id}`;
    return url
      ? [
          {
            title: question.title,
            author: value.author?.name,
            description: value.excerpt,
            url,
          },
        ]
      : [];
  });
}
