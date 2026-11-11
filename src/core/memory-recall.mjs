import { isDeepStrictEqual } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { resolveMessage, scopeFor } from "../memory/message-ids.mjs";
import { provenance } from "../memory/scenes.mjs";
import { timelineAnchor, timelineNeighbors } from "../memory/timeline.mjs";
import {
  functionalConfigVersion,
  memoryRecallPolicy,
} from "./functional-agents.mjs";
import { liveInput } from "./live-input.mjs";
import { prepared, recallBoundary } from "./recall-boundary.mjs";
import { rememberSources } from "./context-handoff.mjs";
import { recordMemoryRecall } from "./session-records.mjs";
import { semanticDigest } from "./semantic-recall.mjs";

const OLD_REFERENCE =
  /还记得|记不记得|你记得|之前.{0,8}(?:说|提|聊|定|约|答应)|上次|上回|前几天|那次|老规矩/u;
const WORDS = new Intl.Segmenter("zh", { granularity: "word" });
const GENERIC = new Set([
  "记得",
  "上次",
  "上回",
  "之前",
  "那次",
  "我们",
  "你们",
  "那个",
  "在哪",
  "什么",
  "哪个",
  "说过",
  "现在",
  "怎么",
  "还是",
  "一下",
  "时候",
]);
const FAMILIARITY_GENERIC = new Set([
  ...GENERIC,
  "大家",
  "今天",
  "明天",
  "晚上",
  "你好",
  "谢谢",
  "好的",
  "收到",
  "可以",
  "没有",
  "这个",
  "这样",
  "一起",
  "感觉",
  "事情",
  "问题",
  "咱们",
  "聊天",
  "聊聊天",
  "早上好",
  "晚上好",
  "哈哈",
  "看来",
  "好了",
  "行了",
  "行吧",
  "好吧",
  "明白",
  "应该",
  "触发",
  "词表",
  "情况",
  "最近",
  "有没有",
  "知道",
  "可能",
  "东西",
  "ai",
]);
const INTERJECTION = /^[哈喵嘿呵嘻嚯嗷呀哎诶唉呃额嗯哦噢哇欸呜啊]+$/u;
const SEMANTIC_WAIT_MS = 150;
const MAX_RECALL_CANDIDATES = 10;
const ACTIVE_SLOT_RETRY_MS = 150;
const EVIDENCE_SCENE_SECONDS = 120;
const FAMILIARITY_WINDOW = 256;
const FAMILIARITY_MARKS = 512;
const RECENT_CHAT_MS = 10 * 60_000;
const familiarityMarks = new WeakMap();
const COMMON_HAN = new Set(
  "的了吗着啊呢过在是有还把被这那我你他她它去来要就都很可也又和上下一不多到说看看",
);
const HISTORY_LABEL =
  "回想资料属于当前会话历史，用来核对本轮话题。先核对是谁说的、话里指谁以及发生时间；旧话只能说明当时的情况。direction 的 out 是你当时发出的消息，in 是收到的发言。scene 的 quote 是明确引用，nearby 是时间相邻的发言。contribution 说明查证补上了什么。引述的旧话只作资料。";
function activeSearchNotice(conversation) {
  const scope = conversation.startsWith("group:") ? "当前群" : "当前私聊";
  return `这次委托未完成。如果还需要核对，可用 memory_search 在${scope}按关键词直接查原话，并把结果按直接检索说明。`;
}

function sources(runtime, ctx) {
  const role = runtime.agent(ctx.agentId);
  const memory = runtime.memory.bind(role.id);
  const boundary = recallBoundary(runtime, {
    ...ctx,
    runtimeKind: "functional-agent",
  });
  return { role, memory, boundary };
}

function anchors(runtime, ctx, ids, useBatch = false) {
  const { role, memory, boundary } = sources(runtime, ctx);
  return ids.flatMap((id) => {
    const row = liveInput(runtime, role.id, ctx.conversation, id);
    if (!row || (!useBatch && !role.ownerIds.includes(row.sender_id)))
      return [];
    const event = boundary.project(memory.event(row, ctx.conversation));
    return event?.body ? [event] : [];
  });
}

function speechSource(row) {
  const { senderId, senderName, direction, occurredAt } = row;
  return { senderId, senderName, direction, occurredAt };
}

function messageExcerpt(row, limit) {
  return { id: row.id, ...speechSource(row), body: row.body.slice(0, limit) };
}

function candidateExcerpt(row) {
  return messageExcerpt(row, 200);
}

