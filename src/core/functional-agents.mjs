// @ts-check

export const MEMORY_AGENT_TOOLS = Object.freeze(
  /** @type {const} */ (["memory_search", "memory_read", "memory_related"]),
);
export const MEMORY_AGENT_LIMITS = Object.freeze({
  timeoutMs: 10000,
  maxLookups: 3,
});

const subjectDefinition = Object.freeze({
  kind: /** @type {const} */ ("subject"),
});
const qqDefinition = Object.freeze({
  kind: /** @type {const} */ ("qq-dialogue"),
});

/** @typedef {ReturnType<typeof import("./config.mjs").validateConfig>["agents"][number]} Role */

/**
 * Resolve a functional identity while leaving the caller's data scope intact.
 * @param {Role} role
 * @param {string} conversation
 * @param {"subject" | "qq" | "memory"} [key]
 */
export function resolveFunctionalAgent(role, conversation, key) {
  const ordinaryKey =
    conversation === "@subject"
      ? "subject"
      : /^(group|private):\d+$/.test(conversation)
        ? "qq"
        : undefined;
  if (!ordinaryKey) return undefined;
  key ??= ordinaryKey;
  if (key === "memory") {
    const definition = role.functionalAgents?.memory;
    if (definition?.enabled !== true) return undefined;
    // Reuse the role's memory identity without turning it into a data scope.
    return {
      key,
      kind: definition.kind,
      instanceKey: `${role.id}/memory/@memory`,
      definition,
    };
  }
  if (key !== ordinaryKey) return undefined;
  const definition =
    role.functionalAgents?.[key] ??
    (key === "subject" ? subjectDefinition : qqDefinition);
  return {
    key,
    kind: definition.kind,
    instanceKey: `${role.id}/${key}/${conversation}`,
    definition,
  };
}
