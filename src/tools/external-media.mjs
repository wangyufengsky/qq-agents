import { audioType } from "./voice.mjs";
import { taintMedia } from "./legacy.mjs";
const encodedLimit = 28 * 1024 * 1024;
function bytes(item) {
  const data = item.data ?? item.blob;
  if (
    typeof data !== "string" ||
    !data.length ||
    data.length > encodedLimit ||
    data.length % 4 !== 0 ||
    /[^A-Za-z0-9+/=]/.test(data) ||
    (data.includes("=") && !/^[^=]*={1,2}$/.test(data))
  )
    throw Error("INVALID_EXTERNAL_MEDIA");
  return Buffer.from(data, "base64");
}
export function externalArguments(runtime, ctx, args) {
  const input = { ...args.arguments };
  if (args.audioInput) {
    const { audioId, dataArgument, mimeArgument } = args.audioInput;
    for (const k of [dataArgument, mimeArgument].filter(Boolean))
      if (
        ["__proto__", "constructor", "prototype"].includes(k) ||
        Object.hasOwn(input, k)
      )
        throw Error("EXTERNAL_INPUT_COLLISION");
    if (dataArgument === mimeArgument) throw Error("EXTERNAL_INPUT_COLLISION");
    taintMedia(ctx, runtime.voices.metadata(ctx.agentId, audioId));
    ctx.privateRead.add("audio:" + audioId);
    ctx.persistTaint?.();
    runtime.authorizeExternal(
      ctx,
      {
        tool: "external_tool",
        args: {
          serverId: args.serverId,
          tool: args.tool,
          arguments: args.arguments || {},
          audioInput: args.audioInput,
        },
      },
      { requestEventId: args.requestEventId },
    );
    const audio = runtime.voices.read(ctx.agentId, audioId);
    input[dataArgument] = audio.data;
    if (mimeArgument) input[mimeArgument] = audio.mimeType;
  }
  return input;
}
export async function externalResult(runtime, ctx, args, result) {
  const content = [];
  let textLeft = 16000,
    mediaCount = 0;
  const addText = (text) => {
    if (textLeft > 0) {
      content.push({ type: "text", text: String(text).slice(0, textLeft) });
      textLeft -= String(text).length;
    }
  };
  if (result.structuredContent)
    addText(
      JSON.stringify({
        structuredContent: result.structuredContent,
        untrusted: true,
      }),
    );
  for (const block of result.content || []) {
    const item = block.type === "resource" ? block.resource : block;
    if (block.type === "text") {
      addText(block.text);
      continue;
    }
    if (result.isError) continue; // Error payloads cannot mint sendable media.
    const image =
      block.type === "image" ||
      (block.type === "resource" && item.mimeType?.startsWith("image/"));
    const audio =
      block.type === "audio" ||
      (block.type === "resource" && item.mimeType?.startsWith("audio/"));
    if (!image && !audio) {
      if (block.type === "resource_link")
        addText(
          JSON.stringify({
            unsupportedResourceLink: true,
            name: block.name,
            notice:
              "Ask the configured server for embedded bytes; URL is not a registered media ID.",
          }),
        );
      continue;
    }
    if (++mediaCount > 4) throw Error("EXTERNAL_MEDIA_LIMIT");
    const meta = {
      generatedBy: args.serverId + ":" + args.tool,
      conversation: ctx.conversation,
      sourceType: "external-tool-result",
      untrusted: true,
      protectedOperations: [...(ctx.privateRead || [])].some((id) =>
        /^(operations|operations-result|github-private):/.test(id),
      ),
    };
    if (image) {
      const m = runtime.media.put(
        ctx.agentId,
        bytes(item),
        item.mimeType,
        meta,
      );
      addText(JSON.stringify({ generatedMedia: m }));
      content.push(runtime.media.read(ctx.agentId, m.id));
    } else {
      const buffer = bytes(item),
        mime = audioType(buffer)[1];
      if (
        mime !== item.mimeType &&
        !(mime === "audio/wav" && item.mimeType === "audio/x-wav")
      )
        throw Error("AUDIO_MIME_MISMATCH");
      const a = runtime.agent(ctx.agentId),
        m = await runtime.voices.put(ctx.agentId, buffer, a.voice, {
          ...meta,
          title: "外部工具音频",
        });
      addText(JSON.stringify({ generatedAudio: m }));
      content.push(runtime.voices.read(ctx.agentId, m.id));
    }
    runtime.assertActive(ctx);
  }
  return { content, isError: !!result.isError };
}
