import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { MemoryStore } from "../src/memory/store.mjs";
import { recordBackendTiming } from "../src/core/session-records.mjs";
import { temp } from "./helpers.mjs";

test("backend timing persists fixed numeric phases and ignores private provider fields", (t) => {
  const store = new MemoryStore(path.join(temp(t), "memory.sqlite"));
  t.after(() => store.close());
  const mem = store.bind("timing-agent");
  mem.identity.put("model_turns", {
    id: "timing",
    conversation: "private:30000",
    status: "running",
  });
  recordBackendTiming(mem, "timing", {
    phase: "initialized",
    elapsedMs: 8535.4,
    processReused: false,
    prompt: "PRIVATE_SYNTHETIC_PAYLOAD",
  });
  recordBackendTiming(mem, "timing", {
    phase: "lastResponse",
    elapsedMs: 42000.6,
  });
  recordBackendTiming(mem, "timing", {
    phase: "lastResponse",
    elapsedMs: 43000,
  });
  for (const event of [
    null,
    { phase: "providerUrl", elapsedMs: 1 },
    { phase: "terminal", elapsedMs: NaN },
    { phase: "terminal", elapsedMs: Infinity },
    { phase: "terminal", elapsedMs: -1 },
    { phase: "terminal", elapsedMs: 86400001 },
  ])
    recordBackendTiming(mem, "timing", event);
  const record = mem.identity.get("model_turns", "timing");
  assert.deepEqual(record.backendTiming, {
    unit: "ms",
    processReused: false,
    phases: { initialized: 8535, lastResponse: 43000 },
  });
  assert(!JSON.stringify(record).includes("PRIVATE_SYNTHETIC_PAYLOAD"));
});

test("late backend timing cannot modify a completed turn or another turn", (t) => {
  const store = new MemoryStore(path.join(temp(t), "memory.sqlite"));
  t.after(() => store.close());
  const mem = store.bind("timing-agent");
  mem.identity.put("model_turns", {
    id: "old",
    conversation: "private:30000",
    status: "sent",
  });
  mem.identity.put("model_turns", {
    id: "new",
    conversation: "private:30000",
    status: "running",
  });
  recordBackendTiming(mem, "old", { phase: "complete", elapsedMs: 999 });
  recordBackendTiming(mem, "missing", { phase: "complete", elapsedMs: 999 });
  assert.equal(mem.identity.get("model_turns", "old").backendTiming, undefined);
  assert.equal(mem.identity.get("model_turns", "new").backendTiming, undefined);
});
