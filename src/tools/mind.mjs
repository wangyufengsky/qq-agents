import { personCloseness } from "../core/closeness.mjs";
import {
  activityFields,
  projectReadSchema,
  writeActivity,
  readProjects,
} from "./activities.mjs";
import { correctionDefinitions, correctionTool } from "./corrections.mjs";
import { frameworkDefinitions, frameworkTool } from "./framework.mjs";
import { SUBJECT_APP_TOOLS } from "../apps/policy.mjs";
import { identityAnchors } from "../core/prompts.mjs";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { privateGithubSources } from "../github/policy.mjs";
import { recallBoundary } from "../core/recall-boundary.mjs";
import {
  contextProtection,
  trackMindRecords,
} from "../core/protected-mind.mjs";
import {
  markPersonCardShown,
  markPersonItemShown,
} from "../core/person-cards.mjs";
import { PERSON_ITEM_KINDS } from "../memory/identity.mjs";
import { markMoodShown } from "../core/mood.mjs";
const text = z.string().min(1),
  ids = z.array(text).max(30),
  version = z.number().int().min(1);
export const mindDefinitions = {
  ...frameworkDefinitions,
  ...correctionDefinitions,
  self_read: [
    "读取当前正式 self、身份锚点与本回合固定版本；数据库最新版不改变当前回合。",
    z.object({}).strict(),
  ],
  self_history: [
    "分页查看 self 版本历史、理由与证据。初始化模板只作历史；恢复旧版由管理端生成新版本。",
    z.object({ offset: z.number().int().min(0).default(0) }).strict(),
  ],
  self_candidates: [
    "分页读取独立候选和回顾状态；候选不是已生效人格。",
    z.object({ offset: z.number().int().min(0).default(0) }).strict(),
  ],
  self_propose: [
    "提出 self 候选，不能直接改写正式 self。提供原始经历、反例和原因；当前版本冲突应重读后重新考虑。",
    z
      .object({
        body: text.max(16000),
        reason: text.max(2000),
        evidence: ids,
        counterEvidence: ids.default([]),
        scope: z.enum(["interest", "habit", "relationship"]),
        expectedVersion: version,
      })
      .strict(),
  ],
  self_review: [
    "仅主体可延后回顾候选：采纳/修订/继续观察/拒绝。重复引用、同场争论不构成独立证据；固定账号和权限不能改。",
    z
      .object({
        id: text,
        expectedRevision: version,
        expectedVersion: version,
        action: z.enum(["accept", "revise", "observe", "reject"]),
        reason: text.max(2000),
        body: text.max(16000).optional(),
      })
      .strict(),
  ],
  self_withdraw: [
    "撤回自己会话提出的候选。",
    z.object({ id: text, expectedRevision: version }).strict(),
  ],
  work_note: [
    "保存或更新有来源的未完成话题/约定；不是日记或客观事实。答应某个人的事、和某人的共同经历或相处边界改用 person_item，它跟着这个人走，到别的聊天也看得到。允许保存受保护内容，自动继承且保留上下文及来源的保护标记；保存不授予对外披露权限。完成/更正后更新状态，事件时间从原始来源读取。",
    z
      .object({
        id: text.optional(),
        body: text.max(2000),
        evidence: ids,
        uncertainty: text.max(1000),
        status: z.enum(["open", "completed", "corrected"]).default("open"),
      })
      .strict(),
  ],
  work_notes: [
    "分页读当前会话未完成工作笔记及来源可用性。",
    z.object({ offset: z.number().int().min(0).default(0) }).strict(),
  ],
  person_note: [
    "写下或更新你对某个人的人物卡：call 是你怎么称呼对方，body 是你们的关系和你对他的印象（对这个人的情绪，比如还在生他的气，也写在这里），用你自己的视角写，是看法不是事实。evidence 至少一条记录 ID，依据对方明确说过的话或你亲眼见到的事；对方自称、开玩笑的叫法或反问“你叫我什么”不等于希望你这么叫。卡片在所有群和私聊共用，不要写只适合某个场合说的私事。已有卡片时 expectedRevision 填当前版本号，新卡省略。对方之后在聊天里说话时，会自动附上这张卡。",
    z
      .object({
        personId: text.regex(/^\d{5,12}$/),
        call: z.string().max(40).default(""),
        body: text.max(600),
        evidence: ids.min(1),
        expectedRevision: version.optional(),
      })
      .strict(),
  ],
  person_notes: [
    "读取人物卡。给 personIds 读指定的人（含证据与旧版本，以及 people 里写了这个人的最近三篇日记的标题）；省略时按最近更新分页列出全部。",
    z
      .object({
        personIds: z
          .array(text.regex(/^\d{5,12}$/))
          .min(1)
          .max(20)
          .optional(),
        offset: z.number().int().min(0).default(0),
      })
      .strict(),
  ],
  person_item: [
    "记下或更新你和某个人之间的一件事，放在人物卡旁边。kind 三选一：promise 是你答应对方、还没做完的事（“我回头查查”“下次接着讲”），只记真打算做的，客套话不用记；shared 是你们一起经历过、以后可能接回来的事（一起讨论过的结局、给角色起的梗、约好下次继续的故事）；boundary 是对方明确表示的相处边界或发生过的误会（不喜欢的称呼或玩笑、误会后来有没有解释清楚），记下后真的照着调整，不要道歉一次又重犯。body 用你自己的话写这件事（最多 300 字），evidence 至少一条记录 ID。新记录省略 id；更新或关掉时带 id 和当前 expectedRevision。promise 做到了、回来交代过就 status=done；做不成，坦白告诉对方后 status=dropped；边界或经历不再适用也用 dropped。关掉要写 outcome（结果怎样、怎么交代的），evidence 里必须有一条在这件事记下之后的聊天消息：你回来交代的那句话（qq_send 结果里的 recordId），或者对方说不用了的那句话。只在空闲时间想过不算交代。这些记录在所有群聊和私聊共用；在私聊里记下的事，到了别的聊天只用来调整你自己的做法，不要提起内容。",
    z
      .object({
        id: text.optional(),
        personId: text.regex(/^\d{5,12}$/),
        kind: z.enum(PERSON_ITEM_KINDS).optional(),
        body: text.max(300).optional(),
        evidence: ids.min(1),
        status: z.enum(["open", "done", "dropped"]).default("open"),
        outcome: z.string().max(300).default(""),
        expectedRevision: version.optional(),
      })
      .strict(),
  ],
  person_items: [
    "读取你和某些人之间记下的事（答应的事、共同经历、相处边界）：给 personIds 读这些人的全部记录，没了结的在前，附最近关掉的；省略时按最久未了结的在前分页列出所有人的 open 记录，可用 kind 只看一类。",
    z
      .object({
        personIds: z
          .array(text.regex(/^\d{5,12}$/))
          .min(1)
          .max(20)
          .optional(),
        kind: z.enum(PERSON_ITEM_KINDS).optional(),
        offset: z.number().int().min(0).default(0),
      })
      .strict(),
  ],
  project: [
    "项目新建给 title/why（最多5个进行中），更新给 id/expectedRevision、真实 progress、来源 evidence/files、后续 next/blocker；done/dropped 须 outcome。shared.participants 填明确同意者，创建附本轮 participantEventId；turn 指轮次、pending 留选项、draft 存整稿，不代选。QQ活动仅原聊天继续，管理员明确加入的 mode=console 可在空闲主体继续。先 projects(id) 按返回指引读全旧稿与贡献；administratorRead 只确认阅读和摘要，不混入修改或授予QQ发送权限。",
    z
      .object({
        ...activityFields,
        id: text.optional(),
        title: z.string().max(60).optional(),
        why: z.string().max(300).optional(),
        progress: z.string().max(300).default(""),
        evidence: ids.default([]),
        files: z
          .array(z.string().regex(/^[a-f0-9]{64}$/))
          .max(10)
          .default([]),
        next: z.string().max(200).optional(),
        blocker: z.string().max(200).optional(),
        status: z.enum(["active", "paused", "done", "dropped"]).optional(),
        outcome: z.string().max(300).default(""),
        expectedRevision: version.optional(),
      })
      .strict(),
  ],
  projects: [
    "读取项目：id 读当前状态、原稿、贡献与历史；revision 读旧版，offset/maxChars 续读正文，historyOffset 翻历史。省略 id 列当前场合可见的项目。",
    projectReadSchema,
  ],
  mood_set: [
    "记下你此刻的心情和原因。不是必须的：心情真的变了再写，不用每轮都写，也不用为了写而写。mood 用几个字说心情，intensity 是有多强烈（1 很轻，5 非常强烈）；reason 说为什么变好或变坏、是因为什么事，可在 evidence 附上引起变化的记录 ID。hours 是这份心情大约持续多久（0.5–24，默认 4），到期后就不再提示；之后心情又变了就再写一次。clear=true 表示心情已经过去、回到平常，这时只需要 reason。强度 4 以上、仍在有效期内的心情，要改变或清除它，evidence 里必须有一条在它之后发生的记录：可以是对方后来的解释、别人的话，也可以是你自己的 subject_log，比如回头想清了那场误会，或者去做了别的事、缓过来了；没有新的原因就让它保持，到期会自然结束。平复不需要等谁来哄。心情影响你怎么说、想不想参与某个话题，但不要拿它向人讨安慰或要别人哄你。冲着某个人的情绪（比如生某人的气）写进那个人的人物卡（person_note），这里只写你整体的状态，也别把对一个人的不满带到不相干的群和人身上。心情在你所有群聊和私聊之间共享，只给你自己看，但原因要写成在别的聊天里想起来也无妨的说法。想配个表情，可以用 sticker_list 按心情搜你自己收藏的表情。",
    z
      .object({
        mood: z.string().max(40).optional(),
        intensity: z.number().int().min(1).max(5).optional(),
        reason: text.max(300),
        hours: z.number().min(0.5).max(24).default(4),
        evidence: ids.max(10).default([]),
        clear: z.boolean().default(false),
      })
      .strict(),
  ],
  mood_read: [
    "读取你当前仍有效的心情和最近十次心情变化（含原因）。",
    z.object({}).strict(),
  ],
  intent_create: [
    "创建普通聊天意图（不是正式提醒），允许带保护标记保存。主体不能直接发送；目标聊天可暂缓/放弃，受保护资料不向未经授权的目标自动交接或发送。主题跨群去重；expiresAt/eligibleAt 为 Unix 毫秒。",
    z
      .object({
        topic: text.max(300),
        target: text.regex(/^(group|private):\d+$/),
        reason: text.max(2000),
        background: z.string().max(3000).default(""),
        evidence: ids.default([]),
        eligibleAt: z.number().int().optional(),
        expiresAt: z.number().int(),
        expectsResponse: z.boolean().default(false),
      })
      .strict(),
  ],
  intent_list: [
    "读取主体意图状态和发送结果；可按目标和有效状态分页。已交接不能重复交接。",
    z
      .object({
        offset: z.number().int().min(0).default(0),
        target: text.regex(/^(group|private):\d+$/).optional(),
        activeOnly: z.boolean().default(false),
      })
      .strict(),
  ],
  intent_update: [
    "取消或暂缓有效意图；需要 revision，不能修改已发送内容。",
    z
      .object({
        id: text,
        expectedRevision: version,
        action: z.enum(["cancel", "defer"]),
        reason: text.max(2000),
        eligibleAt: z.number().int().optional(),
      })
      .strict(),
  ],
  subject_log: [
    "空闲时间结束前记一笔：做了什么、发现了什么、下次想接着做什么。下次空闲时间会先看到最近几条，管理员也能看到。选择休息也要记录原因。found 可附上浏览/读取工具返回的 sourceRecordId。",
    z
      .object({
        did: z.enum([
          "browsed",
          "searched",
          "read",
          "wrote",
          "reviewed",
          "reached-out",
          "rested",
        ]),
        summary: text.max(200),
        found: z
          .array(
            z
              .object({
                title: text.max(120),
                sourceRecordId: text.max(80).optional(),
              })
              .strict(),
          )
          .max(3)
          .default([]),
        next: z.string().max(100).default(""),
        restReason: z
          .enum(["recent", "no-interest", "budget", "quiet"])
          .optional(),
      })
      .strict(),
  ],
  intent_decide: [
    "仅目标聊天结合现场决定 send/defer/cancel/complete。send 后使用启用 QQ 工具发一次；无关来信不能 complete，完成需提供相关新来信证据。",
    z
      .object({
        id: text,
        expectedRevision: version,
        action: z.enum(["send", "defer", "cancel", "complete"]),
        reason: text.max(2000),
        evidence: ids.optional(),
      })
      .strict(),
  ],
};
export const CHAT_MIND_TOOLS = Object.keys(mindDefinitions).filter(
  (n) => n !== "self_review" && n !== "subject_log",
);
export const SUBJECT_TOOLS = [
  ...Object.keys(frameworkDefinitions),
  "memory_corrections",
  "memory_correction_review",
  "github_capabilities",
  "github_search",
  "github_read",
  ...SUBJECT_APP_TOOLS,
  "memory_search",
  "memory_related",
  "memory_read",
  "conversation_read",
  "diary_write",
  "diary_revise",
  "self_read",
  "self_history",
  "self_candidates",
  "self_review",
  "self_propose",
  "self_withdraw",
  "work_note",
  "work_notes",
  "person_note",
  "person_notes",
  "person_item",
  "person_items",
  "project",
  "projects",
  "mood_set",
  "mood_read",
  "file_list",
  "file_read",
  "file_create",
  "intent_create",
  "intent_list",
  "intent_update",
  "subject_log",
];
function executeMindTool(runtime, ctx, name, args) {
  const a = runtime.agent(ctx.agentId),
    m = runtime.memory.bind(a.id),
    identity = m.identity,
    now = runtime.now();
  // Shared self and person cards cannot carry restricted material. Scoped notes
  // and intentions instead retain protection on storage, reads, handoff and
  // actual delivery.
  if (
    [
      "memory_correct",
      "memory_correction_review",
      "self_propose",
      "self_review",
      "self_withdraw",
      "person_note",
      "person_item",
      "project",
      "mood_set",
    ].includes(name) &&
    (privateGithubSources(ctx, runtime).length > 0 ||
      [...ctx.privateRead].some((id) =>
        /^(operations|operations-result|github-private):/.test(id),
      ))
  )
    throw Error("RESTRICTED_CONTEXT_MIND_WRITE_BLOCKED");
  if (name in correctionDefinitions)
    return correctionTool(runtime, ctx, name, args);
  if (name in frameworkDefinitions)
    return frameworkTool(runtime, ctx, name, args);
  if (name === "self_read")
    return {
      current: (() => {
        const current = identity.withEvidence(identity.current());
        recallBoundary(runtime, ctx).assert(current);
        return current;
      })(),
      turnSelfVersion: ctx.selfVersion,
      anchors: identity.anchors(a),
      identity: identityAnchors(runtime.config, a),
    };
  if (name === "self_history" || name === "self_candidates") {
    const rows =
      name === "self_history"
        ? identity.history()
        : identity.list("self_candidates");
    return {
      items: recallBoundary(runtime, ctx).rows(
        rows
          .slice(args.offset, args.offset + 10)
          .map((row) => identity.withEvidence(row)),
      ),
      nextOffset: args.offset + 10 < rows.length ? args.offset + 10 : null,
    };
  }
  if (name === "self_propose")
    return identity.propose(args, ctx, a.selfPolicy, now);
  if (name === "self_review")
    return identity.review(args, ctx, a.selfPolicy, now);
  if (name === "self_withdraw")
    return identity.withdraw(args.id, args.expectedRevision, ctx, now);
  if (name === "work_note")
    return identity.saveNote(
      args,
      ctx.conversation,
      now,
      contextProtection(runtime, ctx),
    );
  if (name === "work_notes") {
    const rows = recallBoundary(runtime, ctx).rows(
      identity.notes(ctx.conversation),
    );
    return {
      items: rows.slice(args.offset, args.offset + 8),
      nextOffset: args.offset + 8 < rows.length ? args.offset + 8 : null,
    };
  }
  if (name === "person_note") {
    const card = identity.savePersonCard(args, {
      writtenIn: ctx.conversation,
      now,
    });
    card.closeness = personCloseness(
      m,
      card.personId,
      now,
      runtime.connection(a.connectionId).accountId,
    );
    markPersonCardShown(m, ctx.conversation, card);
    return card;
  }
  if (name === "person_notes") {
    const viewCard = (card) => ({
      ...card,
      closeness: personCloseness(
        m,
        card.personId,
        now,
        runtime.connection(a.connectionId).accountId,
      ),
      ...m.corrections.annotation("person", card.id, card.revision),
    });
    if (args.personIds) {
      const cards = args.personIds.map((id) => identity.personCard(id)),
        boundary = recallBoundary(runtime, ctx);
      return {
        items: cards.filter(Boolean).map((card) => {
          // Titles only, behind the same boundary as any diary read; the
          // diaries shown count as read (mindTool tracks them).
          const diaries = boundary
            .rows(m.diariesAbout(card.personId))
            .slice(0, 3)
            .map(({ id, title, updatedAt, corrections }) => ({
              id,
              title,
              updatedAt,
              ...(corrections ? { corrections } : {}),
            }));
          return { ...viewCard(card), diaries };
        }),
        missing: args.personIds.filter((_, i) => !cards[i]),
      };
    }
    const rows = identity.personCards();
    return {
      items: rows.slice(args.offset, args.offset + 20).map(viewCard),
      total: rows.length,
      nextOffset: args.offset + 20 < rows.length ? args.offset + 20 : null,
    };
  }
  if (name === "person_item") {
    const item = identity.savePersonItem(args, {
      writtenIn: ctx.conversation,
      now,
    });
    markPersonItemShown(m, ctx.conversation, item);
    return item;
  }
  if (name === "person_items") {
    if (args.personIds)
      return {
        people: args.personIds.map((personId) => {
          const rows = identity
            .personItems(personId)
            .map((x) => ({
              ...x,
              ...m.corrections.annotation("item", x.id, x.revision),
            }))
            .filter((x) => !args.kind || x.kind === args.kind);
          return {
            personId,
            open: rows.filter((x) => x.status === "open"),
            recentlyClosed: rows.filter((x) => x.status !== "open").slice(0, 5),
          };
        }),
      };
    const rows = identity.openPersonItems(args.kind).map((x) => ({
      ...x,
      ...m.corrections.annotation("item", x.id, x.revision),
    }));
    return {
      items: rows.slice(args.offset, args.offset + 20),
      total: rows.length,
      nextOffset: args.offset + 20 < rows.length ? args.offset + 20 : null,
    };
  }
  if (name === "project") {
    // Works are the agent's own files, and a shared project never points at
    // protected material.
    for (const fileId of args.files) {
      if (!runtime.files) throw Error("FILE_LIBRARY_UNAVAILABLE");
      recallBoundary(runtime, ctx).assert(runtime.files.metadata(a.id, fileId));
    }
    const old = args.id ? identity.project(args.id) : null;
    if (
      args.shared ||
      args.draft ||
      args.participantEventId ||
      args.administratorRead ||
      old?.activity
    )
      return writeActivity(runtime, ctx, args, old);
    return identity.saveProject(args, { writtenIn: ctx.conversation, now });
  }
  if (name === "projects") return readProjects(runtime, ctx, args);
  if (name === "mood_set") {
    const mood = identity.setMood(args, {
      writtenIn: ctx.conversation,
      now,
    });
    markMoodShown(m, ctx.conversation, mood);
    return mood;
  }
  if (name === "mood_read")
    return {
      current: identity.currentMood(now),
      recent: identity.moodHistory(10),
    };
  if (name === "subject_log") {
    if (ctx.conversation !== "@subject") throw Error("TOOL_DISABLED");
    if (args.did === "rested" && !args.restReason)
      throw Error("SUBJECT_LOG_REQUIRES_REASON");
    const mood = identity.currentMood(now);
    const record = m.append({
      dedupe: "subject-log:" + ctx.turnId + ":" + randomUUID(),
      conversation: "@subject",
      kind: "subject.log",
      direction: "internal",
      status: "observed",
      body: [args.summary, args.next && "下次：" + args.next]
        .filter(Boolean)
        .join("\n"),
      payload: {
        ...args,
        turnId: ctx.turnId,
        // The mood in effect, by reference only.
        ...(mood ? { moodId: mood.id } : {}),
        // Inherit what this turn read, like work notes do.
        ...contextProtection(runtime, ctx),
      },
    });
    ctx.subjectLogged = true;
    return { id: record.id, recorded: true };
  }
  if (name === "intent_create") return runtime.subject.create(ctx, args);
  if (name === "intent_list") {
    const rows = recallBoundary(runtime, ctx)
      .rows(identity.list("intentions"))
      .filter(
        (i) =>
          (!args.target || i.target === args.target) &&
          (!args.activeOnly ||
            ![
              "cancelled",
              "completed",
              "expired",
              "failed",
              "unknown",
            ].includes(i.status)),
      );
    return {
      items: rows.slice(args.offset, args.offset + 20),
      total: rows.length,
      nextOffset: args.offset + 20 < rows.length ? args.offset + 20 : null,
    };
  }
  if (name === "intent_update") return runtime.subject.update(ctx, args);
  if (name === "intent_decide") return runtime.subject.decide(ctx, args);
  throw Error("UNKNOWN_TOOL");
}

// Frozen excerpts retain the same disclosure boundary as ordinary memory reads,
// including when the live record has subsequently disappeared.
export function mindTool(runtime, ctx, name, args) {
  const result = executeMindTool(runtime, ctx, name, args);
  if (name === "work_note" || name === "work_notes")
    trackMindRecords(
      runtime,
      ctx,
      name === "work_note" ? [result] : result.items,
    );
  if (name.startsWith("intent_"))
    trackMindRecords(
      runtime,
      ctx,
      name === "intent_list" ? result.items : [result],
      "intent",
    );
  if (name === "person_notes")
    for (const card of result.items)
      for (const diary of card.diaries || []) ctx.privateRead.add(diary.id);
  for (const row of [result, result?.current, ...(result?.items || [])]) {
    for (const proof of [row?.evidenceSnapshot, row?.counterEvidenceSnapshot]) {
      for (const ref of proof?.references || []) {
        if (
          ref.type === "diary" ||
          (ref.metadata?.conversation !== ctx.conversation &&
            !(
              ref.metadata?.kind === "app.observation" &&
              ref.metadata?.origin === "app-browser"
            ))
        )
          ctx.privateRead.add(ref.id);
      }
    }
  }
  ctx.persistTaint?.();
  return result;
}
