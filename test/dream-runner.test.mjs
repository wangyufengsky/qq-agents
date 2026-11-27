import test from "node:test";
import assert from "node:assert/strict";
import { scopedCatalog } from "../src/tools/catalog.mjs";
import { resolveFunctionalAgent } from "../src/core/functional-agents.mjs";
import { config, fixture } from "./helpers.mjs";

const empty = {
  schemaVersion: 1,
  operations: [],
  awakeningSummary: "",
  noChangesReason: "没有新增认知。",
};
const role = "agent-0",
  group = "group:20000";
const dreamConfig = () => {
  const cfg = config();
  cfg.agents[0].dream.enabled = true;
  return cfg;
};
function append(f, dedupe, fields) {
  return f.store.bind(role).append({
    dedupe,
    conversation: group,
    kind: "message.received",
    body: "我喜欢喝茶。",
    senderId: "30000",
    payload: { trustedInput: true },
    ...fields,
  });
}
function patch(id, other = {}) {
  return {
    schemaVersion: 1,
    awakeningSummary: "",
    noChangesReason: null,
    operations: [
      {
        op: "ADD",
        category: "preference",
        scopeId: group,
        subjectKey: "user:30000:tea",
        content: "用户说自己喜欢茶。",
        epistemicStatus: "reported",
        evidenceIds: [id],
        confidence: 0.8,
        importance: 0.7,
        reason: "明确自述。",
        ...other,
      },
    ],
  };
}

test("routing prefers explicit, then unique dedicated, then main, with three levels of model settings", () => {
  const cfg = dreamConfig();
  cfg.backends[0].model = "main";
  cfg.backends[0].effort = "medium";
  const a = cfg.agents[0];
  const profile = () =>
    resolveFunctionalAgent(a, "@dream", "dream-cognitive", cfg);
  const dedicated = {
    ...cfg.backends[0],
    id: "dedicated",
    model: "dedicated",
    provider: "fixture",
    functionalAgentOnly: true,
  };
  assert.equal(profile().definition.model, "main");
  cfg.backends.push(dedicated);
  assert.equal(profile().definition.model, "dedicated");
  cfg.backends.push({ ...dedicated, id: "other" });
  assert.equal(profile().definition.model, "main");
  a.dream.backendId = "dedicated";
  assert.equal(profile().definition.model, "dedicated");
  a.dream.model = "role-dream";
  a.dream.effort = "low";
  assert.equal(profile().definition.model, "role-dream");
  assert.equal(profile().definition.effort, "low");
  a.dream.cognitive.model = "cognitive";
  a.dream.cognitive.effort = "high";
  assert.equal(profile().definition.model, "cognitive");
  assert.equal(profile().definition.effort, "high");
});

test("runtime launches a one-use session; discovers only scoped tools; accepts one valid submission", async (t) => {
  let source;
  const f = fixture(t, {
    cfg: dreamConfig(),
    run: async (p) => {
      assert.equal(p.session, null);
      assert.equal(p.dream, true);
      assert.match(p.conversation, /dream-cognitive/);
      const nonce = /context=(\S+)/.exec(p.prompt)[1];
      const ctx = f.runtime.capability(nonce);
      const { tools } = scopedCatalog(f.runtime, ctx, {});
      for (const name of ["memory_read", "memory_search"])
        assert.match(
          tools.find((tool) => tool.name === name).description,
          /revision/,
        );
      assert.deepEqual(
        tools.map(({ name }) => name),
        [
          "memory_search",
          "memory_read",
          "memory_related",
          "dream_cognition_list",
          "dream_cognition_submit",
        ],
      );
      assert.throws(
        () => scopedCatalog(f.runtime, ctx, { names: ["qq_send"] }),
        /TOOL_DISABLED/,
      );
      assert.deepEqual(await p.callTool("dream_cognition_list", {}), {
        items: [],
        nextOffset: null,
      });
      await assert.rejects(
        p.callTool("dream_cognition_submit", { ...empty, runId: "forged" }),
        /DREAM_INVALID_PATCH/,
      );
      assert.deepEqual(
        await p.callTool("dream_cognition_submit", patch(source.id)),
        { status: "accepted" },
      );
      await assert.rejects(
        p.callTool("dream_cognition_submit", empty),
        /FUNCTIONAL_AGENT_RESULT_ALREADY_SUBMITTED/,
      );
      p.saveSession({ id: "must-not-be-retained", backend: "codex" });
    },
  });
  source = append(f, "source");
  const ordinary = f.runtime.makeContext(role, group);
  const state = f.store.bind(role).state(group);
  const result = await f.runtime.dreams.run(role, { idempotencyKey: "one" });
  assert.equal(result.status, "COMMITTED");
  assert.deepEqual(
    await f.runtime.dreams.run(role, { idempotencyKey: "one" }),
    { status: "COMMITTED", runId: result.runId },
  );
  assert.deepEqual(f.store.bind(role).state(group), state);
  await assert.rejects(
    f.runtime.callTool(ordinary, "dream_cognition_list", {}),
    /TOOL_DISABLED/,
  );
  assert.equal(
    f.store.db.prepare("SELECT count(*) AS n FROM cognitions").get().n,
    1,
  );
});

