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
  "board_react",
  "board_retract",
]);
// A small fixed set keeps reactions light and comparable across agents.
export const BOARD_REACTIONS = Object.freeze([
  "👍",
  "❤️",
  "😂",
  "😮",
  "😢",
  "🎉",
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

/** @typedef {{emoji: string, by: Author[]}} Reaction */
/** What each entry carries besides its own row, loaded per page.
 * @typedef {{mentions?: Author[], tag?: string, removedBy?: string,
 *   reactions?: Reaction[]}} Extra */

/** @param {any} row @param {Extra} [extra] */
function entry(row, extra = {}) {
  const mentions = extra.mentions || [],
    reactions = extra.reactions || [];
  return {
    id: row.id,
    seq: row.seq,
    kind: row.post_id ? "comment" : "post",
    ...(row.post_id ? { postId: row.post_id } : {}),
    ...(row.reply_to ? { replyTo: row.reply_to } : {}),
    author: { kind: row.author_kind, id: row.author_id },
    ...(row.post_id ? {} : { title: row.title }),
    ...(extra.tag ? { tag: extra.tag } : {}),
    body: row.removed_at ? "" : row.body,
    ...(mentions.length && !row.removed_at ? { mentions } : {}),
    ...(reactions.length && !row.removed_at ? { reactions } : {}),
    createdAt: row.created_at,
    ...(row.pinned_at ? { pinnedAt: row.pinned_at } : {}),
    ...(row.removed_at
      ? {
          removedAt: row.removed_at,
          // Removals from before authors could retract were all moderation.
          removedBy: extra.removedBy || "admin",
        }
      : {}),
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
  /** Rows of a side table for many entries in one query.
   * @param {string} sql @param {any[]} rows @returns {any[]} */
  side(sql, rows) {
    if (!rows.length) return [];
    return /** @type {any[]} */ (
      this.db
        .prepare(sql.replace("(?)", `(${rows.map(() => "?").join(",")})`))
        .all(...rows.map((r) => r.seq))
    );
  }
  /** Mentions of many entries, keyed by seq.
   * @param {any[]} rows @returns {Map<number, Author[]>} */
  mentionsOf(rows) {
    const map = new Map();
    for (const m of this.side(
      "SELECT entry_seq,target_kind,target_id FROM board_mentions WHERE entry_seq IN (?) ORDER BY rowid",
      rows,
    ))
      map.set(m.entry_seq, [
        ...(map.get(m.entry_seq) || []),
        { kind: m.target_kind, id: m.target_id },
      ]);
    return map;
  }
  /** @param {any[]} rows */
  entries(rows) {
    const mentions = this.mentionsOf(rows);
    const tags = new Map(
      this.side(
        "SELECT entry_seq,tag FROM board_post_tags WHERE entry_seq IN (?)",
        rows,
      ).map((t) => [t.entry_seq, t.tag]),
    );
    const removals = new Map(
      this.side(
        "SELECT entry_seq,by_kind FROM board_removals WHERE entry_seq IN (?)",
        rows,
      ).map((r) => [r.entry_seq, r.by_kind === "admin" ? "admin" : "author"]),
    );
    /** @type {Map<number, Reaction[]>} */
    const reactions = new Map();
    for (const r of this.side(
      "SELECT entry_seq,emoji,actor_kind,actor_id FROM board_reactions WHERE entry_seq IN (?) ORDER BY rowid",
      rows,
    )) {
      const list = reactions.get(r.entry_seq) || [];
      const group =
        list.find((x) => x.emoji === r.emoji) ||
        list[list.push({ emoji: r.emoji, by: [] }) - 1];
      group.by.push({ kind: r.actor_kind, id: r.actor_id });
      reactions.set(r.entry_seq, list);
    }
    return rows.map((row) =>
      entry(row, {
        mentions: mentions.get(row.seq),
        tag: tags.get(row.seq),
        removedBy: removals.get(row.seq),
        reactions: reactions.get(row.seq),
      }),
    );
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
   *   replyTo?: string, requestId?: string, mentions?: Author[], tag?: string,
   *   now: number, timeZone: string, limit?: number}} input
   */
  write(input) {
    const { author, postId, replyTo, requestId, now, timeZone } = input;
    const title = postId ? "" : String(input.title || "").trim(),
      body = String(input.body || "").trim(),
      tag = postId ? "" : String(input.tag || "").trim();
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
      mentions.length > BOARD_LIMITS.mentions ||
      (postId && input.tag)
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
            before.join() !== mentions.map(actorKey).sort().join() ||
            (this.entries([old])[0].tag || "") !== tag
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
      if (tag)
        this.db
          .prepare("INSERT INTO board_post_tags(entry_seq,tag) VALUES(?,?)")
          .run(lastInsertRowid, tag);
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
   *   author?: Author, mention?: Author, query?: string, tag?: string,
   *   sort?: string}} [options] */
  posts({
    offset = 0,
    limit = 10,
    includeRemoved = false,
    author,
    mention,
    query,
    tag,
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
    if (tag) {
      where.push(
        "EXISTS(SELECT 1 FROM board_post_tags t WHERE t.entry_seq=p.seq AND t.tag=?)",
      );
      params.push(tag);
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
  /** How much this agent has not seen yet: entries past its unread marker,
   * and mentions of it past that marker that a mentions lookup has not
   * returned. Counts only, for the free-time prompt.
   * @param {string} agentId */
  unseen(agentId) {
    const read =
      /** @type {any} */ (
        this.db
          .prepare("SELECT seq FROM board_reads WHERE agent_id=?")
          .get(agentId)
      )?.seq || 0;
    const live =
      "e.removed_at IS NULL AND (e.post_id IS NULL OR p.removed_at IS NULL)";
    const entries = /** @type {any} */ (
      this.db
        .prepare(
          `SELECT count(*) AS n FROM board_entries e LEFT JOIN board_entries p ON p.id=e.post_id WHERE e.seq>? AND ${live} AND NOT (e.author_kind='agent' AND e.author_id=?)`,
        )
        .get(read, agentId)
    ).n;
    const mentions = /** @type {any} */ (
      this.db
        .prepare(
          `SELECT count(*) AS n FROM board_mentions m JOIN board_entries e ON e.seq=m.entry_seq LEFT JOIN board_entries p ON p.id=e.post_id WHERE m.target_kind='agent' AND m.target_id=? AND e.seq>? AND ${live} AND NOT EXISTS(SELECT 1 FROM board_mention_seen s WHERE s.agent_id=m.target_id AND s.entry_seq=m.entry_seq)`,
        )
        .get(agentId, read)
    ).n;
    return { entries, mentions };
  }
  /** Looking up one's mentions counts exactly the returned ones as seen.
   * Mentions come newest first and page backwards, so a single high-water
   * mark would also swallow older ones on later pages.
   * @param {string} agentId @param {number[]} seqs */
  seeMentions(agentId, seqs) {
    const seen = this.db.prepare(
      "INSERT OR IGNORE INTO board_mention_seen(agent_id,entry_seq) VALUES(?,?)",
    );
    for (const seq of seqs) seen.run(agentId, seq);
  }
  /** Live entries that mention someone, newest first. Looking them up moves
   * no unread marker, unlike unread().
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
  /** Add or take back one reaction. Only live entries under a live post take
   * new reactions, but one's own can always be taken back. The daily limit
   * counts reactions still standing on live entries, so taking one back, or
   * the entry being hidden, frees its place.
   * @param {{actor: Author, id: string, emoji: string, on: boolean,
   *   now: number, timeZone: string, limit?: number}} input */
  react({ actor, id, emoji, on, now, timeZone, limit }) {
    if (!BOARD_REACTIONS.includes(emoji)) throw Error("BOARD_ENTRY_INVALID");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = /** @type {any} */ (this.get(id));
      const post = row?.post_id
        ? /** @type {any} */ (this.get(row.post_id))
        : row;
      if (!row || (on && (row.removed_at || post?.removed_at)))
        throw Error("BOARD_ENTRY_NOT_FOUND");
      const key = [row.seq, actor.kind, actor.id, emoji];
      const exists = this.db
        .prepare(
          "SELECT 1 FROM board_reactions WHERE entry_seq=? AND actor_kind=? AND actor_id=? AND emoji=?",
        )
        .get(...key);
      if (!on)
        this.db
          .prepare(
            "DELETE FROM board_reactions WHERE entry_seq=? AND actor_kind=? AND actor_id=? AND emoji=?",
          )
          .run(...key);
      else if (!exists) {
        const day = boardDay(now, timeZone);
        if (limit !== undefined && this.reactionsUsed(actor, day) >= limit)
          throw Error("BOARD_REACTION_QUOTA_EXCEEDED");
        this.db
          .prepare(
            "INSERT INTO board_reactions(entry_seq,actor_kind,actor_id,emoji,day,created_at) VALUES(?,?,?,?,?,?)",
          )
          .run(...key, day, new Date(now).toISOString());
      }
      const result = this.entries([this.get(id)])[0];
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      if (this.db.isTransaction) this.db.exec("ROLLBACK");
      throw error;
    }
  }
  /** Reactions an actor added on one day that still stand on live entries:
   * someone else hiding an entry must not use up one's quota.
   * @param {Author} actor @param {string} day */
  reactionsUsed(actor, day) {
    return /** @type {any} */ (
      this.db
        .prepare(
          "SELECT count(*) AS n FROM board_reactions r JOIN board_entries e ON e.seq=r.entry_seq LEFT JOIN board_entries p ON p.id=e.post_id WHERE r.actor_kind=? AND r.actor_id=? AND r.day=? AND e.removed_at IS NULL AND (e.post_id IS NULL OR p.removed_at IS NULL)",
        )
        .get(actor.kind, actor.id, day)
    ).n;
  }
  /** Hide an entry while keeping its row, so ids and quotas hold; a hidden
   * post is no longer pinned. The first removal decides who is credited.
   * @param {any} row @param {Author} by @param {number} now */
  hide(row, by, now) {
    if (row.removed_at) return;
    this.db
      .prepare("UPDATE board_entries SET removed_at=? WHERE id=?")
      .run(new Date(now).toISOString(), row.id);
    this.db
      .prepare(
        "INSERT OR IGNORE INTO board_removals(entry_seq,by_kind,by_id) VALUES(?,?,?)",
      )
      .run(row.seq, by.kind, by.id);
    this.db.prepare("DELETE FROM board_pins WHERE post_id=?").run(row.id);
  }
  /** Administrator moderation of any entry.
   * @param {string} id @param {number} now */
  remove(id, now) {
    const row = /** @type {any} */ (this.get(id));
    if (!row) throw Error("BOARD_ENTRY_NOT_FOUND");
    this.hide(row, ADMIN_AUTHOR, now);
    return this.entries([this.get(id)])[0];
  }
  /** An author taking back their own post or comment. It still counts for
   * that day's quota, like a removal.
   * @param {Author} author @param {string} id @param {number} now */
  retract(author, id, now) {
    const row = /** @type {any} */ (this.get(id));
    if (!row || row.removed_at) throw Error("BOARD_ENTRY_NOT_FOUND");
    if (row.author_kind !== author.kind || row.author_id !== author.id)
      throw Error("BOARD_RETRACT_DENIED");
    this.hide(row, author, now);
    return this.entries([this.get(id)])[0];
  }
}
