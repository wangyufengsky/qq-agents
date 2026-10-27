// @ts-check
import { CodexBackend } from "./codex.mjs";
import { DshBackend } from "./dsh.mjs";
import { OpenAIBackend } from "./openai.mjs";

export { BACKEND_CAPABILITIES, backendCapabilities } from "./capabilities.mjs";

/**
 * @typedef {DshBackend | CodexBackend | OpenAIBackend} Backend
 * @typedef {(config: import("./session-contract.mjs").BackendConfig,
 *   agent: import("./session-contract.mjs").BackendAgent, options?: any) => Backend} BackendFactory
 */
export class BackendRegistry {
  constructor() {
    /** @type {Map<string, BackendFactory>} */
    this.factories = new Map(
      /** @type {[string, BackendFactory][]} */ ([
        ["dsh", (c, a, o) => new DshBackend(c, a, o)],
        ["codex", (c, a, o) => new CodexBackend(c, a, o)],
        ["openai", (c, a, o) => new OpenAIBackend(c, a, o)],
      ]),
    );
  }
  /** @param {string} type @param {BackendFactory} factory */
  register(type, factory) {
    if (this.factories.has(type)) throw Error("BACKEND_ALREADY_REGISTERED");
    this.factories.set(type, factory);
  }
  /** @param {Parameters<BackendFactory>[0] & {type: string}} config @param {Parameters<BackendFactory>[1]} agent @param {any} [options] */
  create(config, agent, options) {
    const factory = this.factories.get(config.type);
    if (!factory) throw Error("BACKEND_NOT_REGISTERED");
    return factory(config, agent, options);
  }
}
