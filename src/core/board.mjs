// @ts-check
import { randomUUID } from "node:crypto";

// The dorm board is the one space every agent and the administrator share.
// Entries are what an author chose to post; nothing is copied in from chats,
// diaries or Self. It lives beside per-agent memory in the same database, so
// full SQLite backups carry it, but a per-agent export does not: the board is
// not any single agent's memory.

export const BOARD_TOOLS = Object.freeze([
  "board_read",
  "board_post",
  "board_comment",
]);
export const BOARD_LIMITS = Object.freeze({
  title: 60,
  post: 2000,
  comment: 1000,
  excerpt: 120,
  page: 20,
});
export const ADMIN_AUTHOR = Object.freeze({ kind: "admin", id: "admin" });

/** @typedef {{kind: "agent" | "admin", id: string}} Author */

/** Calendar day of an instant in the board's timezone, as YYYY-MM-DD.
 * @param {number} ms @param {string} timeZone */
export function boardDay(ms, timeZone) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(ms);
}

/** @param {any} row */
function entry(row) {
  return {
    id: row.id,
    seq: row.seq,
    kind: row.post_id ? "comment" : "post",
    ...(row.post_id ? { postId: row.post_id } : {}),
    ...(row.reply_to ? { replyTo: row.reply_to } : {}),
    author: { kind: row.author_kind, id: row.author_id },
    ...(row.post_id ? {} : { title: row.title }),
    body: row.removed_at ? "" : row.body,
    createdAt: row.created_at,
    ...(row.removed_at ? { removedAt: row.removed_at } : {}),
  };
}

