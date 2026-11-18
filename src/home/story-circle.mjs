import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";

const id = z.uuid();
const revision = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const text = (max) => z.string().trim().min(1).max(max);
const title = text(80);
const paragraph = text(600);
const note = text(500);
const requestId = z.string().regex(/^[a-zA-Z0-9_-]{8,64}$/);
const offset = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(0);
const book = { bookId: id };
const manuscript = { ...book, revision };
const action = (kind, fields) =>
  z.strictObject({ kind: z.literal(kind), ...fields });
const write = (kind, fields) => action(kind, { ...fields, requestId });

export const storyAdmin = { key: "admin", name: "你" };

export const storyInput = z.discriminatedUnion("kind", [
  action("list", {
    shelf: z.enum(["writing", "library"]),
    query: z.string().trim().max(80).default(""),
    offset,
  }),
  action("read", book),
  action("notes", { ...book, paragraphId: id, offset }),
  write("open", { title, text: paragraph }),
  write("append", { ...manuscript, text: paragraph }),
  write("ending", { ...manuscript, text: paragraph }),
  write("publish", { ...manuscript, endingId: id, title, synopsis: text(300) }),
  write("annotate", { ...book, paragraphId: id, text: note }),
  write("edit_note", {
    ...book,
    paragraphId: id,
    noteId: id,
    revision,
    text: note,
  }),
  write("withdraw_note", { ...book, paragraphId: id, noteId: id, revision }),
]);