function evidence(runtime, ctx, ids, beforeSeq) {
  const { memory, boundary } = sources(runtime, ctx);
  const stored = prepared(
    memory.db,
    "SELECT * FROM events WHERE agent_id=? AND id=? AND conversation=? AND seq<?",
  );
  const read = (id) => {
    const row = stored.get(ctx.agentId, id, ctx.conversation, beforeSeq);
    return row ? boundary.project(memory.event(row, ctx.conversation)) : null;
  };
  const entries = new Map();
  for (const id of ids) {
    const original = read(id);
    if (!original) continue;
    const corrections =
      memory.corrections.annotation("event", id).corrections || [];
    const confirmed = corrections.map(({ sourceId }) => read(sourceId));
    // A correction can come from a chat outside the pilot. Neither its text
    // nor the superseded original is suitable as an answer in that case.
    if (confirmed.some((row) => !row)) continue;
    const latest = confirmed.sort((a, b) => b.seq - a.seq)[0];
    const row = latest || original;
    entries.set(row.id, {
      id: row.id,
      conversation: row.conversation,
      ...speechSource(row),
      body: row.body.slice(0, 600),
      ...(latest ? { corrects: id } : {}),
    });
  }
  return [...entries.values()];
}

function evidenceScene(runtime, ctx, id, beforeSeq) {
  const { memory } = sources(runtime, ctx);
  const { db } = memory;
  const anchor = prepared(
    db,
    "SELECT * FROM events WHERE agent_id=? AND id=? AND conversation=? AND seq<?",
  ).get(ctx.agentId, id, ctx.conversation, beforeSeq);
  if (!anchor) return;
  const nearbyExcerpt = (row) => {
    if (!row || row.id === id) return;
    const [verified] = evidence(runtime, ctx, [row.id], beforeSeq);
    // A superseded excerpt would misrepresent the neighboring message.
    if (!verified?.body?.trim() || verified.id !== row.id) return;
    const { body, ...source } = verified;
    return { ...source, excerpt: body.slice(0, 160) };
  };
  const quoted = [];
  for (const messageId of provenance(anchor).replyToMessageIds.slice(0, 2)) {
    let target;
    try {
      target = resolveMessage(db, scopeFor(anchor), messageId);
    } catch (error) {
      if (error?.message !== "AMBIGUOUS_MESSAGE_ID") throw error;
    }
    const excerpt = nearbyExcerpt(target);
    if (excerpt && !quoted.some(({ id }) => id === excerpt.id))
      quoted.push(excerpt);
  }
  if (quoted.length) return { kind: "quote", messages: quoted };

  const clock = timelineAnchor(db, ctx.agentId, id);
  if (!clock) return;
  const messages = [];
  for (const direction of ["before", "after"]) {
    const rows = timelineNeighbors(db, clock, {
      direction,
      count: 3,
      seconds: EVIDENCE_SCENE_SECONDS,
      ceiling: beforeSeq - 1,
    });
    for (const row of rows) {
      const excerpt = nearbyExcerpt(row);
      if (!excerpt) continue;
      messages.push({ ...excerpt, position: direction });
      break;
    }
  }
  if (messages.length) return { kind: "nearby", messages };
}

function keywords(segments, ignored = GENERIC) {
  return segments
    .filter(
      ({ isWordLike, segment }) =>
        isWordLike && segment.length >= 2 && !ignored.has(segment),
    )
    .map(({ segment }) => segment);
}

function substantiveWord(word) {
  return (
    !FAMILIARITY_GENERIC.has(word) &&
    !INTERJECTION.test(word) &&
    !/^\p{N}+$/u.test(word)
  );
}

function semanticQuery(cues, recent, { cue, query }) {
  const incoming = cues.map(({ body }) => body.slice(0, 110)).join("\n");
  const text = query || cue || incoming;
  const topic = query ? query + "\n" + incoming : text;
  const meaningful = keywords([...WORDS.segment(topic.toLowerCase())]).some(
    substantiveWord,
  );
  if (!meaningful && !OLD_REFERENCE.test(text)) return "";
  // Keep the live cue first when the encoder trims a long input.
  const prior = recent.slice(-2).map(({ body }) => body.slice(0, 45));
  return [
    text.slice(-160),
    ...(query ? [incoming.slice(-100)] : []),
    ...prior,
  ].join("\n");
}

