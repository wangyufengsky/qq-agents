// @ts-check
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

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
 * @typedef {{backend: string, id: string, signature: string, nativeSignature?: string}} StoredSession
 * @typedef {{name: string, description?: string, inputSchema?: object}} ToolSpec
 * @typedef {{source: string, contextTokens: number, capacityTokens?: number,
 *   cumulativeTokens?: number, basis: string}} UsageReport
 * @typedef {{conversation?: string, protectedWork?: boolean, prompt: string, instructions?: string,
 *   onUsage?: (usage: UsageReport) => void, signal: AbortSignal, tools: ToolSpec[],
 *   callTool: (name: string, args: any) => Promise<unknown>, session?: StoredSession | null,
 *   saveSession: (session: StoredSession | null) => void,
 *   onBackendTurn?: (turn: {turnId: string, inputAccepted?: boolean}) => void,
 *   onInputSubmitted?: () => void,
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
/** @param {unknown} value */
const digest = (value) =>
  createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex");
/** Only session identity and execution authority belong in the native contract.
 * Per-request settings are read when the next turn starts.
 * @param {BackendConfig} config */
export function backendSessionConfig(config) {
  const { id, type, model, toolServers } = config;
  const shared = { id, type, model, toolServers };
  switch (type) {
    case "dsh":
      return {
        ...shared,
        baseUrl: config.baseUrl,
        dshInstance: config.recovery?.dshInstance,
        provider: config.provider,
        preset: config.preset,
      };
    case "codex":
      return {
        ...shared,
        command: config.command,
        home: config.home,
        env: config.env,
      };
    case "openai":
      return {
        ...shared,
        baseUrl: config.baseUrl,
        apiKeyEnv: config.apiKeyEnv,
        vision: config.vision === true,
      };
    case "antigravity":
      return { ...shared, command: config.command };
  }
}
/** @param {BackendConfig} config */
export function effectiveBackendConfig(config) {
  return config.type === "openai" ? { ...OPENAI_DEFAULTS, ...config } : config;
}
export const OPENAI_DEFAULTS = {
  maxToolRounds: 32,
  requestTimeoutMs: 180000,
  vision: false,
  sendEffort: false,
};
/** @param {BackendConfig} config */
export function backendRequestConfig(config) {
  return {
    effort: config.effort,
    ...(config.type === "openai"
      ? {
          contextWindow: config.contextWindow,
          maxToolRounds: config.maxToolRounds ?? OPENAI_DEFAULTS.maxToolRounds,
          requestTimeoutMs:
            config.requestTimeoutMs ?? OPENAI_DEFAULTS.requestTimeoutMs,
          sendEffort: config.sendEffort ?? OPENAI_DEFAULTS.sendEffort,
        }
      : {}),
  };
}
/** Strip annotations only at schema nodes, never a property named description.
 * @param {any} schema @returns {any} */
export function toolSchema(schema) {
  if (!schema || typeof schema !== "object" || Array.isArray(schema))
    return schema;
  const {
    description: _d,
    title: _t,
    examples: _e,
    $comment: _c,
    ...result
  } = schema;
  for (const key of ["properties", "$defs", "definitions", "patternProperties"])
    if (result[key])
      result[key] = Object.fromEntries(
        Object.entries(result[key]).map(([name, value]) => [
          name,
          toolSchema(value),
        ]),
      );
  for (const key of [
    "items",
    "additionalProperties",
    "not",
    "if",
    "then",
    "else",
  ])
    if (result[key]) result[key] = toolSchema(result[key]);
  for (const key of ["anyOf", "oneOf", "allOf", "prefixItems"])
    if (Array.isArray(result[key])) result[key] = result[key].map(toolSchema);
  if (Array.isArray(result.required))
    result.required = [...result.required].sort();
  return canonical(result);
}
/** @typedef {{version: 1, backend: string, tools: {name: string, inputSchema: any}[]}} SessionContract */
/** @param {{config: BackendConfig}} backend @param {ToolSpec[]} tools @returns {SessionContract} */
export function sessionContract(backend, tools) {
  return {
    version: 1,
    backend: digest(backendSessionConfig(backend.config)),
    tools: tools
      .map(({ name, inputSchema }) => ({
        name,
        inputSchema: toolSchema(inputSchema),
      }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  };
}
/** @param {{sessionProtocol?: string}} backend */
const prefix = (backend) =>
  backend.sessionProtocol ? backend.sessionProtocol + ":" : "";
/** @param {{config: BackendConfig, sessionProtocol?: string}} backend @param {ToolSpec[]} [tools] @param {number} [version] */
export function legacySessionSignature(backend, tools = [], version = 3) {
  return (
    prefix(backend) +
    `contract-v${version}:` +
    digest({
      backend: {
        ...backend.config,
        ...(version === 3 ? { label: undefined } : {}),
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
    })
  );
}
/** @param {{config: BackendConfig, sessionProtocol?: string}} backend @param {ToolSpec[]} [tools] @param {boolean} [legacy] */
export function sessionSignature(backend, tools = [], legacy = false) {
  return legacy
    ? legacySessionSignature(backend, tools, 2)
    : prefix(backend) +
        "contract-v4:" +
        digest(sessionContract(backend, tools));
}
/** Accept only additive optional object fields: every old call must remain valid.
 * Unknown schema transformations and permission changes still require handoff.
 * @param {any} before @param {any} after @returns {boolean} */
function compatibleSchema(before, after) {
  if (isDeepStrictEqual(before, after)) return true;
  if (
    before?.type !== "object" ||
    after?.type !== "object" ||
    before.additionalProperties !== false ||
    !before.properties ||
    !after.properties
  )
    return false;
  const { properties: oldProperties, ...oldRest } = before;
  const { properties: newProperties, ...newRest } = after;
  return (
    isDeepStrictEqual(oldRest, newRest) &&
    Object.entries(oldProperties).every(
      ([key, value]) =>
        Object.hasOwn(newProperties, key) &&
        compatibleSchema(value, newProperties[key]),
    )
  );
}
/** Accept an old digest only when its entire original contract still matches.
 * This upgrades metadata without discarding a valid pre-upgrade transcript.
 * @param {{config: BackendConfig, sessionProtocol?: string}} backend @param {StoredSession | null | undefined} session @param {ToolSpec[]} tools @param {SessionContract} [previous] */
export function acceptsSession(backend, session, tools, previous) {
  const next = sessionContract(backend, tools);
  return (
    !!session &&
    session.backend === backend.config.type &&
    (session.signature === sessionSignature(backend, tools) ||
      session.signature === legacySessionSignature(backend, tools) ||
      session.signature === sessionSignature(backend, tools, true) ||
      (previous?.version === 1 &&
        session.signature ===
          prefix(backend) + "contract-v4:" + digest(previous) &&
        previous.backend === next.backend &&
        previous.tools.length === next.tools.length &&
        previous.tools.every(
          (tool, index) =>
            tool.name === next.tools[index].name &&
            compatibleSchema(tool.inputSchema, next.tools[index].inputSchema),
        )))
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