test("timeout, cancellation, and invalid or stale evidence never advance watermarks", async (t) => {
  for (const mode of ["timeout", "cancel", "invalid", "revoked", "success"]) {
    await t.test(mode, async (t) => {
      const cfg = dreamConfig();
      cfg.agents[0].dream.cognitive.timeoutMs = mode === "timeout" ? 25 : 10000;
      let event;
      const ready = Promise.withResolvers();
      const controller = new AbortController();
      const f = fixture(t, {
        cfg,
        run: async (p) => {
          ready.resolve();
          if (mode === "timeout" || mode === "cancel") {
            await new Promise((resolve) =>
              p.signal.addEventListener("abort", resolve, { once: true }),
            );
            return;
          }
          if (mode === "invalid") {
            await assert.rejects(
              p.callTool(
                "dream_cognition_submit",
                patch(event.id, { epistemicStatus: "fictional" }),
              ),
              /DREAM_FICTIONAL_IN_COGNITION/,
            );
            return;
          }
          if (mode === "revoked") {
            await p.callTool("dream_cognition_submit", patch(event.id));
            f.store.db
              .prepare("UPDATE events SET payload=? WHERE id=?")
              .run(JSON.stringify({ protectedOperations: true }), event.id);
            return;
          }
          await p.callTool("dream_cognition_submit", empty);
        },
      });
      event = append(f, "source");
      const running = f.runtime.dreams.run(role, { signal: controller.signal });
      if (mode === "cancel") {
        await ready.promise;
        await assert.rejects(
          f.runtime.dreams.run(role),
          /DREAM_ALREADY_RUNNING/,
        );
        controller.abort();
      }
      const result = await running;
      if (mode === "success") {
        assert.equal(result.changesCount, 0);
        assert.equal(
          f.store.db
            .prepare(
              "SELECT last_event_seq FROM dream_checkpoints WHERE source_partition='events'",
            )
            .get().last_event_seq,
          event.seq,
        );
      } else {
        assert.equal(result.status, mode === "cancel" ? "CANCELLED" : "FAILED");
        assert.equal(
          f.store.db
            .prepare("SELECT count(*) AS n FROM dream_checkpoints")
            .get().n,
          0,
        );
      }
      assert.equal(
        f.store.db.prepare("SELECT count(*) AS n FROM cognitions").get().n,
        0,
      );
    });
  }
});