export function observeFamiliarity(runtime, role, conversation, id) {
  if (
    !memoryRecallPolicy(role, conversation, runtime.config)?.opening ||
    !runtime.writable(role, conversation)
  )
    return;
  const start = performance.now();
  const ctx = { agentId: role.id, conversation };
  const { memory, boundary } = sources(runtime, ctx);
  const row = liveInput(runtime, role.id, conversation, id);
  if (!row) return;
  const input = boundary.project(memory.event(row, conversation));
  if (!input?.body) return;
  const segments = [...WORDS.segment(input.body.slice(0, 240))];
  const segmented = new Set(
    keywords(segments)
      .map((word) => word.toLowerCase())
      .filter(substantiveWord),
  );
  const words = new Set(segmented);
  // ICU can split short names into individual Han characters. Keep adjacent
  // pairs as weak clues so common particles do not count as shared names.
  const singleHan = (word) =>
    word &&
    /^\p{Script=Han}$/u.test(word) &&
    !COMMON_HAN.has(word) &&
    !INTERJECTION.test(word);
  for (let i = 1; i < segments.length && words.size < 8; i++) {
    const previous = segments[i - 1].segment;
    const current = segments[i].segment;
    if (
      singleHan(previous) &&
      singleHan(current) &&
      substantiveWord(previous + current)
    )
      words.add(previous + current);
  }
  const terms = [...words].slice(0, 8);
  const oldEnough = Date.parse(input.occurredAt) - RECENT_CHAT_MS;
  const history =
    terms.length && Number.isFinite(oldEnough)
      ? prepared(
          memory.db,
          `SELECT id,seq,sender_id,substr(body,1,300) AS body
           FROM events
           WHERE agent_id=? AND connection_id=? AND conversation=?
             AND occurred_at<=? AND seq<?
             AND kind IN ('message.received','message.sent')
           ORDER BY occurred_at DESC,seq DESC LIMIT ?`,
        )
          .all(
            role.id,
            role.connectionId,
            conversation,
            new Date(oldEnough).toISOString(),
            input.seq,
            FAMILIARITY_WINDOW,
          )
          .map(({ id, seq, sender_id, body }) => ({
            id,
            seq,
            sender: sender_id,
            text: body.toLowerCase(),
          }))
      : [];
  const speakerHistory = history.filter(
    ({ sender }) => sender === row.sender_id,
  );
  const common = (word, sample, ratio) => {
    const count = sample.filter(({ text }) => text.includes(word)).length;
    return count >= 4 && count / sample.length >= ratio;
  };
  const distinctive = terms.filter(
    (word) => !common(word, history, 0.2) && !common(word, speakerHistory, 0.5),
  );
  const candidates = history
    .map(({ id, seq, text }) => {
      const overlap = distinctive.filter((word) => text.includes(word));
      const strong =
        overlap.some((word) => word.length >= 4) ||
        overlap.filter((word) => segmented.has(word)).length >= 2;
      return { id, seq, overlap, strong };
    })
    .filter(({ overlap }) => overlap.length)
    .sort(
      (a, b) =>
        Number(b.strong) - Number(a.strong) ||
        b.overlap.length - a.overlap.length ||
        b.seq - a.seq,
    )
    .slice(0, 6)
    .filter(({ id }) => evidence(runtime, ctx, [id], input.seq).length);
  let cache = familiarityMarks.get(runtime);
  if (cache?.config !== runtime.config) {
    cache = { config: runtime.config, messages: new Map() };
    familiarityMarks.set(runtime, cache);
  }
  if (cache.messages.size >= FAMILIARITY_MARKS)
    cache.messages.delete(cache.messages.keys().next().value);
  cache.messages.set(id, {
    id,
    seq: input.seq,
    candidates: candidates.slice(0, 2),
    terms: distinctive,
    ms: Math.round(performance.now() - start),
  });
}

function capturedFamiliarity(runtime, items) {
  const cache = familiarityMarks.get(runtime);
  if (cache?.config !== runtime.config) return [];
  return items.map(({ id }) => cache.messages.get(id)).filter(Boolean);
}

function comparableBody(body) {
  return body.normalize("NFKC").trim().replace(/\s+/gu, " ");
}

export function captureRecallContext(ctx, items) {
  if (!ctx.recallOpening) return;
  ctx.recallOpening.visible = items.filter(
    (item) =>
      item.body &&
      !item.bodyTruncated &&
      !item.summaryOmitted &&
      !item.recalled,
  );
}

