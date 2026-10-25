import { RESTRICTED_TOOL_NAMES } from "../../vendor/dsh-qq/qq-tool-restrict.mjs";
import { TOOL_NAMES } from "../tools/index.mjs";
export const name = "qq-unified-tool-guard";
export const inject = ["tools"];
export function installGuard(ctx, blocked, allowed) {
  for (const name of blocked) {
    try {
      ctx.tools.restrict({ deny: [name] });
    } catch {
      /* Absent names vary by DSH version; execution guard remains authoritative. */
    }
  }
  const allow = new Set(allowed);
  ctx.tools.guard((exec) =>
    allow.has(exec?.name)
      ? undefined
      : "Tool is outside the QQ Unified preset allowlist",
  );
}
export function apply(ctx) {
  installGuard(
    ctx,
    RESTRICTED_TOOL_NAMES,
    TOOL_NAMES.map((t) => "mcp__qq-unified__" + t),
  );
}
