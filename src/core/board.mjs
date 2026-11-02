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
  mentions: 5,
  query: 50,
});
export const BOARD_SORTS = Object.freeze(["activity", "newest", "comments"]);
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

/** @param {Author} a */
const actorKey = (a) => `${a.kind}:${a.id}`;

/** @param {any} row @param {Author[]} [mentions] */
function entry(row, mentions = []) {
  return {
    id: row.id,
    seq: row.seq,
    kind: row.post_id ? "comment" : "post",
    ...(row.post_id ? { postId: row.post_id } : {}),
    ...(row.reply_to ? { replyTo: row.reply_to } : {}),
    author: { kind: row.author_kind, id: row.author_id },
    ...(row.post_id ? {} : { title: row.title }),
    body: row.removed_at ? "" : row.body,
    ...(mentions.length && !row.removed_at ? { mentions } : {}),
    createdAt: row.created_at,
    ...(row.pinned_at ? { pinnedAt: row.pinned_at } : {}),
    ...(row.removed_at ? { removedAt: row.removed_at } : {}),
  };
}

/** Escape LIKE wildcards so a search for "50%" means the text itself.
 * @param {string} text */
const like = (text) => `%${text.replace(/[\\%_]/g, "\\$&")}%`;

export class Board {
  /** @param {import("node:sqlite").DatabaseSync} db */
  constructor(db) {
    this.db = db;
  }
  /** @param {string} id */
  get(id) {
    return this.db
      .prepare(
        "SELECT e.*,pin.pinned_at FROM board_entries e LEFT JOIN board_pins pin ON pin.post_id=e.id WHERE e.id=?",
      )
      .get(id);
  }
  /** Mentions of many entries in one query, keyed by seq.
   * @param {any[]} rows @returns {Map<number, Author[]>} */
  mentionsOf(rows) {
    const map = new Map();
    if (!rows.length) return map;
    const found = /** @type {any[]} */ (
      this.db
        .prepare(
          `SELECT entry_seq,target_kind,target_id FROM board_mentions WHERE entry_seq IN (${rows.map(() => "?").join(",")}) ORDER BY rowid`,
        )
        .all(...rows.map((r) => r.seq))
    );
    for (const m of found)
      map.set(m.entry_seq, [
        ...(map.get(m.entry_seq) || []),
        { kind: m.target_kind, id: m.target_id },
      ]);
    return map;
  }
  /** @param {any[]} rows */
  entries(rows) {
    const mentions = this.mentionsOf(rows);
    return rows.map((row) => entry(row, mentions.get(row.seq)));
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
   * Mentions are already resolved to existing actors by the caller, which
   * knows the configured agents; here they are only deduplicated, and an
   * author mentioning themselves is dropped.
   * @param {{author: Author, title?: string, body: string, postId?: string,
   *   replyTo?: string, requestId?: string, mentions?: Author[], now: number,
   *   timeZone: string, limit?: number}} input
   */
  write(input) {
    const { author, postId, replyTo, requestId, now, timeZone } = input;
    const title = postId ? "" : String(input.title || "").trim(),
      body = String(input.body || "").trim();
    const mentions = [
      ...new Map(
        (input.mentions || [])
          .filter((m) => actorKey(m) !== actorKey(author))
          .map((m) => [actorKey(m), { kind: m.kind, id: m.id }]),
      ).values(),
    ];
    if (
      (!postId &&
        (!title || [...title].length > BOARD_LIMITS.title || replyTo)) ||
      !body ||
      [...body].length > (postId ? BOARD_LIMITS.comment : BOARD_LIMITS.post) ||
      mentions.length > BOARD_LIMITS.mentions
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
          const before = (this.mentionsOf([old]).get(old.seq) || [])
            .map(actorKey)
            .sort();
          if (
            (old.post_id || null) !== (postId || null) ||
            (old.reply_to || null) !== (replyTo || null) ||
            old.title !== title ||
            old.body !== body ||
            before.join() !== mentions.map(actorKey).sort().join()
          )
            throw Error("BOARD_REQUEST_CONFLICT");
          this.db.exec("COMMIT");
          return { ...this.entries([this.get(old.id)])[0], duplicate: true };
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
      const { lastInsertRowid } = this.db
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
      const mention = this.db.prepare(
        "INSERT INTO board_mentions(entry_seq,target_kind,target_id) VALUES(?,?,?)",
      );
      for (const m of mentions) mention.run(lastInsertRowid, m.kind, m.id);
      const row = this.get(id);
      this.db.exec("COMMIT");
      return this.entries([row])[0];
    } catch (error) {
      if (this.db.isTransaction) this.db.exec("ROLLBACK");
      throw error;
    }
  }
  /** Posts with comment counts, pinned ones first. Filters combine: written
   * by an author, mentioning someone anywhere in the thread, or containing a
   * text in the title, body or a comment. Removed posts only for the
   * administrator, and removed text is never searched.
   * @param {{offset?: number, limit?: number, includeRemoved?: boolean,
   *   author?: Author, mention?: Author, query?: string,
   *   sort?: string}} [options] */
  posts({
    offset = 0,
    limit = 10,
    includeRemoved = false,
    author,
    mention,
    query,
    sort = "activity",
  } = {}) {
    const where = ["p.post_id IS NULL"],
      /** @type {(string | number)[]} */ params = [];
    if (!includeRemoved) where.push("p.removed_at IS NULL");
    if (author) {
      where.push("p.author_kind=? AND p.author_id=?");
      params.push(author.kind, author.id);
    }
    if (mention) {
      where.push(
        "EXISTS(SELECT 1 FROM board_mentions m JOIN board_entries c ON c.seq=m.entry_seq WHERE (c.id=p.id OR c.post_id=p.id) AND c.removed_at IS NULL AND m.target_kind=? AND m.target_id=?)",
      );
      params.push(mention.kind, mention.id);
    }
    const text = String(query || "").trim();
    if (text) {
      where.push(
        "(p.title LIKE ? ESCAPE '\\' OR (p.removed_at IS NULL AND p.body LIKE ? ESCAPE '\\') OR EXISTS(SELECT 1 FROM board_entries c WHERE c.post_id=p.id AND c.removed_at IS NULL AND c.body LIKE ? ESCAPE '\\'))",
      );
      params.push(like(text), like(text), like(text));
    }
    const order = {
      activity: "max(p.seq,coalesce(last_seq,0)) DESC",
      newest: "p.seq DESC",
      comments: "comments DESC,p.seq DESC",
    }[sort];
    if (!order) throw Error("BOARD_ENTRY_INVALID");
    const filter = where.join(" AND ");
    const rows = /** @type {any[]} */ (
      this.db
        .prepare(
          `SELECT p.*,pin.pinned_at,(SELECT count(*) FROM board_entries c WHERE c.post_id=p.id AND c.removed_at IS NULL) AS comments,(SELECT max(c.seq) FROM board_entries c WHERE c.post_id=p.id) AS last_seq,(SELECT c.created_at FROM board_entries c WHERE c.post_id=p.id ORDER BY c.seq DESC LIMIT 1) AS last_at FROM board_entries p LEFT JOIN board_pins pin ON pin.post_id=p.id WHERE ${filter} ORDER BY pin.pinned_at IS NULL,pin.pinned_at DESC,${order} LIMIT ? OFFSET ?`,
        )
        .all(...params, limit, offset)
    );
    const total = /** @type {any} */ (
      this.db
        .prepare(`SELECT count(*) AS n FROM board_entries p WHERE ${filter}`)
        .get(...params)
    ).n;
    const items = this.entries(rows);
    return {
      items: items.map((item, i) => ({
        ...item,
        comments: rows[i].comments,
        lastActivityAt: rows[i].last_at || rows[i].created_at,
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
      post: this.entries([post])[0],
      comments: this.entries(rows),
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
    const items = this.entries(rows);
    return {
      items: items.map((item, i) => ({
        ...item,
        ...(rows[i].post_id ? { postTitle: rows[i].post_title } : {}),
      })),
      remaining: remaining - rows.length,
    };
  }
  /** Live entries that mention someone, newest first. Looking them up moves
   * no marker, unlike unread().
   * @param {Author} target @param {{offset?: number, limit?: number}} [options] */
  mentioning(target, { offset = 0, limit = 10 } = {}) {
    const from =
      "FROM board_mentions m JOIN board_entries e ON e.seq=m.entry_seq LEFT JOIN board_entries p ON p.id=e.post_id WHERE m.target_kind=? AND m.target_id=? AND e.removed_at IS NULL AND (e.post_id IS NULL OR p.removed_at IS NULL)";
    const rows = /** @type {any[]} */ (
      this.db
        .prepare(
          `SELECT e.*,p.title AS post_title ${from} ORDER BY e.seq DESC LIMIT ? OFFSET ?`,
        )
        .all(target.kind, target.id, limit, offset)
    );
    const counts = /** @type {any} */ (
      this.db
        .prepare(`SELECT count(*) AS n,max(e.seq) AS latest ${from}`)
        .get(target.kind, target.id)
    );
    const items = this.entries(rows);
    return {
      items: items.map((item, i) => ({
        ...item,
        ...(rows[i].post_id ? { postTitle: rows[i].post_title } : {}),
      })),
      total: counts.n,
      latestSeq: counts.latest || 0,
      nextOffset: offset + rows.length < counts.n ? offset + rows.length : null,
    };
  }
  /** Administrator pinning keeps a post at the top of every listing.
   * @param {string} postId @param {boolean} pinned @param {number} now */
  pin(postId, pinned, now) {
    const post = /** @type {any} */ (this.get(postId));
    if (!post || post.post_id || (pinned && post.removed_at))
      throw Error("BOARD_POST_NOT_FOUND");
    if (!pinned)
      this.db.prepare("DELETE FROM board_pins WHERE post_id=?").run(postId);
    else if (!post.pinned_at)
      this.db
        .prepare("INSERT INTO board_pins(post_id,pinned_at) VALUES(?,?)")
        .run(postId, new Date(now).toISOString());
    return this.entries([this.get(postId)])[0];
  }
  /** Administrator moderation: the row stays so ids and quotas hold, the
   * text is no longer shown and a removed post is no longer pinned.
   * @param {string} id @param {number} now */
  remove(id, now) {
    const row = /** @type {any} */ (this.get(id));
    if (!row) throw Error("BOARD_ENTRY_NOT_FOUND");
    if (!row.removed_at) {
      this.db
        .prepare("UPDATE board_entries SET removed_at=? WHERE id=?")
        .run(new Date(now).toISOString(), id);
      this.db.prepare("DELETE FROM board_pins WHERE post_id=?").run(id);
    }
    return this.entries([this.get(id)])[0];
  }
}