function knownContext(runtime, ctx, cues, batch) {
  const { role, memory, boundary } = sources(runtime, ctx);
  const latest = cues.reduce((a, b) => (a.seq > b.seq ? a : b));
  const since = new Date(
    Date.parse(latest.occurredAt) - RECENT_CHAT_MS,
  ).toISOString();
  const cueIds = new Set(cues.map(({ id }) => id));
  const visible = ctx.recallOpening.visible.filter((item) =>
    boundary.allowed(item),
  );
  const recent = prepared(
    memory.db,
    `
    SELECT * FROM events WHERE agent_id=? AND connection_id=? AND conversation=?
      AND occurred_at>=? AND occurred_at<=? AND seq<?
      AND kind IN ('message.received','message.sent')
    ORDER BY occurred_at DESC,seq DESC LIMIT 6
  `,
  )
    .all(
      role.id,
      role.connectionId,
      ctx.conversation,
      since,
      latest.occurredAt,
      latest.seq,
    )
    .map((row) => boundary.project(memory.event(row, ctx.conversation)))
    .filter((row) => row?.body);
  const batchIds = new Set(batch.map(({ id }) => id));
  const context = new Map(
    [...recent, ...visible, ...batch].map((row) => [row.id, row]),
  );
  const prior = [...context.values()]
    .filter(
      ({ id, seq }) =>
        !cueIds.has(id) && (seq < latest.seq || batchIds.has(id)),
    )
    .sort((a, b) => a.seq - b.seq);
  return {
    knownIds: new Set(context.keys()),
    knownBodies: new Set(
      [...context.values(), ...cues].map(({ body }) => comparableBody(body)),
    ),
    recent: prior.slice(-6).map((row) => messageExcerpt(row, 220)),
  };
}

function novelEvidence(row, known) {
  return (
    !known.knownIds.has(row.id) &&
    !known.knownBodies.has(comparableBody(row.body))
  );
}

function familiarityCandidates(runtime, ctx, cues, known, beforeSeq, to) {
  const inputIds = new Set(cues.map(({ id }) => id));
  const local = new Map();
  const queries = new Set();
  for (const mark of ctx.recallOpening.familiarity) {
    if (!inputIds.has(mark.id)) continue;
    const covered = new Set();
    for (const { id, overlap } of mark.candidates) {
      const [row] = evidence(runtime, ctx, [id], beforeSeq);
      if (row && row.occurredAt <= to && novelEvidence(row, known)) {
        local.set(row.id, candidateExcerpt(row));
        for (const term of overlap) covered.add(term);
      }
    }
    for (const term of mark.terms) {
      if (!covered.has(term)) queries.add(term);
    }
  }

  // Recent chat remains cheap to scan. Missing topic terms get a small
  // retrieval budget at reply time, even when the recent window found nothing.
  const scope = sources(runtime, ctx);
  const historical = new Map();
  for (const term of [...queries].slice(0, 3)) {
    const hits = searchRecallHistory(
      scope,
      ctx.conversation,
      term,
      beforeSeq,
      to,
    );
    for (const hit of hits) {
      const [row] = evidence(runtime, ctx, [hit.id], beforeSeq);
      if (
        !row ||
        local.has(row.id) ||
        historical.has(row.id) ||
        row.occurredAt > to ||
        !novelEvidence(row, known)
      )
        continue;
      historical.set(row.id, candidateExcerpt(row));
      break;
    }
  }
  return [...historical.values(), ...local.values()];
}

function semanticCandidates(runtime, ctx, hits, known, beforeSeq, to) {
  return hits.flatMap(({ id, digest }) => {
    const [row] = evidence(runtime, ctx, [id], beforeSeq);
    if (
      !row ||
      row.id !== id ||
      row.occurredAt > to ||
      !novelEvidence(row, known) ||
      semanticDigest(row.body) !== digest
    )
      return [];
    return [candidateExcerpt(row)];
  });
}

function mergeCandidates(lexical, semantic) {
  const unique = new Map();
  for (let i = 0; i < Math.max(lexical.length, semantic.length); i++)
    for (const candidate of [lexical[i], semantic[i]])
      if (candidate) unique.set(candidate.id, candidate);
  return [...unique.values()].slice(0, MAX_RECALL_CANDIDATES);
}

function countPresentedFamiliarity(runtime, ctx, verified) {
  const marks = ctx.recallOpening.familiarity;
  if (!marks.length) return 0;
  const matched = new Set(
    marks.flatMap((mark) => mark.candidates.map(({ id }) => id)),
  );
  const approved = new Set(verified.map(({ id }) => id));
  const presentedIds = new Set();
  if (approved.size) {
    const { boundary } = sources(runtime, ctx);
    for (const mark of marks) {
      const input = liveInput(runtime, ctx.agentId, ctx.conversation, mark.id);
      if (!input || !boundary.allowed({ id: mark.id })) continue;
      for (const candidate of mark.candidates) {
        const [source] = evidence(runtime, ctx, [candidate.id], mark.seq);
        if (approved.has(source?.id)) presentedIds.add(source.id);
      }
    }
  }
  // Local matches are diagnostic only. Approved evidence uses the same full
  // projection regardless of how the candidate was found.
  record(runtime, ctx, "familiarity", {
    reason: "local-familiarity",
    status: presentedIds.size ? "matched" : matched.size ? "withheld" : "empty",
    checked: marks.length,
    matched: matched.size,
    presented: 0,
    waitMs: marks.reduce((sum, mark) => sum + mark.ms, 0),
  });
  return presentedIds.size;
}

