import { CodexBackend } from "./codex.mjs";
import { DshBackend } from "./dsh.mjs";
import { OpenAIBackend } from "./openai.mjs";

export { BACKEND_CAPABILITIES, backendCapabilities } from "./capabilities.mjs";

export class BackendRegistry {
  constructor() {
    this.factories = new Map([
      ["dsh", (c, a, o) => new DshBackend(c, a, o)],
      ["codex", (c, a, o) => new CodexBackend(c, a, o)],
      ["openai", (c, a, o) => new OpenAIBackend(c, a, o)],
    ]);
  }
  register(type, factory) {
    if (this.factories.has(type)) throw Error("BACKEND_ALREADY_REGISTERED");
    this.factories.set(type, factory);
  }
  create(config, agent, options) {
    const factory = this.factories.get(config.type);
    if (!factory) throw Error("BACKEND_NOT_REGISTERED");
    return factory(config, agent, options);
  }
}