export class Board {
  /** @param {import("node:sqlite").DatabaseSync} db */
  constructor(db) {
    this.db = db;
  }
  /** @param {string} id */
  get(id) {
    return this.db.prepare("SELECT * FROM board_entries WHERE id=?").get(id);
  }
  /** Posts and comments an author wrote on one day, removed ones included,
   * so deleting does not refill the quota.
   * @param {Author} author @param {string} day */
  usage(author, day) {
    const rows = /** @type {any[]} */ (
      this.db
        .prepare(
          "SELECT post_id IS NULL AS post,count(*) AS n FROM board_entries WHERE author_kind=? AND author_id=? AND day=? GROUP BY post_id IS NULL",
        )
        .all(author.kind, author.id, day)
    );
    return {
      posts: rows.find((r) => r.post)?.n || 0,
      comments: rows.find((r) => !r.post)?.n || 0,
    };
  }
  /**
   * @param {{author: Author, title?: string, body: string, postId?: string,
   *   replyTo?: string, requestId?: string, now: number, timeZone: string,
   *   limit?: number}} input
   */
  write(input) {
    const { author, postId, replyTo, requestId, now, timeZone } = input;
    const title = postId ? "" : String(input.title || "").trim(),
      body = String(input.body || "").trim();
    if (
      (!postId &&
        (!title || [...title].length > BOARD_LIMITS.title || replyTo)) ||
      !body ||
      [...body].length > (postId ? BOARD_LIMITS.comment : BOARD_LIMITS.post)
    )
      throw Error("BOARD_ENTRY_INVALID");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      // A retried call with the same requestId returns the first result; the
      // same id with different content is a caller error, not a new entry.
      if (requestId) {
        const old = /** @type {any} */ (
          this.db
            .prepare(
              "SELECT * FROM board_entries WHERE author_kind=? AND author_id=? AND request_id=?",
            )
            .get(author.kind, author.id, requestId)
        );
        if (old) {
          if (
            (old.post_id || null) !== (postId || null) ||
            (old.reply_to || null) !== (replyTo || null) ||
            old.title !== title ||
            old.body !== body
          )
            throw Error("BOARD_REQUEST_CONFLICT");
          this.db.exec("COMMIT");
          return { ...entry(old), duplicate: true };
        }
      }
      if (postId) {
        const post = /** @type {any} */ (this.get(postId));
        if (!post || post.post_id || post.removed_at)
          throw Error("BOARD_POST_NOT_FOUND");
        if (replyTo) {
          const target = /** @type {any} */ (this.get(replyTo));
          if (!target || target.post_id !== postId || target.removed_at)
            throw Error("BOARD_COMMENT_NOT_FOUND");
        }
      }
      const day = boardDay(now, timeZone);
      if (input.limit !== undefined) {
        const used = this.usage(author, day);
        if ((postId ? used.comments : used.posts) >= input.limit)
          throw Error(
            postId
              ? "BOARD_COMMENT_QUOTA_EXCEEDED"
              : "BOARD_POST_QUOTA_EXCEEDED",
          );
      }
      const id = randomUUID();
      this.db
        .prepare(
          "INSERT INTO board_entries(id,post_id,reply_to,author_kind,author_id,request_id,title,body,day,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
        )
        .run(
          id,
          postId || null,
          replyTo || null,
          author.kind,
          author.id,
          requestId || null,
          title,
          body,
          day,
          new Date(now).toISOString(),
        );
      const row = this.get(id);
      this.db.exec("COMMIT");
      return entry(row);
    } catch (error) {
      if (this.db.isTransaction) this.db.exec("ROLLBACK");
      throw error;
    }
  }
  /** Posts by latest activity, with comment counts. Removed posts only for
   * the administrator.
   * @param {{offset?: number, limit?: number, includeRemoved?: boolean}} [options] */
  posts({ offset = 0, limit = 10, includeRemoved = false } = {}) {
    const where = includeRemoved
      ? "p.post_id IS NULL"
      : "p.post_id IS NULL AND p.removed_at IS NULL";
    const rows = /** @type {any[]} */ (
      this.db
        .prepare(
          `SELECT p.*,(SELECT count(*) FROM board_entries c WHERE c.post_id=p.id AND c.removed_at IS NULL) AS comments,(SELECT max(c.seq) FROM board_entries c WHERE c.post_id=p.id) AS last_seq,(SELECT c.created_at FROM board_entries c WHERE c.post_id=p.id ORDER BY c.seq DESC LIMIT 1) AS last_at FROM board_entries p WHERE ${where} ORDER BY max(p.seq,coalesce(last_seq,0)) DESC LIMIT ? OFFSET ?`,
        )
        .all(limit, offset)
    );
    const total = /** @type {any} */ (
      this.db
        .prepare(`SELECT count(*) AS n FROM board_entries p WHERE ${where}`)
        .get()
    ).n;
    return {
      items: rows.map((row) => ({
        ...entry(row),
        comments: row.comments,
        lastActivityAt: row.last_at || row.created_at,
      })),
      total,
      nextOffset: offset + rows.length < total ? offset + rows.length : null,
    };
  }
  /** One post and a page of its comments in order.
   * @param {string} postId
   * @param {{offset?: number, limit?: number, includeRemoved?: boolean}} [options] */
  thread(postId, { offset = 0, limit = 20, includeRemoved = false } = {}) {
    const post = /** @type {any} */ (this.get(postId));
    if (!post || post.post_id || (post.removed_at && !includeRemoved))
      throw Error("BOARD_POST_NOT_FOUND");
    const filter = includeRemoved ? "" : " AND removed_at IS NULL";
    const rows = /** @type {any[]} */ (
      this.db
        .prepare(
          `SELECT * FROM board_entries WHERE post_id=?${filter} ORDER BY seq LIMIT ? OFFSET ?`,
        )
        .all(postId, limit, offset)
    );
    const total = /** @type {any} */ (
      this.db
        .prepare(
          `SELECT count(*) AS n FROM board_entries WHERE post_id=?${filter}`,
        )
        .get(postId)
    ).n;
    return {
      post: entry(post),
      comments: rows.map(entry),
      total,
      nextOffset: offset + rows.length < total ? offset + rows.length : null,
    };
  }
  /** Entries newer than what this agent last read, oldest first. Reading
   * advances the agent's own marker to the last entry returned only.
   * @param {string} agentId @param {{limit?: number}} [options] */
  unread(agentId, { limit = 10 } = {}) {
    const marker =
      /** @type {any} */ (
        this.db
          .prepare("SELECT seq FROM board_reads WHERE agent_id=?")
          .get(agentId)
      )?.seq || 0;
    // One's own entries are not news to oneself; skipping them still moves
    // the marker past them once a later entry is read.
    const visible =
      "e.seq>? AND e.removed_at IS NULL AND (e.post_id IS NULL OR p.removed_at IS NULL) AND NOT (e.author_kind='agent' AND e.author_id=?)";
    const rows = /** @type {any[]} */ (
      this.db
        .prepare(
          `SELECT e.*,p.title AS post_title FROM board_entries e LEFT JOIN board_entries p ON p.id=e.post_id WHERE ${visible} ORDER BY e.seq LIMIT ?`,
        )
        .all(marker, agentId, limit)
    );
    const remaining = /** @type {any} */ (
      this.db
        .prepare(
          `SELECT count(*) AS n FROM board_entries e LEFT JOIN board_entries p ON p.id=e.post_id WHERE ${visible}`,
        )
        .get(marker, agentId)
    ).n;
    const last = rows.at(-1)?.seq;
    if (last)
      this.db
        .prepare(
          "INSERT INTO board_reads(agent_id,seq) VALUES(?,?) ON CONFLICT(agent_id) DO UPDATE SET seq=max(seq,excluded.seq)",
        )
        .run(agentId, last);
    return {
      items: rows.map((row) => ({
        ...entry(row),
        ...(row.post_id ? { postTitle: row.post_title } : {}),
      })),
      remaining: remaining - rows.length,
    };
  }
  /** Administrator moderation: the row stays so ids and quotas hold, the
   * text is no longer shown.
   * @param {string} id @param {number} now */
  remove(id, now) {
    const row = /** @type {any} */ (this.get(id));
    if (!row) throw Error("BOARD_ENTRY_NOT_FOUND");
    if (!row.removed_at)
      this.db
        .prepare("UPDATE board_entries SET removed_at=? WHERE id=?")
        .run(new Date(now).toISOString(), id);
    return entry(this.get(id));
  }
}
