const workspace = document.querySelector("#story-workspace");
const statusLine = document.querySelector("#story-status");
const navigation = document.querySelector(".story-nav");
const narrow = matchMedia("(max-width: 850px)");
const emptyPage = { items: [], nextOffset: null };
const entryShelf =
  new URLSearchParams(location.search).get("shelf") === "library"
    ? "library"
    : "writing";
document.querySelector("#back-to-study").href =
  "/home-space/#study/" + (entryShelf === "library" ? "shelf" : "desk");
const state = {
  shelf: entryShelf,
  books: emptyPage,
  book: null,
  query: "",
  screen: "shelf",
  opening: { title: "", text: "" },
  drafts: new Map(),
  noteDrafts: new Map(),
  paragraphId: null,
  notes: emptyPage,
  editing: null,
  showNotes: false,
  review: null,
  listOffset: 0,
  noteOffset: 0,
  sequence: 0,
  saving: false,
  loading: false,
  request: null,
};

const messages = {
  STORY_REVISION_CONFLICT: "已经有新内容，草稿仍在。请读完更新后再提交。",
  STORY_PUBLISHED: "这本书已经入馆。正在写的文字仍可复制。",
  STORY_WRITE_DENIED: "这项操作需要当前作者完成。",
  STORY_NOT_FOUND: "找不到这本书或这条记录。请刷新后再试。",
  STORY_LENGTH_LIMIT: "手稿已达到短篇篇幅上限，可以提出结尾。",
  INVALID_REQUEST: "请检查书名和正文是否为空或超过字数。",
  SENSITIVE_OUTPUT_BLOCKED: "这段内容含有凭据信息，请删去后再提交。",
  UNAUTHORIZED: "请先在管理台登录，再返回故事会。",
  CONNECTION_LOST: "故事会暂时连不上。草稿仍在，可以用相同内容重试。",
};

