// @ts-check
import { z } from "zod";
import {
  canonical,
  digest,
  fail,
  immutable,
  parse,
  bounded,
} from "./value.mjs";

export const limits = Object.freeze({
  action: 16384,
  state: 262144,
  view: 65536,
  random: 64,
  actions: 10000,
});
const version = z.string().regex(/^[a-zA-Z0-9._-]{1,64}$/);
const manifestSchema = z.strictObject({
  gameType: z.string().regex(/^[a-z][a-z0-9-]{0,47}$/),
  moduleVersion: version,
  moduleApiVersion: z.literal(1),
  rulesVersion: version,
  stateSchemaVersion: version,
  uiVersion: version,
  capabilities: z
    .array(
      z.enum([
        "turn-sequential-v1",
        "private-values-v1",
        "random-context-v1",
        "shared-outcome-v1",
      ]),
    )
    .min(1),
  participants: z.strictObject({
    min: z.number().int().min(1).max(8),
    max: z.number().int().min(1).max(8),
    kinds: z.array(z.enum(["human", "ai"])).min(1),
  }),
  limits: z.strictObject({
    action: z.number().int().positive().max(limits.action),
    state: z.number().int().positive().max(limits.state),
    view: z.number().int().positive().max(limits.view),
    random: z.number().int().min(0).max(limits.random),
  }),
});
/** @typedef {{manifest:any, schemas:{options:import('zod').ZodType,state:import('zod').ZodType,view:import('zod').ZodType,outcome:import('zod').ZodType,actions:Record<string,import('zod').ZodType>}, create:(...args:any[])=>any,applyAction:(...args:any[])=>any,nextActor:(...args:any[])=>any,outcome:(...args:any[])=>any,projectView:(...args:any[])=>any,describeView?:(view:any)=>any}} Definition */

export class GameRegistry {
  modules = new Map();
  /** Trusted, statically imported code only. Sources cover its complete bundle, including UI/schema dependencies.
   * @param {Definition} definition @param {Record<string,string|Buffer>} sources */
  register(definition, sources) {
    const manifest = parse(
      manifestSchema,
      definition.manifest,
      "GAME_MODULE_INVALID",
    );
    if (
      !manifest.capabilities.includes("turn-sequential-v1") ||
      manifest.participants.min > manifest.participants.max ||
      !Object.keys(sources).length
    )
      fail("GAME_MODULE_INVALID");
    for (const name of [
      "create",
      "applyAction",
      "nextActor",
      "outcome",
      "projectView",
    ])
      if (typeof (/** @type {any} */ (definition)[name]) !== "function")
        fail("GAME_MODULE_INVALID");
    for (const name of Object.keys(definition.schemas.actions))
      if (!/^game\.[a-z][a-z0-9_]{0,47}$/.test(name))
        fail("GAME_MODULE_INVALID");
    for (const schema of [
      definition.schemas.options,
      definition.schemas.state,
      definition.schemas.view,
      definition.schemas.outcome,
      ...Object.values(definition.schemas.actions),
    ])
      if (typeof schema?.safeParse !== "function") fail("GAME_MODULE_INVALID");
    const moduleDigest = digest(
      canonical({
        manifest,
        sources: Object.fromEntries(
          Object.entries(sources).map(([k, v]) => [k, digest(v)]),
        ),
      }),
    );
    const ref = immutable({ ...manifest, moduleDigest });
    const key = `${manifest.gameType}:${manifest.moduleVersion}`;
    if (this.modules.has(key)) fail("GAME_MODULE_VERSION_EXISTS");
    const module = Object.freeze({
      ...definition,
      manifest: immutable(manifest),
      ref,
      schemas: Object.freeze({
        ...definition.schemas,
        actions: Object.freeze({ ...definition.schemas.actions }),
      }),
    });
    this.modules.set(key, module);
    return ref;
  }
  /** @param {string} gameType @param {string} moduleVersion */
  select(gameType, moduleVersion) {
    const module = this.modules.get(`${gameType}:${moduleVersion}`);
    if (!module) fail("GAME_MODULE_UNAVAILABLE", 503);
    return module;
  }
  /** @param {any} ref */
  resolve(ref) {
    const module = this.select(ref.gameType, ref.moduleVersion);
    if (canonical(module.ref) !== canonical(ref))
      fail("GAME_MODULE_UNAVAILABLE", 503);
    return module;
  }
}

/** No module exception or schema detail crosses the private-state boundary.
 * @param {()=>any} call @param {import('zod').ZodType} schema @param {number} limit */
export function moduleOutput(call, schema, limit) {
  try {
    const value = call();
    bounded(value, limit);
    return immutable(
      parse(schema, JSON.parse(canonical(value)), "GAME_MODULE_INVALID_RESULT"),
    );
  } catch {
    return fail("GAME_MODULE_INVALID_RESULT", 500);
  }
}
