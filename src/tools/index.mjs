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
  return value?.content
    ? value
    : { content: [{ type: "text", text: JSON.stringify(value) }] };
}