function searchRecallHistory(
  { role, memory, boundary },
  conversation,
  query,
  beforeSeq,
  to,
) {
  return memory.search(
    {
      query,
      connectionId: role.connectionId,
      conversation,
      type: "event",
      to,
      cursor: {
        beforeSeq,
        eventOffset: 0,
        diaryOffset: 0,
        eventsDone: false,
        diariesDone: true,
      },
      limit: 6,
      maxChars: 4000,
    },
    conversation,
    { projectEvent: boundary.project },
  ).items;
}

function shortlist(runtime, ctx, cues, { cue, query }, beforeSeq) {
  const scope = sources(runtime, ctx);
  const words = [
    ...new Set([
      ...(cue ? [cue] : []),
      ...(query
        ? keywords([...WORDS.segment(query)]).filter((word) =>
            substantiveWord(word.toLowerCase()),
          )
        : []),
      ...cues.flatMap(({ body }) =>
        keywords([...WORDS.segment(body.slice(0, 240))]),
      ),
    ]),
  ].slice(0, 4);
  const entries = new Map();
  for (const query of words) {
    const items = searchRecallHistory(
      scope,
      ctx.conversation,
      query,
      beforeSeq,
    );
    for (const item of items) {
      if (!item.body) continue;
      const score = words.filter((word) => item.body.includes(word)).length;
      entries.set(item.id, { ...candidateExcerpt(item), score, seq: item.seq });
    }
  }
  return [...entries.values()]
    .sort((a, b) => b.score - a.score || b.seq - a.seq)
    .map(({ score: _score, seq: _seq, ...candidate }) => candidate);
}

function record(runtime, ctx, route, details) {
  if (!runtime.stopped && ctx.turnId)
    recordMemoryRecall(
      runtime.memory.bind(ctx.agentId),
      ctx.turnId,
      route,
      details,
    );
}

function presented(runtime, ctx, route, rows, contribution) {
  if (rows.length) {
    const sources = rows.flatMap((row) => [
      row,
      ...(row.scene?.messages || []),
    ]);
    for (const { id, corrects } of sources) {
      ctx.privateRead.add(id);
      if (corrects) ctx.privateRead.add(corrects);
    }
    ctx.persistTaint?.();
    rememberSources(
      runtime.memory.bind(ctx.agentId),
      ctx.conversation,
      sources,
    );
  }
  record(runtime, ctx, route, {
    presented: rows.length,
    contribution: contribution || null,
  });
}

export function captureRecallOpening(
  runtime,
  ctx,
  { history, focus, previous, reasons, relationship },
) {
  const role = runtime.agent(ctx.agentId);
  const policy = memoryRecallPolicy(role, ctx.conversation, runtime.config);
  if (!policy) return;
  const bounds = reasons
    .map((reason) => reason.firstSeq ?? reason.seq)
    .filter(Number.isSafeInteger);
  const after = bounds.length ? Math.min(...bounds) - 1 : previous;
  const incoming = history.items.filter(
    (item) => item.direction === "in" && item.seq > after,
  );
  if (
    focus?.direction === "in" &&
    focus.seq > after &&
    !incoming.some(({ id }) => id === focus.id)
  )
    incoming.push(focus);
  ctx.recallOpening = {
    familiarity: capturedFamiliarity(runtime, incoming),
    visible: [],
    batchIds: policy.mode === "all" ? incoming.map(({ id }) => id) : [],
    focusId: focus?.id,
    // Limit the legacy model input after filtering by owner, so a busy batch cannot
    // push an otherwise eligible owner message out of an explicit lookup.
    activeAnchors: incoming
      .filter(({ senderId }) => role.ownerIds.includes(senderId))
      .map(({ id }) => id),
    anchors: (focus ? [focus] : history.items)
      .filter((item) => item.direction === "in" && item.seq > after)
      .slice(-3)
      .map(({ id }) => id),
    explicit: Boolean(
      relationship?.optional.some(
        (item) =>
          item.quotedBy &&
          (item.body || item.corrections?.length) &&
          (!item.needsReview || item.corrections?.length),
      ),
    ),
    ambiguous: Boolean(
      relationship?.optional.length > 1 ||
      relationship?.optional.some(
        (item) => item.needsReview && !item.corrections?.length,
      ),
    ),
  };
}

