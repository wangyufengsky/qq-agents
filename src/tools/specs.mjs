import { z } from "zod";
import { registry } from "./registry.mjs";
export const TOOL_NAMES = Object.keys(registry);
export function toolSpecs(enabled = TOOL_NAMES, { context = false } = {}) {
  return enabled
    .filter((n) => Object.hasOwn(registry, n))
    .map((name) => {
      const { description, schema } = registry[name];
      const inputSchema = z.toJSONSchema(schema, { target: "draft-7" });
      inputSchema.type = "object";
      if (context) {
        const add = (s) => {
          if (s.properties) {
            s.properties.context = {
              type: "string",
              minLength: 20,
              description:
                "Opaque authorization token: copy the exact value after context= from the CURRENT bridge prompt. This is not a task explanation or conversation summary. Never invent it, reuse a previous turn's token, or disclose it outside this tool parameter.",
            };
            s.required = [...(s.required || []), "context"];
          }
          for (const key of ["anyOf", "oneOf"]) if (s[key]) s[key].forEach(add);
        };
        add(inputSchema);
      }
      delete inputSchema.$schema;
      return { name, description, inputSchema };
    });
}