const escaped = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};
const html = (value) =>
  String(value ?? "").replace(/[&<>"']/g, (c) => escaped[c]);
const clock = new Intl.DateTimeFormat("zh-CN", {
  month: "numeric",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});
const day = new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium" });
const currentDraft = () => state.drafts.get(state.book?.id) || "";
const pendingDraft = () => state.noteDrafts.get(state.paragraphId) || "";
const status = (message = "") => {
  statusLine.textContent = message;
};

async function api(kind, args = {}) {
  const token = sessionStorage.getItem("qq-unified-token");
  if (!token) throw Error("UNAUTHORIZED");
  let response;
  try {
    response = await fetch("/api/home-stories", {
      method: "POST",
      headers: { "x-admin-token": token, "content-type": "application/json" },
      body: JSON.stringify({ kind, ...args }),
      cache: "no-store",
      signal: AbortSignal.timeout(8000),
    });
  } catch {
    throw Error("CONNECTION_LOST");
  }
  if (
    response.status === 401 ||
    token !== sessionStorage.getItem("qq-unified-token")
  )
    throw Error("UNAUTHORIZED");
  const data = await response.json();
  if (!response.ok) throw Error(data.error);
  return data;
}

function handleError(error) {
  if (error.message === "UNAUTHORIZED") {
    workspace.innerHTML =
      '<section class="page"><p>请先在<a href="/">管理台登录</a>，再返回故事会。</p></section>';
    navigation.hidden = true;
  }
  status(messages[error.message] || "操作暂时未完成，请刷新后重试。");
}

async function load({ bookId = state.book?.id, focus = false } = {}) {
  const sequence = ++state.sequence;
  state.loading = true;
  try {
    const [books, book] = await Promise.all([
      api("list", {
        shelf: state.shelf,
        query: state.query,
        offset: state.listOffset,
      }),
      bookId ? api("read", { bookId }) : null,
    ]);
    if (sequence !== state.sequence) return;
    if (book?.publishedAt != null && state.shelf !== "library") {
      state.shelf = "library";
      state.query = "";
      state.listOffset = 0;
      return load({ bookId, focus });
    }
    const notes =
      book && state.paragraphId
        ? await api("notes", {
            bookId,
            paragraphId: state.paragraphId,
            offset: state.noteOffset,
          })
        : emptyPage;
    if (sequence !== state.sequence) return;
    state.book = book;
    state.books = books;
    state.notes = notes;
    if (
      state.screen === "review" &&
      !book?.endings.some(({ id }) => id === state.review.endingId)
    )
      state.screen = "book";
    navigation.hidden = false;
    render();
    if (focus) workspace.querySelector("h2")?.focus();
  } catch (error) {
    if (sequence === state.sequence) handleError(error);
  } finally {
    if (sequence === state.sequence) state.loading = false;
  }
}

function listPage() {
  const library = state.shelf === "library";
  return `<aside class="book-list" aria-label="${library ? "馆藏书目" : "在写书目"}">
    <h2>${library ? "图书馆" : "在写"}</h2>
    ${library ? `<form data-form="search"><label>搜书名或作者<input type="search" name="query" maxlength="80" value="${html(state.query)}"></label><div><button>查找</button></div></form>` : ""}
    <ul>${state.books.items
      .map(
        (
          book,
        ) => `<li><button type="button" class="book-link" data-action="read" data-id="${html(book.id)}" aria-current="${state.book?.id === book.id}">
      <span class="cover" aria-hidden="true">${html(Array.from(book.title)[0])}</span>
      <span><span class="book-title">${html(book.title)}</span>
      <span class="shelf-caption">${html(library ? book.authors.join(" · ") : book.owner + " · " + book.paragraphCount + " 段")}</span>
      <time class="shelf-caption">${library ? day.format(book.publishedAt) : clock.format(book.updatedAt)}</time></span>
    </button></li>`,
      )
      .join("")}</ul>
    ${state.books.items.length ? "" : `<p class="muted">${state.query ? "没有符合搜索条件的书。" : library ? "图书馆还没有完结作品。" : "还没有人在写书。"}</p>`}
    ${pagination("list", state.listOffset, state.books.nextOffset)}
  </aside>`;
}

function pagination(scope, offset, nextOffset) {
  if (!offset && nextOffset === null) return "";
  return `<div class="actions">${offset ? `<button type="button" data-action="${scope}-prev">上一页</button>` : ""}
    ${nextOffset === null ? "" : `<button type="button" data-action="${scope}-next">下一页</button>`}</div>`;
}

function openPage() {
  return `<section class="page"><h2 tabindex="-1">开一本书</h2>
    <form data-form="open">
      <label>书名<input required name="title" maxlength="80" value="${html(state.opening.title)}"></label>
      <label>第一段<textarea required name="text" maxlength="600">${html(state.opening.text)}</textarea></label>
      <div class="actions"><button class="primary">保存开篇</button><button type="button" data-action="writing">取消</button></div>
    </form>
  </section>`;
}

function paragraphView(paragraph, showNotes, signed) {
  return `<section class="paragraph" id="paragraph-${html(paragraph.id)}">
    ${
      signed || showNotes
        ? `<p class="paragraph-byline">
      ${html(paragraph.author)}
      ${showNotes && (!paragraph.mine || paragraph.noteCount) ? `<button type="button" class="note-trigger" data-action="notes" data-id="${html(paragraph.id)}" aria-expanded="${state.paragraphId === paragraph.id}">批注${paragraph.noteCount ? " " + paragraph.noteCount : ""}</button>` : ""}
    </p>`
        : ""
    }
    <p class="paragraph-text">${html(paragraph.text)}</p>
  </section>`;
}

function notesPanel(paragraph) {
  const noteForm = paragraph.mine
    ? ""
    : `<form data-form="note">
    <label>写下批注<textarea required maxlength="500" name="text">${html(pendingDraft())}</textarea></label>
    <div><button class="primary">添加批注</button></div>
  </form>`;
  return `<aside class="notes" aria-label="段落批注">
    <header><h3>段落批注</h3><button data-action="close-notes" type="button" aria-label="收起段落批注">×</button></header>
    <p class="eyebrow">${html(paragraph.author)} · 第 ${state.book.paragraphs.indexOf(paragraph) + 1} 段</p>
    ${state.notes.items.length ? "" : '<p class="muted">这段还没有批注。</p>'}
    ${state.notes.items
      .map(
        (note) => `<article class="note">
      <header><strong>${html(note.author)}</strong><time>${clock.format(note.at)}</time></header>
      ${
        state.editing?.id === note.id
          ? `<form data-form="edit-note">
        ${state.editing.revision !== note.revision ? `<p class="wrap">当前批注：${html(note.text)}</p>` : ""}
        <label>编辑批注<textarea name="text" required maxlength="500">${html(state.editing.text)}</textarea></label>
        <div class="actions"><button class="primary">保存批注</button><button type="button" data-action="cancel-edit">取消</button></div>
      </form>`
          : `<p class="wrap">${html(note.text)}</p>
        ${note.mine ? `<div class="actions"><button type="button" data-action="edit-note" data-id="${html(note.id)}">编辑</button><button type="button" data-action="withdraw-note" data-id="${html(note.id)}">撤回</button></div>` : ""}`
      }
    </article>`,
      )
      .join("")}
    ${pagination("notes", state.noteOffset, state.notes.nextOffset)}
    ${noteForm}
  </aside>`;
}

function endingsView(book) {
  if (!book.endings.length) return "";
  return `<section class="endings"><h3>候选结尾</h3>
    ${book.endings
      .map(
        (ending) => `<article>
        <p class="paragraph-byline">${html(ending.author)}${ending.revision !== book.revision ? " · 基于较早的正文" : ""}</p>
        <p class="paragraph-text">${html(ending.text)}</p>
        ${book.mine ? `<button type="button" data-action="review" data-id="${html(ending.id)}">预览入馆</button>` : ""}
      </article>`,
      )
      .join("")}
  </section>`;
}

function reader(book) {
  const published = book.publishedAt !== null;
  const showNotes = !published || state.showNotes;
  const annotated =
    showNotes && book.paragraphs.find((p) => p.id === state.paragraphId);
  return `<section class="reader">
    <header class="book-head">
      <div class="actions"><h2 tabindex="-1">${html(book.title)}</h2>
      ${published ? '<span class="chip">已入馆</span>' : '<button data-action="writing" type="button">返回在写</button>'}</div>
      ${
        published
          ? `<p class="muted">${html(book.authors.join(" · "))} · ${day.format(book.publishedAt)}</p>
      <p class="wrap">${html(book.synopsis)}</p><p><button type="button" data-action="toggle-notes" aria-pressed="${state.showNotes}">${state.showNotes ? "隐藏批注" : "显示批注"}</button></p>`
          : ""
      }
    </header>
    <div class="reader-grid"><div class="manuscript">
      ${book.paragraphs
        .map(
          (paragraph) =>
            paragraphView(paragraph, showNotes, !published) +
            (narrow.matches && annotated === paragraph
              ? notesPanel(annotated)
              : ""),
        )
        .join("")}
      ${
        published
          ? currentDraft()
            ? `<div class="composer"><label>未提交的续写<textarea readonly>${html(currentDraft())}</textarea></label></div>`
            : ""
          : `${endingsView(book)}
        <form data-form="append" class="composer">
          <label>接着写下去<textarea required name="text" maxlength="600" placeholder="接着写下去…">${html(currentDraft())}</textarea></label>
          <div class="actions"><button class="primary" value="append">提交续写</button><button value="ending">提出结尾</button></div>
        </form>`
      }
    </div>${annotated && !narrow.matches ? notesPanel(annotated) : ""}</div>
  </section>`;
}

function reviewPage(book, ending) {
  return `<section class="page">
    <h2 tabindex="-1">入馆确认</h2>
    <form data-form="publish">
      <label>书名<input name="title" required maxlength="80" value="${html(state.review.title)}"></label>
      <label>简介<textarea name="synopsis" required maxlength="300">${html(state.review.synopsis)}</textarea></label>
      <section class="preview" aria-label="整稿预览">
        ${book.paragraphs.map((paragraph) => paragraphView(paragraph, false, true)).join("")}
        <div class="ending-preview"><span class="chip">候选结尾</span>
        ${ending.revision === book.revision ? "" : '<p class="muted">此结尾写于较早的正文，请核对新增段落。</p>'}
        ${paragraphView(ending, false, true)}</div>
      </section>
      <div class="actions"><button type="button" data-action="continue">继续写</button><button class="primary">确认入馆</button></div>
    </form>
  </section>`;
}

function render() {
  for (const button of navigation.querySelectorAll(
    '[data-action="writing"],[data-action="library"]',
  ))
    button.setAttribute(
      "aria-current",
      button.dataset.action === state.shelf ? "page" : "false",
    );
  const book = state.book;
  const ending =
    state.review &&
    book?.endings.find(({ id }) => id === state.review.endingId);
  if (state.screen === "review" && book && ending) {
    workspace.innerHTML = reviewPage(book, ending);
  } else if (state.screen === "book" && book && state.shelf === "writing") {
    workspace.innerHTML = reader(book);
  } else {
    const body =
      state.screen === "open"
        ? openPage()
        : book
          ? reader(book)
          : `<section class="page"><h2 tabindex="-1">${state.shelf === "library" ? "馆藏阅读" : "手稿"}</h2>
       <p class="muted">${state.shelf === "library" ? "从书目选一本书阅读。" : "选一本继续写，或者开一本新书。"}</p></section>`;
    workspace.innerHTML = `<div class="split">${listPage()}${body}</div>`;
  }
}

function clearNotes() {
  state.paragraphId = null;
  state.noteOffset = 0;
  state.notes = emptyPage;
  state.editing = null;
}

async function navigate(action, id) {
  status();
  if (action === "refresh") return load();
  if (action === "continue") {
    state.screen = "book";
    return render();
  }
  if (action === "review") {
    state.review = { endingId: id, title: state.book.title, synopsis: "" };
    state.screen = "review";
    render();
    return workspace.querySelector("h2")?.focus();
  }
  if (action === "toggle-notes") {
    state.showNotes = !state.showNotes;
    if (!state.showNotes) clearNotes();
    render();
    return workspace.querySelector('[data-action="toggle-notes"]')?.focus();
  }
  if (action === "notes") {
    clearNotes();
    state.paragraphId = id;
    await load();
    workspace.querySelector(".notes")?.scrollIntoView({ block: "nearest" });
    return workspace
      .querySelector('.notes [data-action="close-notes"]')
      ?.focus({ preventScroll: true });
  }
  if (action === "close-notes") {
    const paragraph = document.getElementById("paragraph-" + state.paragraphId);
    const id = paragraph?.id;
    clearNotes();
    render();
    return document.getElementById(id)?.querySelector(".note-trigger")?.focus();
  }
  if (action === "edit-note") {
    state.editing = { ...state.notes.items.find((note) => note.id === id) };
    render();
    return workspace.querySelector('[data-form="edit-note"] textarea')?.focus();
  }
  if (action === "cancel-edit") {
    state.editing = null;
    return render();
  }
  if (action === "withdraw-note") {
    const note = state.notes.items.find((note) => note.id === id);
    if (!note) return;
    return mutate("withdraw_note", {
      bookId: state.book.id,
      paragraphId: state.paragraphId,
      noteId: id,
      revision: note.revision,
    });
  }
  if (action.endsWith("-prev") || action.endsWith("-next")) {
    const notes = action.startsWith("notes");
    const key = notes ? "noteOffset" : "listOffset";
    state[key] = action.endsWith("-prev")
      ? Math.max(0, state[key] - 20)
      : (notes ? state.notes : state.books).nextOffset;
    return load();
  }
  clearNotes();
  state.showNotes = false;
  if (action === "read") {
    state.screen = "book";
    return load({ bookId: id, focus: true });
  }
  state.shelf = action === "library" ? "library" : "writing";
  state.screen = action === "open" ? "open" : "shelf";
  state.listOffset = 0;
  state.query = "";
  return load({ bookId: null, focus: true });
}

async function mutate(kind, args) {
  if (state.saving) return;
  state.saving = true;
  workspace.setAttribute("aria-busy", "true");
  const signature = JSON.stringify({ kind, args });
  if (state.request?.signature !== signature)
    state.request = { signature, id: crypto.randomUUID() };
  status("正在保存…");
  try {
    const receipt = await api(kind, { ...args, requestId: state.request.id });
    state.request = null;
    if (kind === "open") {
      state.opening = { title: "", text: "" };
      state.screen = "book";
    }
    if (kind === "append" || kind === "ending") {
      if (currentDraft() === args.text) state.drafts.delete(args.bookId);
    }
    if (kind === "annotate") {
      if (pendingDraft() === args.text)
        state.noteDrafts.delete(args.paragraphId);
      state.noteOffset = 0;
    }
    if (kind === "edit_note") state.editing = null;
    if (kind === "withdraw_note") state.noteOffset = 0;
    if (kind === "publish") {
      state.shelf = "library";
      state.screen = "book";
      state.query = "";
      state.listOffset = 0;
    }
    status(kind === "publish" ? "已收入图书馆。" : "已保存。");
    await load({ bookId: receipt.bookId });
  } catch (error) {
    handleError(error);
    if (
      [
        "STORY_REVISION_CONFLICT",
        "STORY_PUBLISHED",
        "STORY_NOT_FOUND",
      ].includes(error.message)
    )
      await load();
  } finally {
    workspace.removeAttribute("aria-busy");
    state.saving = false;
  }
}

document.body.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-action]");
  if (button && !state.saving && !state.loading)
    void navigate(button.dataset.action, button.dataset.id);
});

