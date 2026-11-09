import { assertHomeSceneMedia } from "../home/scene-media.mjs";
import { mediaLease } from "./media-lease.mjs";
import { trackSocial, socialSources } from "../core/social-protection.mjs";
import {
  peerQzoneSources,
  trackPeerQzone,
} from "../core/peer-qzone-protection.mjs";
import { withInteraction } from "../core/closeness.mjs";
import { recallMessage } from "../core/message-recall.mjs";
import { deliveryPage } from "../core/chat-context.mjs";
import { rememberSources } from "../core/context-handoff.mjs";
import { presentationCheckpoint, processInput } from "../core/input-review.mjs";
import { sendDraftTool } from "./qq-drafts.mjs";
import { githubMarker, privateGithubSources } from "../github/policy.mjs";
import { readEventImage } from "./image-read.mjs";
import { synthesize } from "./speech.mjs";
import { externalArguments, externalResult } from "./external-media.mjs";
import { taintMedia } from "./legacy.mjs";
import { SocialReader } from "../../vendor/social-reader/reader.mjs";
import { safeFetch } from "../../vendor/social-reader/safe-fetch.js";
import { WEB_FETCH_DOWNLOAD_CHARS, webPage } from "./web-text.mjs";
import { recallBoundary, recallPage } from "../core/recall-boundary.mjs";
import {
  markPersonCardShown,
  personCardSeenKey,
} from "../core/person-cards.mjs";
function track(ctx, items) {
  for (const row of items) {
    trackPeerQzone(ctx, row);
    trackSocial(ctx, row);
    for (const item of [
      ...(row.scene?.messages || []),
      ...(row.scene?.quoted || []),
    ]) {
      trackPeerQzone(ctx, item);
      trackSocial(ctx, item);
    }
    for (const item of [
      row,
      ...(row.scene?.messages || []),
      ...(row.scene?.quoted || []),
    ])
      for (const repo of item.protectedRepositories || [])
        ctx.privateRead.add(githubMarker(repo));
    if (row.id) ctx.privateRead.add(row.id);
    for (const m of [
      ...(row.scene?.messages || []),
      ...(row.scene?.quoted || []),
    ])
      if (m.id) ctx.privateRead.add(m.id);
    if (row.protectedOperations)
      ctx.privateRead.add(
        (row.type === "diary" ? "operations:diary:" : "operations:event:") +
          row.id,
      );
    if (
      [
        "agent-judged-recollection",
        "agent-judged-diary",
        "private-recollection-do-not-disclose",
      ].includes(row.disclosure)
    ) {
      ctx.privateRead.add(row.id);
      for (const m of [
        ...(row.scene?.messages || []),
        ...(row.scene?.quoted || []),
      ])
        ctx.privateRead.add(m.id);
    }
  }
  ctx.persistTaint?.();
}

