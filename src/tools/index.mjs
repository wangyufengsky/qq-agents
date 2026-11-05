import { mediaLease } from "./media-lease.mjs";
import { registry } from "./registry.mjs";
export { TOOL_NAMES, toolSpecs } from "./specs.mjs";
export async function dispatchTool(runtime, ctx, name, input) {
  const definition = Object.hasOwn(registry, name) ? registry[name] : null;
  if (!definition) throw Error("UNKNOWN_TOOL");
  const args = definition.schema.parse(input);
  if (JSON.stringify(args).includes(ctx.token))
    throw Error("CAPABILITY_EXFILTRATION_BLOCKED");
  return definition.handler(runtime, ctx, args, name);
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
