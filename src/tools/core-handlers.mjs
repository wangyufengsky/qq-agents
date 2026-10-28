import { githubMarker, privateGithubSources } from "../github/policy.mjs";
import { readEventImage } from "./image-read.mjs";
import { synthesize } from "./speech.mjs";
import { externalArguments, externalResult } from "./external-media.mjs";
import { taintMedia } from "./legacy.mjs";
import { SocialReader } from "../../vendor/social-reader/reader.mjs";
import { safeFetch } from "../../vendor/social-reader/safe-fetch.js";
import { recallBoundary, recallPage } from "../core/recall-boundary.mjs";
function track(ctx, items) {
  for (const row of items) {
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

  recallBoundary(runtime, ctx).assert(mem.readRecord(args, ctx.conversation));
  const r = mem.read(args, ctx.conversation);
  track(ctx, [r]);
  const pages = (ctx.inputPages ??= new Map());
  const old = pages.get(r.id);
  const chunk =
    r.offset === 0
      ? r.chunk
      : old?.offset === r.offset
        ? old.chunk + r.chunk
        : null;
  if (chunk !== null) {
    if (r.nextOffset === null) {
      pages.delete(r.id);
      runtime.observeInput(ctx, [JSON.parse(chunk)]);
    } else if (pages.size < 10 && chunk.length <= 2100000)
      pages.set(r.id, { chunk, offset: r.nextOffset });
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
  runtime.contexts.seen(ctx, r.items);
  return r;
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
      )
    : mem.diaryRevise(
        args,
        protectedOperations,
        privateGithubSources(ctx, runtime),
      );
}
async function handle_qq_send(runtime, ctx, args, name) {
  return runtime.send(ctx, args);
}
async function handle_generated_image_list(runtime, ctx, args, name) {
  const recovery = await runtime.generatedImages.recover(ctx, args);
  return { ...runtime.generatedImages.list(ctx, args), ...recovery };
}
async function handle_qq_mark_read(runtime, ctx, args, name) {
  const mem = runtime.memory.bind(ctx.agentId);

  if (args.throughSeq > ctx.shownSeq) throw Error("UNSEEN_WATERMARK");
  const state = mem.state(ctx.conversation);
  state.readThroughSeq = Math.max(state.readThroughSeq || 0, args.throughSeq);
  mem.setState(ctx.conversation, state);
  return { readThroughSeq: state.readThroughSeq };
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
  return runtime.media.collect(ctx.agentId, args.mediaId, args);
}
async function handle_sticker_read(runtime, ctx, args, name) {
  const meta = runtime.media.metadata(ctx.agentId, args.mediaId);
  taintMedia(ctx, meta);
  return runtime.media.view(
    ctx.agentId,
    args.mediaId,
    args.animation,
    ctx.controller.signal,
  );
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
  if (name === "web_fetch")
    return (runtime.fetchPublicPage || safeFetch)(
      args.url,
      args.maxChars || 12000,
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
