import test from "node:test";
import assert from "node:assert/strict";
import { config, fixture } from "./helpers.mjs";
import {
  acceptsSession,
  sessionSignature,
  sessionContract,
  legacySessionSignature,
  toolSchema,
} from "../src/backends/session-contract.mjs";
const catalogue = () => [
  {
    name: "probe",
    description: "Old prose",
    inputSchema: {
      type: "object",
      properties: {
        description: { type: "string", description: "Field prose" },
        count: { type: "integer", minimum: 1 },
      },
      required: ["description", "count"],
      additionalProperties: false,
    },
  },
];
const backend = () => ({ config: config(1).backends[0] });
function reference(b, tools) {
  return {
    backend: b.config.type,
    id: "synthetic-session",
    signature: sessionSignature(b, tools),
  };
}
test("tool annotations and required-field ordering do not change the session contract", () => {
  const b = backend(),
    old = catalogue(),
    next = structuredClone(old);
  next[0].description = "New prose";
  next[0].inputSchema.properties.description.description = "Updated prose";
  next[0].inputSchema.title = "Documentation";
  next[0].inputSchema.required.reverse();
  assert.equal(sessionSignature(b, next), sessionSignature(b, old));
  assert.deepEqual(toolSchema(next[0].inputSchema).properties.description, {
    type: "string",
  });
});
test("compatible optional additions require the authenticated previous contract", () => {
  const b = backend(),
    old = catalogue(),
    next = structuredClone(old),
    session = reference(b, old),
    previous = sessionContract(b, old);
  next[0].inputSchema.properties.optional = { type: "string" };
  assert.equal(acceptsSession(b, session, next), false);
  assert.equal(acceptsSession(b, session, next, previous), true);
  const forged = structuredClone(previous);
  forged.tools[0].inputSchema.required = [];
  assert.equal(acceptsSession(b, session, next, forged), false);
  assert.equal(
    acceptsSession(b, { ...session, signature: "unknown" }, next, previous),
    false,
  );
});
for (const [name, change] of [
  [
    "new required argument",
    (t) => {
      t[0].inputSchema.properties.new = { type: "string" };
      t[0].inputSchema.required.push("new");
    },
  ],
  ["removed argument", (t) => delete t[0].inputSchema.properties.count],
  ["changed type", (t) => (t[0].inputSchema.properties.count.type = "string")],
  [
    "narrowed constraint",
    (t) => (t[0].inputSchema.properties.count.minimum = 2),
  ],
  ["removed tool", (t) => t.pop()],
  [
    "added tool",
    (t) => t.push({ name: "privileged", inputSchema: { type: "object" } }),
  ],
  [
    "additional properties permission",
    (t) => (t[0].inputSchema.additionalProperties = true),
  ],
])
  test(`${name} requires a new session`, () => {
    const b = backend(),
      old = catalogue(),
      next = structuredClone(old);
    change(next);
    assert.equal(
      acceptsSession(b, reference(b, old), next, sessionContract(b, old)),
      false,
    );
  });
for (const version of [2, 3])
  test(`legacy v${version} migrates only when its original full contract matches`, () => {
    const b = backend(),
      tools = catalogue(),
      session = {
        backend: b.config.type,
        id: "legacy",
        signature: legacySessionSignature(b, tools, version),
      };
    assert.equal(acceptsSession(b, session, tools), true);
    const next = structuredClone(tools);
    next[0].description = "Unknown historic change";
    assert.equal(acceptsSession(b, session, next), false);
    b.config.model = "another-model";
    assert.equal(acceptsSession(b, session, tools), false);
  });
for (const type of ["dsh", "codex", "openai", "antigravity"])
  test(`${type} excludes display and per-request settings but retains identity and authority`, () => {
    const b = backend();
    b.config.type = type;
    const tools = catalogue(),
      session = reference(b, tools);
    Object.assign(b.config, {
      label: "Renamed",
      effort: "high",
      contextWindow: 123456,
      maxToolRounds: 12,
      requestTimeoutMs: 50000,
      sendEffort: true,
    });
    b.config.recovery.autoReconnect = !b.config.recovery.autoReconnect;
    assert.equal(acceptsSession(b, session, tools), true);
    b.config.model = "different-model";
    assert.equal(acceptsSession(b, session, tools), false);
  });

test("retained adapters receive the next turn request settings without changing native identity", async (t) => {
  const cfg = config(1);
  cfg.backends[0].type = "openai";
  cfg.backends[0].baseUrl = "https://api.example.test/v1";
  const f = fixture(t, { cfg });
  f.runtime.backendFactory = (c) => ({ config: c });
  const a = f.runtime.agent("agent-0"),
    adapter = f.runtime.backendConnections.adapter(a),
    signature = sessionSignature(adapter, []);
  const next = structuredClone(f.runtime.config);
  Object.assign(next.backends[0], {
    requestTimeoutMs: 50000,
    maxToolRounds: 12,
    contextWindow: 100000,
    sendEffort: true,
    effort: "high",
  });
  await f.runtime.changeConfig(next, f.configStore.revision);
  assert.equal(
    f.runtime.backendConnections.adapter(f.runtime.agent("agent-0")),
    adapter,
  );
  assert.equal(adapter.config.requestTimeoutMs, 50000);
  assert.equal(adapter.config.maxToolRounds, 12);
  assert.equal(adapter.config.sendEffort, true);
  assert.equal(sessionSignature(adapter, []), signature);
});