workspace.addEventListener("input", (event) => {
  const input = event.target;
  const form = input.form?.dataset.form;
  if (form === "open") state.opening[input.name] = input.value;
  if (form === "append") state.drafts.set(state.book.id, input.value);
  if (form === "note") state.noteDrafts.set(state.paragraphId, input.value);
  if (form === "edit-note") state.editing.text = input.value;
  if (form === "publish") state.review[input.name] = input.value;
});

workspace.addEventListener("submit", (event) => {
  event.preventDefault();
  if (state.saving || state.loading) return;
  const form = event.target;
  const values = Object.fromEntries(new FormData(form));
  const bookId = state.book?.id;
  const revision = state.book?.revision;
  const paragraphId = state.paragraphId;
  switch (form.dataset.form) {
    case "search":
      state.query = values.query;
      state.listOffset = 0;
      return void load();
    case "open":
      return void mutate("open", values);
    case "append":
      return void mutate(event.submitter?.value || "append", {
        bookId,
        revision,
        ...values,
      });
    case "note":
      return void mutate("annotate", { bookId, paragraphId, ...values });
    case "edit-note": {
      const note = state.notes.items.find(({ id }) => id === state.editing.id);
      if (note)
        return void mutate("edit_note", {
          bookId,
          paragraphId,
          noteId: note.id,
          revision: note.revision,
          ...values,
        });
      break;
    }
    case "publish":
      return void mutate("publish", {
        bookId,
        revision,
        endingId: state.review.endingId,
        ...values,
      });
  }
});

narrow.addEventListener("change", () => {
  if (state.book) render();
});
void load();
