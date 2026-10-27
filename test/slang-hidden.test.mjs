import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { fixture, config } from "./helpers.mjs";
import { createServer } from "../src/server.mjs";

// Slang learning is withheld until reworked, even where a config enables it.
const enabled = () => {
  const c = config(1);
  c.agents[0].slang.enabled = true;
  c.agents[0].tools.push("slang_query", "slang_submit", "slang_research");
  return c;
};

test("slang tools are never offered and the learner never runs", async (t) => {
  delete process.env.QQ_AGENTS_EXPERIMENTAL_SLANG;
  let runs = 0;
  const f = fixture(t, {
    cfg: enabled(),
    run: async () => {
      runs++;
    },
  });
  const a = f.runtime.agent("agent-0");
  for (const conversation of ["group:20000", "@subject"])
    assert.equal(
      f.runtime.toolsFor(a, conversation).some((n) => n.startsWith("slang_")),
      false,
    );
  const m = f.store.bind("agent-0");
  for (let i = 0; i < 30; i++)
    m.append({
      dedupe: "s" + i,
      conversation: "group:20000",
      kind: "message.received",
      direction: "in",
      senderId: "30000",
      body: "火雨" + i,
    });
  f.runtime.learner.tick();
  await Promise.allSettled([...f.runtime.jobs]);
  assert.equal(runs, 0);
});

test("the console API neither lists nor serves slang", async (t) => {
  delete process.env.QQ_AGENTS_EXPERIMENTAL_SLANG;
  const f = fixture(t, { cfg: enabled() });
  const token = randomBytes(32).toString("hex"),
    app = createServer({ runtime: f.runtime, token });
  const port = await app.listen();
  t.after(() => app.close());
  const get = (path) =>
    fetch(`http://127.0.0.1:${port}${path}`, {
      headers: { "x-admin-token": token },
    });
  const c = await (await get("/api/config")).json();
  assert.equal(c.features.slang, false);
  assert.equal(
    c.tools.some((n) => n.startsWith("slang_")),
    false,
  );
  const r = await get("/api/slang?agentId=agent-0&conversation=group:20000");
  assert.equal(r.status, 400);
  assert.equal((await r.json()).error, "SLANG_FEATURE_DISABLED");
});
