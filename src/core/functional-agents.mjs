// @ts-check

export const MEMORY_AGENT_TOOLS = Object.freeze(
  /** @type {const} */ (["memory_search", "memory_read", "memory_related"]),
);
export const MEMORY_AGENT_LIMITS = Object.freeze({
  timeoutMs: 10000,
  maxLookups: 3,
});

/** @typedef {ReturnType<typeof import("./config.mjs").validateConfig>["agents"][number]} Role */
/** @typedef {NonNullable<Role["functionalAgents"]>} Definitions */

/** @typedef {ReturnType<typeof import("./config.mjs").validateConfig>} Configuration */
/** @type {WeakMap<Configuration, Configuration>} */
const functionalConfigVersions = new WeakMap();

/** @param {Configuration} config */
export function functionalConfigVersion(config) {
  return functionalConfigVersions.get(config) ?? config;
}

/** @param {Configuration} before @param {Configuration} saved */
export function retainFunctionalConfigVersion(before, saved) {
  // Surviving scopes have the same policy after a group-only edit.
  // Each lookup still checks the current admission of its parent conversation.
  functionalConfigVersions.set(saved, functionalConfigVersion(before));
}

/** @type {Readonly<NonNullable<Definitions["subject"]>>} */
const subjectDefinition = Object.freeze({
  kind: /** @type {const} */ ("subject"),
});
/** @type {Readonly<NonNullable<Definitions["qq"]>>} */
const qqDefinition = Object.freeze({
  kind: /** @type {const} */ ("qq-dialogue"),
});

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

/**
 * Apply the role overrides consistently to native adapters and Session checks.
 * Empty role settings inherit the ordinary backend defaults.
 * @template {{model: string, effort: string}} Backend
 * @param {Pick<Role, "model" | "effort">} role
 * @param {Backend} backend
 */
export function roleBackendConfig(role, backend) {
  return {
    ...backend,
    model: role.model || backend.model,
    effort: role.effort || backend.effort,
  };
}

/**
 * A memory invocation uses its own settings, independent of the caller's model.
 * @param {{provider?: string, model?: string, effort?: string}} definition
 * @param {{provider: string, model: string, effort: string}} backend
 */
export function memoryModelSelection(definition, backend) {
  return Object.freeze({
    provider: definition.provider ?? backend.provider,
    model: definition.model ?? backend.model,
    effort: definition.effort ?? backend.effort,
  });
}

/** @param {Role} role @param {string} conversation */
export function memoryRecallPilot(role, conversation) {
  if (!conversation?.startsWith("group:")) return undefined;
  const caller = resolveFunctionalAgent(role, conversation);
  if (
    caller?.kind !== "qq-dialogue" ||
    !caller.definition.delegatesTo?.includes("memory") ||
    !role.tools.includes("memory_search") ||
    (caller.definition.tools &&
      !caller.definition.tools.includes("memory_search"))
  )
    return undefined;
  const memory = resolveFunctionalAgent(role, conversation, "memory");
  if (
    memory?.kind !== "memory" ||
    !memory.definition.tools.includes("memory_search")
  )
    return undefined;
  const pilot = memory.definition.pilot;
  return pilot?.groups.includes(conversation.slice(6)) ? pilot : undefined;
}
