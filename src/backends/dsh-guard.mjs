// @ts-check
import { RESTRICTED_TOOL_NAMES } from "../../vendor/dsh-qq/qq-tool-restrict.mjs";
import { MCP_ENTRY_NAMES } from "../tools/catalog.mjs";
export const name = "qq-unified-tool-guard";
export const inject = ["tools"];
/**
 * @typedef {{tools: {restrict(rule: {deny: string[]}): void,
 *   guard(check: (exec: {name?: string} | undefined) => string | undefined): void}}} GuardContext
 */
/** @param {GuardContext} ctx @param {Iterable<string>} blocked @param {Iterable<string>} allowed */
export function installGuard(ctx, blocked, allowed) {
  for (const name of blocked) {
    try {
      ctx.tools.restrict({ deny: [name] });
    } catch {
      /* Absent names vary by DSH version; execution guard remains authoritative. */
    }
  }
  /** @type {Set<unknown>} */
  const allow = new Set(allowed);
  ctx.tools.guard((exec) =>
    allow.has(exec?.name)
      ? undefined
      : "Tool is outside the QQ Unified preset allowlist",
  );
}
/** @param {GuardContext} ctx */
export function apply(ctx) {
  installGuard(
    ctx,
    RESTRICTED_TOOL_NAMES,
    MCP_ENTRY_NAMES.map((t) => "mcp__qq-unified__" + t),
  );
}