async function lookup(runtime, ctx, route, reason, cues, { cue, query } = {}) {
  const start = performance.now();
  const role = runtime.agent(ctx.agentId);
  const policy = memoryRecallPolicy(role, ctx.conversation, runtime.config);
  const readBatch = () =>
    anchors(runtime, ctx, ctx.recallOpening.batchIds, true);
  const batch = readBatch();
  // The current batch can supply context, but cannot be returned as history.
  const first = [...cues, ...batch].reduce((a, b) => (a.seq < b.seq ? a : b));
  const beforeSeq = first.seq;
  const to = new Date(
    Date.parse(first.occurredAt) - RECENT_CHAT_MS,
  ).toISOString();
  const configVersion = functionalConfigVersion(runtime.config);
  const budget =
    route === "opening" ? policy.openingTimeoutMs : policy.onDemand.timeoutMs;
  const epoch = ctx.inputEpoch;
  const ids = cues.map(({ id }) => id);
  const review = reason === "local-familiarity";
  const known = knownContext(runtime, ctx, cues, batch);
  const current = () =>
    functionalConfigVersion(runtime.config) === configVersion &&
    ctx.inputEpoch === epoch &&
    !ctx.controller.signal.aborted &&
    runtime.capabilities.get(ctx.token) === ctx &&
    Boolean(
      memoryRecallPolicy(
        runtime.agent(ctx.agentId),
        ctx.conversation,
        runtime.config,
      ),
    ) &&
    isDeepStrictEqual(
      anchors(runtime, ctx, ids, policy.mode === "all"),
      cues,
    ) &&
    isDeepStrictEqual(readBatch(), batch);
  let semantic;
  if (policy.semantic) {
    const text = semanticQuery(cues, known.recent, { cue, query });
    semantic = text
      ? await runtime.semanticRecall.search(role, ctx.conversation, text, {
          beforeSeq,
          to: Date.parse(to),
          known: [...known.knownIds],
          signal: ctx.controller.signal,
          budget: Math.min(SEMANTIC_WAIT_MS, Math.floor(budget / 4)),
        })
      : { status: "no-cue", waitMs: 0 };
  }
  const semanticRows = (context) =>
    semanticCandidates(
      runtime,
      ctx,
      semantic?.hits || [],
      context,
      beforeSeq,
      to,
    );
  const lexicalRows = (context) =>
    review
      ? familiarityCandidates(runtime, ctx, cues, context, beforeSeq, to)
      : shortlist(runtime, ctx, cues, { cue, query }, beforeSeq);
  const getCandidates = (context) =>
    mergeCandidates(lexicalRows(context), semanticRows(context));
  const empty = (status, why = reason, trace = {}) => {
    const details = {
      reason: why,
      status,
      matched: 0,
      presented: 0,
      waitMs: Math.round(performance.now() - start),
      ...trace,
    };
    record(runtime, ctx, route, details);
    return { details, read: () => ({ rows: [] }) };
  };
  if (semantic && !current()) return empty("stale");
  const semanticMatches = semanticRows(known);
  const trace = semantic
    ? {
        semantic: {
          status:
            semantic.status === "ready"
              ? semanticMatches.length
                ? "matched"
                : "empty"
              : semantic.status,
          waitMs: semantic.waitMs,
          candidates: semanticMatches.length,
        },
      }
    : {};
  const lexical = lexicalRows(known);
  const candidates = mergeCandidates(lexical, semanticMatches);
  if (review && !candidates.length)
    return semantic ? empty("skipped", "no-cue", trace) : undefined;
  const lexicalIds = new Set(lexical.map(({ id }) => id));
  const semanticOnly = new Set(
    semanticMatches.map(({ id }) => id).filter((id) => !lexicalIds.has(id)),
  );
  if (review && !lexical.length) reason = "local-semantic";
  const prompt = JSON.stringify({
    task: "先根据 current 和 recent 确认发言者、话里所指的人或事、时间及信息缺口，有 query 时核对它问的缺口。发言者可能在说别人；同一句状态描述用在不同人或不同事情上，不能当成同一件事。仅措辞、话题或状态相同而对象不明时，提交空数组。相关旧事可作背景，但只能说明当时发生了什么。只选能补充当前上下文的至多两条证据，用 functional_agent_result 提交，并用 contribution 简短说明补充了什么，省略原话、身份编号和凭据。有更正时优先用更正消息的 ID。候选够用就提交，确有缺口才补查一次；没有新增信息就提交空数组。",
    cue,
    query,
    current: cues.map((row) => messageExcerpt(row, 480)),
    recent: known.recent,
    candidates,
  });
  record(runtime, ctx, route, {
    reason,
    status: "running",
    matched: 0,
    presented: 0,
    waitMs: 0,
    ...trace,
  });
  const agentStarted = performance.now();
  const remaining = () => budget - Math.ceil(performance.now() - start);
  const delegate = () => {
    const timeoutMs = remaining();
    if (timeoutMs <= 0) return { status: "timeout" };
    return runtime.functionalDelegation.run(ctx, "memory", {
      prompt,
      timeoutMs,
      opening: route === "opening",
      resultOnReceipt: true,
      evidenceBeforeSeq: beforeSeq,
      shownEvidenceIds: candidates.map(({ id }) => id),
      beforeInput: () => {
        if (!current()) return false;
        const context = knownContext(runtime, ctx, cues, batch);
        return (
          isDeepStrictEqual(context.recent, known.recent) &&
          isDeepStrictEqual(candidates, getCandidates(context))
        );
      },
    });
  };
  let result = await delegate();
  // A busy admission started no child. Active recall gets one bounded retry
  // within the original deadline, without keeping a queue of stale turns.
  if (
    route === "active" &&
    result.status === "busy" &&
    remaining() > ACTIVE_SLOT_RETRY_MS
  ) {
    await delay(ACTIVE_SLOT_RETRY_MS, undefined, {
      signal: ctx.controller.signal,
    }).catch((error) => {
      if (error?.name !== "AbortError") throw error;
    });
    if (ctx.controller.signal.aborted) result = { status: "cancelled" };
    else if (current()) result = await delegate();
    else result = { status: "stale" };
  }
  const sourceIds = result.evidenceIds || [];
  const submitted =
    result.contribution && !runtime.containsCapability(ctx, result.contribution)
      ? evidence(runtime, ctx, sourceIds, beforeSeq)
      : null;
  // A statement about a selection cannot follow a substituted or partial set.
  const selectedContribution =
    submitted?.length === sourceIds.length &&
    submitted.every(({ corrects }) => !corrects)
      ? result.contribution
      : undefined;
  const details = {
    reason,
    status:
      result.status === "completed"
        ? sourceIds.length
          ? "matched"
          : "empty"
        : result.status,
    matched: sourceIds.length,
    presented: 0,
    waitMs: Math.round(performance.now() - start),
    agentMs: Math.round(performance.now() - agentStarted),
    ...trace,
  };
  record(runtime, ctx, route, details);
  return {
    details,
    read: () => {
      if (!current()) return { rows: [] };
      const context = knownContext(runtime, ctx, cues, batch);
      if (!isDeepStrictEqual(known.recent, context.recent)) return { rows: [] };
      const stillSemantic = new Set(semanticRows(context).map(({ id }) => id));
      const approved = sourceIds.filter(
        (id) => !semanticOnly.has(id) || stillSemantic.has(id),
      );
      const rows = evidence(runtime, ctx, approved, beforeSeq).filter(
        (row) =>
          !review || (row.occurredAt <= to && novelEvidence(row, context)),
      );
      return {
        contribution:
          selectedContribution && isDeepStrictEqual(rows, submitted)
            ? selectedContribution
            : undefined,
        rows: rows.map((row) => {
          const scene = evidenceScene(runtime, ctx, row.id, beforeSeq);
          return scene ? { ...row, scene } : row;
        }),
      };
    },
  };
}