async function handle_memory_search(runtime, ctx, args, name) {
  const mem = runtime.memory.bind(ctx.agentId);

  const r = recallPage(runtime, ctx, mem.search(args, ctx.conversation));
  track(ctx, [...r.items, ...r.diaries]);
  return r;
}
async function handle_memory_related(runtime, ctx, args, name) {
  const mem = runtime.memory.bind(ctx.agentId);

  const boundary = recallBoundary(runtime, ctx);
  boundary.assert(mem.readRecord({ id: args.id }, ctx.conversation));
  const r = mem.related(args, ctx.conversation);
  r.items = r.items
    .filter((x) => boundary.allowed(x.record))
    .map((x) => ({
      ...x,
      links: x.links?.filter((link) => boundary.allowed({ id: link.toId })),
    }));
  track(
    ctx,
    r.items.map((x) => x.record),
  );
  return r;
}
async function handle_memory_read(runtime, ctx, args, name) {
  const mem = runtime.memory.bind(ctx.agentId);

  const item = mem.readRecord(args, ctx.conversation);
  recallBoundary(runtime, ctx).assert(item);
  let version;
  const r = mem.read(args, ctx.conversation, {
    item,
    captureVersion: (value) => {
      version = value;
    },
  });
  track(ctx, [r]);
  const pages = (ctx.inputPages ??= new Map());
  const old = pages.get(r.id);
  const continues =
    r.offset === 0 || (old?.offset === r.offset && old.version === version);
  if (!continues) {
    if (old && old.version !== version) {
      pages.delete(r.id);
      return {
        ...r,
        presentationRestart: { tool: "memory_read", id: r.id, offset: 0 },
      };
    }
    return r;
  }
  if (r.nextOffset === null) {
    if (
      item.conversation === ctx.conversation &&
      Number.isSafeInteger(item.seq)
    ) {
      const staged = runtime.contexts.stageSeen(ctx, [item]);
      const inputRefs = [...staged.proofs].map(([id, version]) => ({
        id,
        version,
      }));
      const result = {
        ...r,
        ...staged.checkpoint,
        ...(inputRefs.length ? { inputRefs } : {}),
      };
      runtime.stageToolInput(ctx, result, () => {
        pages.delete(r.id);
        runtime.contexts.commitSeen(ctx, staged);
      });
      return result;
    }
  } else {
    runtime.stageToolInput(ctx, r, () => {
      pages.delete(r.id);
      if (pages.size === 10) pages.delete(pages.keys().next().value);
      pages.set(r.id, { version, offset: r.nextOffset });
    });
  }
  return r;
}
async function handle_conversation_read(runtime, ctx, args, name) {
  const mem = runtime.memory.bind(ctx.agentId);

  if (args.aroundId)
    recallBoundary(runtime, ctx).assert(
      mem.readRecord({ id: args.aroundId }, ctx.conversation),
    );
  const r = recallPage(
    runtime,
    ctx,
    mem.conversation(
      { conversation: ctx.conversation, ...args },
      ctx.conversation,
    ),
  );
  track(ctx, r.items);
  if (!r.markReadEligible) {
    if (r.items.some((item) => item.conversation === ctx.conversation))
      rememberSources(mem, ctx.conversation, r.items);
    return r;
  }
  const staged = runtime.contexts.stageSeen(ctx, r.items);
  const result = { ...r, ...staged.checkpoint };
  runtime.stageToolInput(ctx, result, () => {
    runtime.contexts.commitSeen(ctx, staged);
    ctx.conversationPageThroughSeq = Math.max(
      ctx.conversationPageThroughSeq || 0,
      r.items.at(-1)?.seq || 0,
    );
  });
  return result;
}
async function handle_diary_write(runtime, ctx, args, name) {
  const mem = runtime.memory.bind(ctx.agentId);

  const protectedOperations = [...ctx.privateRead].some((id) =>
    /^(operations|operations-result):/.test(id),
  );
  return name === "diary_write"
    ? mem.diaryWrite(
        args,
        "ai-diary",
        {
          conversation: ctx.conversation,
          connectionId: runtime.agent(ctx.agentId).connectionId,
        },
        protectedOperations,
        privateGithubSources(ctx, runtime),
        peerQzoneSources(runtime, ctx),
        socialSources(runtime, ctx),
      )
    : mem.diaryRevise(
        args,
        protectedOperations,
        privateGithubSources(ctx, runtime),
        peerQzoneSources(runtime, ctx),
        socialSources(runtime, ctx),
      );
}
function assertReadCheckpoint(runtime, ctx, throughSeq) {
  if (
    !Number.isSafeInteger(throughSeq) ||
    throughSeq < 0 ||
    !Number.isSafeInteger(ctx.shownSeq) ||
    ctx.shownSeq < 0 ||
    throughSeq > presentationCheckpoint(runtime, ctx).readThroughSeq
  )
    throw Error("UNSEEN_WATERMARK");
}
function readCheckpointToolEnabled(runtime, ctx) {
  // Proactive delivery rewrites requestId to its selected intent's ledger key.
  // Keep this shortcut on ordinary replies so a duplicate intent cannot acquire
  // a new checkpoint through a different model-supplied requestId.
  if (ctx.activeIntentId) return false;
  return (
    ctx.allowedTools ||
    runtime.toolsFor(runtime.agent(ctx.agentId), ctx.conversation)
  ).includes("qq_mark_read");
}
function readCheckpointReceipts(mem, conversation) {
  const receipts = mem.state(conversation).readCheckpointReceipts;
  if (receipts == null) return {};
  if (typeof receipts !== "object" || Array.isArray(receipts))
    throw Error("READ_CHECKPOINT_STATE_INVALID");
  return receipts;
}
function saveReadCheckpointIntent(
  mem,
  conversation,
  requestId,
  throughSeq,
  shownSeq,
) {
  const state = mem.state(conversation),
    previous = state.readCheckpointReceipts || {},
    intent = { throughSeq, shownSeq },
    entries = [
      ...Object.entries(previous).filter(([key]) => key !== requestId),
      [requestId, intent],
    ];
  let next = Object.fromEntries(entries);
  if (entries.length > 100) next = Object.fromEntries(entries.slice(-100));
  mem.setState(conversation, { ...state, readCheckpointReceipts: next });
  return intent;
}
function saveReadCheckpointReceipt(
  mem,
  conversation,
  requestId,
  intent,
  receipt,
) {
  const state = mem.state(conversation),
    previous = state.readCheckpointReceipts || {};
  if (!Object.hasOwn(previous, requestId)) return false;
  const saved = previous[requestId];
  if (
    saved.throughSeq !== intent.throughSeq ||
    saved.shownSeq !== intent.shownSeq
  )
    return false;
  if (saved.sentReceipt === true) return true;
  const next = Object.fromEntries(
    Object.entries(previous).map(([key, value]) => [
      key,
      key === requestId
        ? {
            ...value,
            sentReceipt: true,
            recordId: receipt.recordId || null,
          }
        : value,
    ]),
  );
  mem.setState(conversation, { ...state, readCheckpointReceipts: next });
  return true;
}
function checkpointFromIntent(intent) {
  if (
    !intent ||
    !Number.isSafeInteger(intent.throughSeq) ||
    intent.throughSeq < 0 ||
    !Number.isSafeInteger(intent.shownSeq) ||
    intent.throughSeq > intent.shownSeq
  )
    return null;
  return { throughSeq: intent.throughSeq };
}
async function handle_qq_send(runtime, ctx, args, name) {
  if (args.readThroughSeq !== undefined) {
    if (!readCheckpointToolEnabled(runtime, ctx))
      throw Error("TOOL_NOT_ALLOWED");
    assertReadCheckpoint(runtime, ctx, args.readThroughSeq);
  }
  const mem = runtime.memory.bind(ctx.agentId);
  const receipt = await sendDraftTool(runtime, ctx, "qq_send", args, {
    onReserve: () => {
      if (args.readThroughSeq !== undefined) {
        assertReadCheckpoint(runtime, ctx, args.readThroughSeq);
        saveReadCheckpointIntent(
          mem,
          ctx.conversation,
          args.requestId,
          args.readThroughSeq,
          ctx.shownSeq,
        );
      }
    },
  });
  if (receipt.status !== "sent") return receipt;
  const receipts = readCheckpointReceipts(mem, ctx.conversation);
  const intent = Object.hasOwn(receipts, args.requestId)
    ? receipts[args.requestId]
    : null;
  const checkpoint = checkpointFromIntent(intent);
  const readCheckpoint =
    intent && Number.isSafeInteger(intent.throughSeq) && intent.throughSeq >= 0
      ? { throughSeq: intent.throughSeq, applied: false }
      : null;
  let result = readCheckpoint ? { ...receipt, readCheckpoint } : receipt;
  if (checkpoint) {
    if (!readCheckpointToolEnabled(runtime, ctx)) return result;
    try {
      if (
        !saveReadCheckpointReceipt(
          mem,
          ctx.conversation,
          args.requestId,
          intent,
          receipt,
        )
      )
        return result;
    } catch {
      return result;
    }
    try {
      runtime.assertActive(ctx);
    } catch {
      return result;
    }
    try {
      assertReadCheckpoint(runtime, ctx, checkpoint.throughSeq);
      processInput(runtime, ctx, checkpoint.throughSeq);
      readCheckpoint.applied = true;
    } catch {
      return result;
    }
  }
  if (!args.atUserId) return result;
  // Someone addressed before they spoke here has not had their card shown.
  // It comes once with the receipt, so the rest of the turn can use it.
  const saved = mem.identity.personCard(args.atUserId),
    card = saved
      ? withInteraction(
          mem,
          saved,
          runtime.now(),
          runtime.connection(runtime.agent(ctx.agentId).connectionId).accountId,
        )
      : null;
  if (
    !card ||
    // The same seen key as person-cards.mjs: this card, at this revision.
    mem.state(ctx.conversation).personCardsShown?.[card.personId] ===
      personCardSeenKey(card)
  )
    return result;
  markPersonCardShown(mem, ctx.conversation, card);
  return {
    ...result,
    personCard: {
      personId: card.personId,
      call: card.call,
      impression: card.body,
      interaction: card.interaction,
      ...(card.adminCloseness ? { adminCloseness: card.adminCloseness } : {}),
      ...(card.recalledEvidence?.length
        ? { recalledEvidence: card.recalledEvidence }
        : {}),
      revision: card.revision,
    },
  };
}
async function handle_generated_image_list(runtime, ctx, args, name) {
  const recovery = await runtime.generatedImages.recover(ctx, args);
  return { ...runtime.generatedImages.list(ctx, args), ...recovery };
}
async function handle_qq_mark_read(runtime, ctx, args, name) {
  assertReadCheckpoint(runtime, ctx, args.throughSeq);
  return processInput(runtime, ctx, args.throughSeq, args.noReply);
}
async function handle_qq_set_silence(runtime, ctx, args, name) {
  const mem = runtime.memory.bind(ctx.agentId);

  const state = mem.state(ctx.conversation);
  state.silenceUntil = runtime.now() + args.minutes * 60000;
  mem.setState(ctx.conversation, state);
  if (args.minutes > 0) ctx.selfSilenced = true;
  return { silenceUntil: state.silenceUntil };
}
async function handle_qq_image_read(runtime, ctx, args, name) {
  const mem = runtime.memory.bind(ctx.agentId);

  const row = mem.db
    .prepare("SELECT * FROM events WHERE id=? AND agent_id=?")
    .get(args.id, ctx.agentId);
  if (!row) throw Error("RECORD_NOT_FOUND");
  const event = mem.event(row, ctx.conversation);
  recallBoundary(runtime, ctx).assert(event);
  track(ctx, [event]);
  const media = await readEventImage(runtime, ctx, event, args);
  runtime.assertActive(ctx);
  recallBoundary(runtime, ctx).assert(
    runtime.media.metadata(ctx.agentId, media.id),
  );
  taintMedia(ctx, runtime.media.metadata(ctx.agentId, media.id));
  return runtime.media.view(
    ctx.agentId,
    media.id,
    args.animation,
    ctx.controller.signal,
  );
}
async function handle_sticker_list(runtime, ctx, args, name) {
  const rows = recallBoundary(runtime, ctx).rows(
    runtime.media.list(ctx.agentId, args.query || ""),
  );
  rows.forEach((m) => taintMedia(ctx, m));
  return rows;
}
async function handle_sticker_collect(runtime, ctx, args, name) {
  const meta = runtime.media.metadata(ctx.agentId, args.mediaId);
  recallBoundary(runtime, ctx).assert(meta);
  taintMedia(ctx, meta);
  if (
    socialSources(runtime, ctx).length ||
    peerQzoneSources(runtime, ctx).length
  )
    throw Error("RESTRICTED_CONTEXT_MIND_WRITE_BLOCKED");
  return runtime.media.collect(ctx.agentId, args.mediaId, args);
}
async function handle_sticker_read(runtime, ctx, args, name) {
  const meta = runtime.media.metadata(ctx.agentId, args.mediaId);
  taintMedia(ctx, meta);
  const result = await runtime.media.view(
    ctx.agentId,
    args.mediaId,
    args.animation,
    ctx.controller.signal,
  );
  if (meta?.homeScene)
    result[mediaLease] = () => {
      try {
        runtime.assertActive(ctx);
        assertHomeSceneMedia(runtime, ctx, meta);
        return true;
      } catch {
        return false;
      }
    };
  return result;
}
async function handle_voice_synthesize(runtime, ctx, args, name) {
  return synthesize(runtime, ctx, args);
}
async function handle_external_tools(runtime, ctx, args, name) {
  const backend = runtime.backends.get(ctx.agentId);
  if (!backend?.external) throw Error("EXTERNAL_TOOLS_UNAVAILABLE");
  const result = await backend.external.list(args.serverId, args.offset);
  return {
    ...result,
    callFormat: {
      name: "external_tool",
      arguments: {
        serverId: "<server id>",
        tool: "<tool name>",
        arguments: {},
      },
    },
    ...(ctx.conversation === "@subject"
      ? {
          subjectReadAllowlist: runtime.agent(ctx.agentId).subject
            .externalReads,
        }
      : {}),
  };
}
async function handle_social_status(runtime, ctx, args, name) {
  runtime.social ??= new SocialReader();
  return runtime.social.status();
}
async function handle_web_fetch(runtime, ctx, args, name) {
  // dispatchTool has validated the selector schema before authorization.
  if (
    name === "external_tool" &&
    ctx.conversation === "@subject" &&
    !runtime
      .agent(ctx.agentId)
      .subject.externalReads.some(
        (x) => x.serverId === args.serverId && x.tool === args.tool,
      )
  )
    throw Error("SUBJECT_EXTERNAL_TOOL_NOT_READ_ALLOWED");
  const request =
    name === "web_fetch"
      ? { tool: name, args: { url: args.url } }
      : {
          tool: name,
          args: Object.fromEntries(
            Object.entries(args).filter(([k]) => k !== "requestEventId"),
          ),
        };
  const outbound =
    name === "external_tool" ? externalArguments(runtime, ctx, args) : null;
  runtime.authorizeExternal(ctx, request, {
    requestEventId: args.requestEventId,
  });
  if (name === "web_fetch") {
    // The download limit is separate from the page window, so offset pages
    // through the same extracted text. offset/mode stay local and never enter
    // the authorization request above.
    const page = await (runtime.fetchPublicPage || safeFetch)(
      args.url,
      WEB_FETCH_DOWNLOAD_CHARS,
      {
        authorize: (url) =>
          runtime.authorizeExternal(
            ctx,
            { tool: name, args: { url } },
            // Redirect targets come from this authorized fetch, never from model parameters.
            { fixed: true },
          ),
      },
    );
    return webPage(page, {
      offset: args.offset,
      maxChars: args.maxChars,
      mode: args.mode,
    });
  }
  runtime.social ??= new SocialReader();
  if (name === "social_search") return runtime.social.perform("search", args);
  if (name === "social_read") return runtime.social.perform("read", args);
  if (name === "social_comments")
    return runtime.social.perform("comments", args);
  const backend = runtime.backends.get(ctx.agentId);
  if (!backend?.external) throw Error("EXTERNAL_TOOLS_UNAVAILABLE");
  const result = await backend.external.call(
    args.serverId,
    args.tool,
    outbound,
  );
  runtime.assertActive(ctx);
  return externalResult(runtime, ctx, args, result);
}
export const coreHandlers = {
  memory_search: handle_memory_search,
  memory_related: handle_memory_related,
  memory_read: handle_memory_read,
  conversation_read: handle_conversation_read,
  diary_write: handle_diary_write,
  diary_revise: handle_diary_write,
  qq_send: handle_qq_send,
  qq_recall: recallMessage,
  qq_delivery_status: (runtime, ctx, args) =>
    deliveryPage(runtime.memory.bind(ctx.agentId), ctx.conversation, args),
  generated_image_list: handle_generated_image_list,
  qq_mark_read: handle_qq_mark_read,
  qq_set_silence: handle_qq_set_silence,
  qq_image_read: handle_qq_image_read,
  sticker_list: handle_sticker_list,
  sticker_collect: handle_sticker_collect,
  sticker_read: handle_sticker_read,
  voice_synthesize: handle_voice_synthesize,
  external_tools: handle_external_tools,
  social_status: handle_social_status,
  web_fetch: handle_web_fetch,
  social_search: handle_web_fetch,
  social_read: handle_web_fetch,
  social_comments: handle_web_fetch,
  external_tool: handle_web_fetch,
};
