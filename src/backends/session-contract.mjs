import { createHash } from "node:crypto";

// JSON object order is not protocol semantics. Array order remains significant,
// except for the tool catalogue, which is a set keyed by name.
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
export function sessionSignature(backend, tools = []) {
  return (
    "contract-v2:" +
    createHash("sha256")
      .update(
        JSON.stringify(
          canonical({
            backend: backend.config,
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
export function assertSession(session, backend, signature) {
  if (
    session &&
    (session.backend !== backend || session.signature !== signature)
  )
    throw Error("SESSION_REQUIRES_HANDOFF");
}
