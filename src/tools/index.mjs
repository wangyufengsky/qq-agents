import { dreamReadDefinitions, dreamTool } from "./dream.mjs";
import { DREAM_SUBMIT } from "./names.mjs";
import { mediaLease } from "./media-lease.mjs";
import { registry } from "./registry.mjs";
export { TOOL_NAMES, toolSpecs } from "./specs.mjs";
export async function dispatchTool(runtime, ctx, name, input, beforeHandle) {
  const definition = Object.hasOwn(registry, name) ? registry[name] : null;
  if (!definition) throw Error("UNKNOWN_TOOL");
  const dreamRead =
    ctx.runtimeKind === "dream-cognitive" &&
    Object.hasOwn(dreamReadDefinitions, name) &&
    dreamReadDefinitions[name];
  const parsed = (dreamRead ? dreamRead[1] : definition.schema).safeParse(
    input,
  );
  if (!parsed.success && name === DREAM_SUBMIT)
    throw Error("DREAM_INVALID_PATCH");
  if (!parsed.success) throw parsed.error;
  const args = parsed.data;
  if (JSON.stringify(args).includes(ctx.token))
    throw Error("CAPABILITY_EXFILTRATION_BLOCKED");
  beforeHandle?.(args);
  return dreamRead
    ? dreamTool(runtime, ctx, name, args)
    : definition.handler(runtime, ctx, args, name);
}
export function mcpResult(value) {
  if (typeof value?.[mediaLease] === "function") {
    let current = false;
    try {
      current = value[mediaLease]() === true;
    } catch {
      // Revoked observations must not surface their data or validator errors.
    }
    if (!current)
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: JSON.stringify({
              error: "HOME_REVISION_CONFLICT",
              notice:
                "场景观察权限或版本已变化；正文和图片未交付，请重新读取当前场景。",
            }),
          },
        ],
      };
  }
  return value?.content
    ? value
    : {
        ...(typeof value?.[mediaLease] === "function"
          ? { [mediaLease]: value[mediaLease] }
          : {}),
        content: [{ type: "text", text: JSON.stringify(value) }],
      };
}