export async function prepareRecallOpening(runtime, ctx) {
  const input = ctx.recallOpening;
  const policy = memoryRecallPolicy(
    runtime.agent(ctx.agentId),
    ctx.conversation,
    runtime.config,
  );
  if (!input || !policy?.opening) return;
  const useBatch = policy.mode === "all";
  const batch = useBatch ? anchors(runtime, ctx, input.batchIds, true) : [];
  const priority = (row) =>
    OLD_REFERENCE.test(row.body) ? 2 : Number(row.id === input.focusId);
  const cues = useBatch
    ? batch
        .sort((a, b) => priority(b) - priority(a) || b.seq - a.seq)
        .slice(0, 3)
        .sort((a, b) => a.seq - b.seq)
    : anchors(runtime, ctx, input.anchors);
  const reason = !cues.length
    ? "no-live-cue"
    : input.explicit && !input.ambiguous
      ? "explicit-reference"
      : input.ambiguous
        ? "ambiguous"
        : cues.some(({ body }) => OLD_REFERENCE.test(body))
          ? "past-reference"
          : "no-cue";
  if (reason === "past-reference" || reason === "ambiguous")
    ctx.openingRecall = await lookup(runtime, ctx, "opening", reason, cues);
  else if (reason !== "explicit-reference") {
    const marked = anchors(
      runtime,
      ctx,
      input.familiarity.filter(({ terms }) => terms.length).map(({ id }) => id),
      useBatch,
    ).slice(-3);
    const review = policy.semantic
      ? [...new Map([...marked, ...cues].map((row) => [row.id, row])).values()]
          .sort((a, b) => a.seq - b.seq)
          .slice(-3)
      : marked;
    if (review.length)
      ctx.openingRecall = await lookup(
        runtime,
        ctx,
        "opening",
        "local-familiarity",
        review,
      );
  }
  if (!ctx.openingRecall) {
    const details = {
      reason,
      status: "skipped",
      matched: 0,
      presented: 0,
      waitMs: 0,
    };
    record(runtime, ctx, "opening", details);
    ctx.openingRecall = { details, read: () => ({ rows: [] }) };
  }
}