export function initializeStoryTables(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS story_books(
      id TEXT PRIMARY KEY, shelf TEXT NOT NULL, updated_at INTEGER NOT NULL, search_text TEXT NOT NULL, document TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS story_books_shelf ON story_books(shelf, updated_at DESC, id);
    CREATE TABLE IF NOT EXISTS story_requests(
      actor TEXT NOT NULL, request_id TEXT NOT NULL, digest TEXT NOT NULL, receipt TEXT NOT NULL,
      PRIMARY KEY(actor,request_id)
    );
  `);
}

const pageSize = 20;
const paragraphLimit = 32;
function find(items, itemId) {
  const item = items.find(({ id }) => id === itemId);
  if (!item) throw Error("STORY_NOT_FOUND");
  return item;
}
function authored(author, text, at) {
  return { id: randomUUID(), author, text, at };
}
function authors(book) {
  return [
    ...new Map(
      book.paragraphs.map(({ author }) => [author.key, author.name]),
    ).values(),
  ];
}
function summary(book, actor) {
  return {
    id: book.id,
    title: book.title,
    owner: book.owner.name,
    mine: book.owner.key === actor.key,
    updatedAt: book.updatedAt,
    publishedAt: book.publishedAt,
    synopsis: book.synopsis,
    authors: authors(book),
    paragraphCount: book.paragraphs.length,
  };
}
function display({ author, ...item }, actor) {
  return { ...item, author: author.name, mine: author.key === actor.key };
}
function page(items, offset) {
  return {
    items: items.slice(0, pageSize),
    nextOffset: items.length > pageSize ? offset + pageSize : null,
  };
}

export class StoryCircle {
  constructor(memory) {
    this.memory = memory;
    this.db = memory.db;
  }
  book(id) {
    const row = this.db
      .prepare("SELECT document FROM story_books WHERE id=?")
      .get(id);
    if (!row) throw Error("STORY_NOT_FOUND");
    return JSON.parse(row.document);
  }
  read(actor, args) {
    if (args.kind === "list") {
      const query = args.query.toLowerCase();
      const rows = this.db
        .prepare(
          `
        SELECT document FROM story_books
        WHERE shelf = ? AND instr(search_text, ?) > 0
        ORDER BY updated_at DESC, id
        LIMIT ? OFFSET ?
      `,
        )
        .all(args.shelf, query, pageSize + 1, args.offset);
      return page(
        rows.map(({ document }) => summary(JSON.parse(document), actor)),
        args.offset,
      );
    }
    const book = this.book(args.bookId);
    if (args.kind === "notes") {
      const paragraph = find(book.paragraphs, args.paragraphId);
      return page(
        paragraph.notes
          .slice(args.offset, args.offset + pageSize + 1)
          .map((note) => display(note, actor)),
        args.offset,
      );
    }
    return {
      ...summary(book, actor),
      revision: book.paragraphs.length,
      paragraphs: book.paragraphs.map(({ notes, ...entry }) => ({
        ...display(entry, actor),
        noteCount: notes.length,
      })),
      endings:
        book.publishedAt === null
          ? book.endings.map((ending) => display(ending, actor))
          : [],
    };
  }
  perform(actor, args, now) {
    if (!("requestId" in args)) return this.read(actor, args);
    const digest = createHash("sha256")
      .update(JSON.stringify(args))
      .digest("hex");
    return this.memory.transaction(() => {
      const prior = this.db
        .prepare(
          "SELECT digest,receipt FROM story_requests WHERE actor=? AND request_id=?",
        )
        .get(actor.key, args.requestId);
      if (prior) {
        if (prior.digest !== digest) throw Error("STORY_REQUEST_CONFLICT");
        return JSON.parse(prior.receipt);
      }
      let book, entry;
      if (args.kind === "open") {
        entry = { ...authored(actor, args.text, now), notes: [] };
        book = {
          id: randomUUID(),
          title: args.title,
          owner: actor,
          updatedAt: now,
          publishedAt: null,
          synopsis: "",
          paragraphs: [entry],
          endings: [],
        };
      } else {
        book = this.book(args.bookId);
        entry = this.change(book, actor, args, now);
      }
      this.db
        .prepare(
          `
        INSERT INTO story_books(id,shelf,updated_at,search_text,document) VALUES(?,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET shelf=excluded.shelf,
          updated_at=excluded.updated_at, search_text=excluded.search_text, document=excluded.document
      `,
        )
        .run(
          book.id,
          book.publishedAt === null ? "writing" : "library",
          book.updatedAt,
          [book.title, ...authors(book)].join("\n").toLowerCase(),
          JSON.stringify(book),
        );
      const receipt = {
        bookId: book.id,
        id: entry.id,
        revision: book.paragraphs.length,
      };
      this.db
        .prepare(
          "INSERT INTO story_requests(actor,request_id,digest,receipt) VALUES(?,?,?,?)",
        )
        .run(actor.key, args.requestId, digest, JSON.stringify(receipt));
      return receipt;
    });
  }
  change(book, actor, args, now) {
    if ("paragraphId" in args) return this.annotate(book, actor, args, now);
    if (book.publishedAt !== null) throw Error("STORY_PUBLISHED");
    if (args.revision !== book.paragraphs.length)
      throw Error("STORY_REVISION_CONFLICT");
    book.updatedAt = now;
    if (args.kind === "append") {
      if (book.paragraphs.length >= paragraphLimit)
        throw Error("STORY_LENGTH_LIMIT");
      const entry = { ...authored(actor, args.text, now), notes: [] };
      book.paragraphs.push(entry);
      return entry;
    }
    if (args.kind === "ending") {
      const entry = {
        ...authored(actor, args.text, now),
        revision: args.revision,
      };
      // Keep the latest choice from each author, with a new ID for concurrent review.
      book.endings = book.endings.filter(
        ({ author }) => author.key !== actor.key,
      );
      book.endings.push(entry);
      return entry;
    }
    if (book.owner.key !== actor.key) throw Error("STORY_WRITE_DENIED");
    const ending = find(book.endings, args.endingId);
    book.title = args.title;
    book.synopsis = args.synopsis;
    book.publishedAt = now;
    book.paragraphs.push({
      id: ending.id,
      author: ending.author,
      text: ending.text,
      at: ending.at,
      notes: [],
    });
    book.endings = [];
    return ending;
  }
  annotate(book, actor, args, now) {
    const paragraph = find(book.paragraphs, args.paragraphId);
    if (args.kind === "annotate") {
      if (paragraph.author.key === actor.key) throw Error("STORY_WRITE_DENIED");
      const entry = { ...authored(actor, args.text, now), revision: 1 };
      paragraph.notes.push(entry);
      if (book.publishedAt === null) book.updatedAt = now;
      return entry;
    }
    const entry = find(paragraph.notes, args.noteId);
    if (entry.author.key !== actor.key) throw Error("STORY_WRITE_DENIED");
    if (entry.revision !== args.revision)
      throw Error("STORY_REVISION_CONFLICT");
    if (args.kind === "withdraw_note")
      paragraph.notes = paragraph.notes.filter(({ id }) => id !== entry.id);
    else {
      entry.text = args.text;
      entry.revision++;
    }
    if (book.publishedAt === null) book.updatedAt = now;
    return entry;
  }
}
