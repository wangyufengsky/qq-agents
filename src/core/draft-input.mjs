// @ts-check
import {
  assertMessageAccount,
  resolveMessage,
} from "../memory/message-ids.mjs";
import { fileName } from "../tools/files.mjs";
import { qqMessage } from "../tools/qq-message.mjs";
import { liveInput } from "./live-input.mjs";
import { trackMindRecords } from "./protected-mind.mjs";
import { recallBoundary } from "./recall-boundary.mjs";

/** @param {any} agent @param {string} tool */
export function canUseDraftTool(agent, tool) {
  return (
    ["qq_send", "qq_send_burst", "qq_send_voice", "qq_send_file"].includes(
      tool,
    ) &&
    agent.tools.includes(tool) &&
    (tool !== "qq_send_file" || (agent.files.enabled && agent.files.send))
  );
}

/** @param {any} runtime @param {any} ctx @param {string} toolName */
export function assertDraftTool(runtime, ctx, toolName) {
  const agent = runtime.assertActive(ctx);
  if (
    !/^(private|group):\d+$/.test(ctx.conversation) ||
    !canUseDraftTool(agent, toolName) ||
    (ctx.allowedTools && !ctx.allowedTools.includes(toolName))
  )
    throw Error("TOOL_DISABLED");
  return agent;
}

/** @param {any} runtime @param {any} ctx @param {import("../memory/qq-drafts.mjs").DraftScope} scope @param {string} toolName @param {any} input */
export function validateDraftInput(
  runtime,
  ctx,
  scope,
  toolName,
  input,
  { resolving = true } = {},
) {
  const a = assertDraftTool(runtime, ctx, toolName);
  const mem = runtime.memory.bind(a.id);
  const boundary = recallBoundary(runtime, ctx);
  runtime.assertSafeOutput(ctx, JSON.stringify(input));

  if (toolName === "qq_send_voice" || toolName === "qq_send_file") {
    const file = toolName === "qq_send_file";
    if (file ? !input.fileId : !input.audioId) throw Error("QQ_DRAFT_INVALID");
    const lib = file ? runtime.files : runtime.voices;
    if (!lib)
      throw Error(file ? "FILE_LIBRARY_UNAVAILABLE" : "VOICE_UNAVAILABLE");
    const meta = lib.metadata(a.id, file ? input.fileId : input.audioId);
    boundary.assert(meta);
    trackMindRecords(runtime, ctx, [meta], "draft-media");
    if (!file) {
      runtime.assertSafeOutput(ctx, meta.title || "");
      return input;
    }
    if (meta.bytes > a.files.maxBytes) throw Error("FILE_TOO_LARGE");
    const name = fileName(input.name || meta.name);
    runtime.assertSafeOutput(ctx, name);
    return { fileId: input.fileId, name };
  }

  if (input.audioId || input.fileId) throw Error("QQ_DRAFT_INVALID");
  const burst = toolName === "qq_send_burst";
  if (burst && (input.replyTo || input.atUserId || input.mediaId))
    throw Error("QQ_DRAFT_INVALID");
  const message = qqMessage(input, burst ? 2000 : 8000);
  for (const part of [message.sourceText, message.text, message.body])
    runtime.assertSafeOutput(ctx, part);
  if (!message.segments.length && !input.mediaId) throw Error("EMPTY_MESSAGE");
  if (input.atUserId && !/^\d+$/.test(input.atUserId))
    throw Error("INVALID_PERSON");
  if (input.mediaId) {
    if (!runtime.media) throw Error("MEDIA_UNAVAILABLE");
    const meta = runtime.media.metadata(a.id, input.mediaId);
    boundary.assert(meta);
    trackMindRecords(runtime, ctx, [meta], "draft-media");
  }
  if (!input.replyTo) return input;
  assertMessageAccount(mem, scope.connectionId, scope.accountId);
  const row = resolving
    ? resolveMessage(mem.db, { ...scope, namespace: undefined }, input.replyTo)
    : mem.db
        .prepare(
          `SELECT * FROM events WHERE id=? AND agent_id=? AND connection_id=? AND conversation=?`,
        )
        .get(
          input.replyEventId,
          scope.agentId,
          scope.connectionId,
          scope.conversation,
        );
  if (!row) throw Error("UNKNOWN_REPLY_TARGET");
  const source = mem.event(row, ctx.conversation);
  boundary.assert(source);
  if (
    source.recalled ||
    (row.kind === "message.received" &&
      row.origin === "live" &&
      JSON.parse(row.payload).trustedInput === true &&
      !liveInput(runtime, a.id, ctx.conversation, row.id))
  )
    throw Error("QQ_DRAFT_SOURCE_RECALLED");
  trackMindRecords(runtime, ctx, [source], "draft-reply");
  return { ...input, replyEventId: row.id };
}