export function renderRecallOpening(runtime, ctx) {
  const recall = ctx.openingRecall;
  if (
    !recall ||
    !memoryRecallPolicy(
      runtime.agent(ctx.agentId),
      ctx.conversation,
      runtime.config,
    )?.opening
  )
    return "";
  const { rows, contribution } = recall.read();
  const details = recall.details;
  const status =
    details.status === "matched" && !rows.length ? "withheld" : details.status;
  if (status !== details.status) record(runtime, ctx, "opening", { status });
  ctx.openingRecallSent = { rows, contribution };
  ctx.openingFamiliarityCount = countPresentedFamiliarity(runtime, ctx, rows);
  const notice = ctx.allowedTools.includes("memory_recall")
    ? "需要再查时可用 memory_recall。query 可写想核对的具体问题，cue 可填写本轮来信的原文线索。"
    : "";
  const addition =
    ctx.compactChat && !rows.length
      ? `\n\n本轮记忆查证：${status === "skipped" && details.reason === "explicit-reference" ? "已展开原引用" : JSON.stringify({ status, reason: details.reason })}。${notice ? "需要补查可用 memory_recall。" : ""}`
      : `\n\n本轮记忆查证 ${JSON.stringify({ status, reason: details.reason, contribution, evidence: rows })}。${HISTORY_LABEL}${notice}`;
  ctx.estimatedAdded += addition.length;
  return addition;
}

export function commitRecallOpening(runtime, ctx) {
  if (!ctx.openingRecallSent) return;
  const { rows, contribution } = ctx.openingRecallSent;
  delete ctx.openingRecallSent;
  presented(runtime, ctx, "opening", rows, contribution);
  const familiarity = ctx.openingFamiliarityCount;
  delete ctx.openingFamiliarityCount;
  if (familiarity)
    record(runtime, ctx, "familiarity", { presented: familiarity });
}

export async function recallFromChat(runtime, ctx, { cue, query }) {
  const policy = memoryRecallPolicy(
    runtime.agent(ctx.agentId),
    ctx.conversation,
    runtime.config,
  );
  if (!ctx.recallOpening || !policy) throw Error("TOOL_DISABLED");
  if (ctx.activeRecallRunning) return { status: "busy" };
  if (ctx.activeRecallRequested) return { status: "budget" };
  const useBatch = policy.mode === "all";
  const available = anchors(
    runtime,
    ctx,
    useBatch ? ctx.recallOpening.batchIds : ctx.recallOpening.activeAnchors,
    useBatch,
  );
  const exact = cue ? available.filter(({ body }) => body.includes(cue)) : [];
  const selected = (exact.length || !query ? exact : available).slice(-3);
  if (!selected.length) {
    const reason = available.length
      ? "cue-not-found"
      : useBatch
        ? "no-live-cue"
        : "no-owner-input";
    record(runtime, ctx, "active", {
      reason,
      status: "no-cue",
      matched: 0,
      presented: 0,
      waitMs: 0,
    });
    return { status: "no-cue", reason };
  }
  ctx.activeRecallRequested = true;
  ctx.activeRecallRunning = true;
  try {
    return await resolveActiveRecall(runtime, ctx, selected, {
      cue: exact.length ? cue : undefined,
      query,
    });
  } finally {
    ctx.activeRecallRunning = false;
  }
}

async function resolveActiveRecall(runtime, ctx, selected, request) {
  const recall = await lookup(
    runtime,
    ctx,
    "active",
    "tool",
    selected,
    request,
  );
  const view = recall.read();
  const { rows, contribution } = view;
  if (!rows.length) {
    const status =
      recall.details.status === "matched" ? "withheld" : recall.details.status;
    if (status !== recall.details.status)
      record(runtime, ctx, "active", { status });
    const retryBySearch =
      ["timeout", "busy", "unavailable", "no-result"].includes(status) &&
      ctx.allowedTools?.includes("memory_search");
    return {
      status,
      ...(retryBySearch && { notice: activeSearchNotice(ctx.conversation) }),
    };
  }
  const result = {
    status: "matched",
    evidence: rows,
    ...(contribution && { contribution }),
    notice: HISTORY_LABEL,
  };
  const current = () => isDeepStrictEqual(view, recall.read());
  runtime.stageToolOutput(ctx, result, [
    {
      value: result,
      expected: result,
      current,
      commit: () =>
        current() && presented(runtime, ctx, "active", rows, contribution),
    },
    { value: { status: "withheld" } },
  ]);
  return result;
}
