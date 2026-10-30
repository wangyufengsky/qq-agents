// @ts-check
import { createHash } from "node:crypto";

/**
 * Parsed config shapes (src/core/config.mjs); schema defaults are always present.
 * @typedef {{id: string, transport: "stdio" | "http" | "sse", command?: string, url?: string,
 *   headers: Record<string, string>, args: string[], env: Record<string, string>,
 *   allowedTools: string[]}} ToolServerConfig
 * @typedef {{id: string, type: "dsh" | "codex" | "openai" | "antigravity", label: string, provider: string,
 *   baseUrl?: string, apiKeyEnv?: string, contextWindow?: number, maxToolRounds?: number,
 *   requestTimeoutMs?: number, vision?: boolean, sendEffort?: boolean,
 *   recovery: {autoReconnect: boolean, dshInstance?: string}, command: string,
 *   env?: Record<string, string>, home?: string, preset: string, model: string, effort: string,
 *   toolServers: ToolServerConfig[]}} BackendConfig
 * @typedef {{id: string}} BackendAgent
 * @typedef {{onDisconnect?: (error: Error) => void}} DisconnectHook Assigned by BackendConnections.
 * @typedef {{backend: string, id: string, signature: string}} StoredSession
 * @typedef {{name: string, description?: string, inputSchema?: object}} ToolSpec
 * @typedef {{source: string, contextTokens: number, capacityTokens?: number,
 *   cumulativeTokens?: number, basis: string}} UsageReport
 * @typedef {{conversation?: string, protectedWork?: boolean, prompt: string, instructions?: string,
 *   onUsage?: (usage: UsageReport) => void, signal: AbortSignal, tools: ToolSpec[],
 *   callTool: (name: string, args: any) => Promise<unknown>, session?: StoredSession | null,
 *   saveSession: (session: StoredSession | null) => void,
 *   onBackendTurn?: (turn: {turnId: string}) => void,
 *   recovery?: import("./turn-failure.mjs").RecoveryFailure,
 *   onImageSession?: (sessionId: string) => void,
 *   onGeneratedImage?: (sessionId: string, item: any) => void,
 *   onImageError?: () => void}} RunParams
 */

// JSON object order is not protocol semantics. Array order remains significant,
// except for the tool catalogue, which is a set keyed by name.
/** @param {any} value @returns {any} */
export function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .filter((k) => value[k] !== undefined)
        .map((k) => [k, canonical(value[k])]),
    );
  return value;
}
/** @param {{config: BackendConfig}} backend @param {ToolSpec[]} [tools] */
export function sessionSignature(backend, tools = []) {
  return (
    "contract-v2:" +
    createHash("sha256")
      .update(
        JSON.stringify(
          canonical({
            backend: {
              ...backend.config,
              recovery: undefined,
              ...(backend.config.recovery?.dshInstance
                ? { dshInstance: backend.config.recovery.dshInstance }
                : {}),
            },
            tools: tools
              .map(({ name, description, inputSchema }) => ({
                name,
                description,
                inputSchema,
              }))
              .sort((a, b) => a.name.localeCompare(b.name)),
          }),
        ),
      )
      .digest("hex")
  );
}
/** @param {StoredSession | null | undefined} session @param {string} backend @param {string} signature */
export function assertSession(session, backend, signature) {
  if (
    session &&
    (session.backend !== backend || session.signature !== signature)
  )
    throw Error("SESSION_REQUIRES_HANDOFF");
}