test("sources from ordinary read tools count as evidence only after the delivered output", async (t) => {
  const cfg = dreamConfig();
  cfg.agents[0].dream.cognitive.maxEventsPerBatch = 1;
  const f = fixture(t, {
    cfg,
    run: async (p) => {
      await assert.rejects(
        p.callTool("dream_cognition_submit", patch(second.id)),
        /RECALL_SOURCE_NOT_ALLOWED/,
      );
      await p.callTool("dream_cognition_submit", empty);
    },
  });
  const first = append(f, "first");
  const second = append(f, "second");
  assert.equal((await f.runtime.dreams.run(role)).status, "COMMITTED");
  f.runtime.backendFactory = () => ({
    async run(p) {
      p.onInputSubmitted();
      const result = await p.callTool("memory_read", { id: first.id });
      await assert.rejects(
        p.callTool("dream_cognition_submit", patch(first.id)),
        /DREAM_EVIDENCE_NOT_SHOWN/,
      );
      const receipt = await p.finalizeToolOutput(result, {
        encode: (value) => {
          const wire = JSON.stringify(value);
          return { wire, text: wire };
        },
      });
      p.commitToolOutput(receipt.receipt, receipt.wire);
      await p.callTool("dream_cognition_submit", patch(first.id));
    },
    close() {},
  });
  assert.equal((await f.runtime.dreams.run(role)).status, "COMMITTED");
});

test("a protected source change before native input aborts with an unchanged cursor", async (t) => {
  const f = fixture(t, { cfg: dreamConfig() });
  const source = append(f, "revoked-before-native-input");
  let delivered = false;
  f.runtime.backendFactory = () => ({
    async run(p) {
      f.store.db
        .prepare("UPDATE events SET payload=? WHERE id=?")
        .run(JSON.stringify({ protectedOperations: true }), source.id);
      await p.beforeInputSubmitted();
      p.onInputSubmitted();
      delivered = true;
    },
    close() {},
  });
  const failure = await f.runtime.dreams.run(role);
  assert.equal(failure.status, "FAILED");
  assert.equal(failure.errorCode, "RECALL_SOURCE_NOT_ALLOWED");
  assert.equal(delivered, false);
  assert.equal(
    f.store.db.prepare("SELECT count(*) AS n FROM dream_checkpoints").get().n,
    0,
  );
});

test("cognition list withholds old rows whose current evidence cannot be accessed", async (t) => {
  let source;
  let first = true;
  const f = fixture(t, {
    cfg: dreamConfig(),
    run: async (p) => {
      if (first) {
        await p.callTool("dream_cognition_submit", patch(source.id));
        return;
      }
      const list = await p.callTool("dream_cognition_list", {});
      assert.deepEqual(list.items, []);
      await p.callTool("dream_cognition_submit", empty);
    },
  });
  source = append(f, "before-revoking");
  assert.equal((await f.runtime.dreams.run(role)).status, "COMMITTED");
  f.store.db
    .prepare("UPDATE events SET payload=? WHERE id=?")
    .run(JSON.stringify({ protectedOperations: true }), source.id);
  first = false;
  assert.equal((await f.runtime.dreams.run(role)).status, "COMMITTED");
  assert.equal(
    f.store.db.prepare("SELECT count(*) AS n FROM cognitions").get().n,
    1,
  );
});

test("cognitive backend receives the framework mode and the same scoped tool contracts", async (t) => {
  const exchanges = [];
  const f = fixture(t, {
    cfg: dreamConfig(),
    run: async (params) => {
      const token = /context=(\S+)/.exec(params.prompt)[1];
      const ctx = f.runtime.capability(token);
      exchanges.push({
        prompt: params.prompt,
        tools: params.tools,
        discovery: scopedCatalog(f.runtime, ctx, {
          names: params.tools.map(({ name }) => name),
        }).tools,
        session: params.session,
      });
      await params.callTool("dream_cognition_submit", empty);
    },
  });
  for (const mode of ["nap", "deep"])
    assert.equal(
      (await f.runtime.dreams.run("agent-0", { mode })).status,
      "COMMITTED",
    );

  assert.match(exchanges[0].prompt, /小憩（nap）.*ADD.*UPDATE.*REINFORCE/);
  assert.match(
    exchanges[1].prompt,
    /深度睡眠（deep）.*冲突.*纠正.*LINK.*WEAKEN/,
  );
  assert.deepEqual(exchanges[0].tools, exchanges[1].tools);
  assert.deepEqual(exchanges[0].discovery, exchanges[1].discovery);
  assert.deepEqual(exchanges[0].tools, exchanges[0].discovery);
  assert.ok(exchanges.every(({ session }) => session === null));
});
