import assert from "node:assert/strict";
import { test } from "node:test";
import { FunctionalDelegation } from "../src/core/functional-delegation.mjs";

function fixture({ run, busy = false, delegates = true, validate } = {}) {
  const work = [];
  let releases = 0;
  let child;
  const role = {
    id: "test-role",
    functionalAgents: {
      qq: { kind: "qq-dialogue", delegatesTo: delegates ? ["memory"] : [] },
      memory: {
        kind: "memory",
        enabled: true,
        onDemand: { timeoutMs: 1000, maxLookups: 3 },
        tools: ["memory_search"],
      },
    },
  };
  const parent = {
    controller: new AbortController(),
    agentId: role.id,
    conversation: "group:20000",
    inputEpoch: "initial",
    token: "parent-token",
    expires: Date.now() + 1000,
  };
  const selection = Object.freeze({ model: "test-model", effort: "low" });
  const runtime = {
    config: { agents: [role] },
    assertActive(ctx) {
      assert.equal(ctx, parent);
      return role;
    },
    containsCapability(ctx, text) {
      assert.equal(ctx, parent);
      return text.includes(ctx.token);
    },
    trackWork(promise) {
      work.push(promise);
      return promise;
    },
    makeFunctionalContext(ctx, options) {
      assert.equal(ctx, parent);
      child = {
        ...options,
        token: "child-token",
        inputEpoch: "child-input",
        allowedTools: ["memory_search"],
      };
      return child;
    },
    closeFunctionalContext(ctx) {
      assert.equal(ctx, child);
    },
    callFunctionalTool(ctx, name, args) {
      assert.equal(ctx, child);
      ctx.assertCurrent();
      assert.equal(name, "functional_agent_result");
      return delegation.submit(ctx, args);
    },
    validateFunctionalEvidence(ctx, evidenceIds) {
      assert.equal(ctx, child);
      validate?.(evidenceIds);
    },
    backendConnections: {
      acquireFunctionalBackend(actualRole, definition) {
        if (busy) throw Error("FUNCTIONAL_AGENT_BUSY");
        assert.equal(actualRole, role);
        assert.equal(definition.kind, "memory");
        return {
          backend: { run },
          modelSelection: selection,
          release() {
            releases++;
          },
        };
      },
    },
  };
  const delegation = new FunctionalDelegation(runtime);
  return {
    runtime,
    parent,
    selection,
    work,
    delegation,
    get child() {
      return child;
    },
    get releases() {
      return releases;
    },
    invoke: (options = {}) =>
      delegation.run(parent, "memory", { prompt: "Example input", ...options }),
  };
}

test("functional delegation runs a fresh backend turn and returns only validated evidence IDs", async () => {
  let submitInput;
  const f = fixture({
    validate: (ids) => assert.deepEqual(ids, ["event-example"]),
    async run(params) {
      assert.match(params.prompt, /context=child-token/);
      assert.doesNotMatch(params.prompt, /parent-token/);
      assert.equal(params.modelSelection, f.selection);
      assert.equal(params.session, null);
      assert.equal(params.tools[0].name, "memory_search");
      assert.notEqual(params.signal, f.parent.controller.signal);
      await params.beforeInputSubmitted();
      assert.equal(f.child.backendInputEpoch, undefined);
      submitInput = params.onInputSubmitted;
      submitInput();
      assert.equal(f.child.backendInputEpoch, f.child.inputEpoch);
      const evidenceIds = ["event-example"];
      assert.deepEqual(
        await params.callTool("functional_agent_result", { evidenceIds }),
        { status: "accepted" },
      );
      evidenceIds[0] = "modified-after-submit";
      assert.throws(
        () => f.delegation.submit(f.child, { evidenceIds }),
        /FUNCTIONAL_AGENT_RESULT_ALREADY_SUBMITTED/,
      );
      return { text: "untrusted assistant text" };
    },
  });
  const result = await f.invoke();
  assert.equal(result.status, "completed");
  assert.equal(result.invocationId, f.child.invocationId);
  assert.deepEqual(result.evidenceIds, ["event-example"]);
  assert.equal(f.releases, 1);
  assert.equal(f.child.controller.signal.aborted, true);
  delete f.child.backendInputEpoch;
  submitInput();
  assert.equal(f.child.backendInputEpoch, undefined);
});

test("functional delegation denies unauthorized targets before acquiring capacity", async () => {
  const f = fixture({ delegates: false });
  assert.deepEqual(await f.invoke(), { status: "denied" });
  assert.equal(f.work.length, 0);
  assert.equal(f.child, undefined);
  const allowed = fixture();
  assert.deepEqual(await allowed.invoke({ prompt: "copied parent-token" }), {
    status: "denied",
  });
  assert.equal(allowed.child, undefined);
  const busy = fixture({ busy: true });
  assert.deepEqual(await busy.invoke(), { status: "busy" });
  assert.equal(busy.child, undefined);
});

test("timeout revokes the child immediately and retains capacity until backend settlement", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"] });
  const backend = Promise.withResolvers();
  let params;
  const f = fixture({
    async run(value) {
      params = value;
      return backend.promise;
    },
  });
  const result = f.invoke({ timeoutMs: 20 });
  t.mock.timers.tick(20);
  assert.equal((await result).status, "timeout");
  assert.equal(params.signal.aborted, true);
  params.onInputSubmitted();
  assert.equal(f.child.backendInputEpoch, undefined);
  assert.equal(f.releases, 0);
  assert.throws(
    () => f.delegation.submit(f.child, { evidenceIds: ["late"] }),
    /FUNCTIONAL_AGENT_STALE/,
  );
  backend.reject(Error("late-backend-error"));
  await assert.rejects(f.work[0], /late-backend-error/);
  assert.equal(f.releases, 1);
});

test("parent cancellation propagates without waiting for the backend", async () => {
  const backend = Promise.withResolvers();
  const f = fixture({ run: () => backend.promise });
  const result = f.invoke();
  f.parent.controller.abort();
  assert.equal((await result).status, "cancelled");
  assert.equal(f.child.controller.signal.aborted, true);
  assert.equal(f.releases, 0);
  backend.resolve();
  await f.work[0];
  assert.equal(f.releases, 1);
});

test("changed input, config or evidence cannot return a previously submitted result", async () => {
  for (const [status, revoke] of [
    [
      "stale",
      (f) => {
        f.parent.inputEpoch = "new-input";
      },
    ],
    [
      "stale",
      (f) => {
        f.runtime.config = { ...f.runtime.config };
      },
    ],
    [
      "stale",
      (f) => {
        f.delegation.invalidate();
      },
    ],
    ["unavailable", () => {}],
  ]) {
    const f = fixture({
      async run(params) {
        await params.callTool("functional_agent_result", {
          evidenceIds: ["event-example"],
        });
        revoke(f);
      },
      validate: () => {
        throw Error("EVIDENCE_REVOKED");
      },
    });
    const result = await f.invoke();
    assert.equal(result.status, status);
    assert.equal(result.evidenceIds, undefined);
  }
});

test("an omitted result differs from a submitted empty evidence list", async () => {
  const omitted = fixture({ async run() {} });
  assert.equal((await omitted.invoke()).status, "no-result");
  const empty = fixture({
    async run(params) {
      await params.callTool("functional_agent_result", { evidenceIds: [] });
    },
  });
  const result = await empty.invoke();
  assert.equal(result.status, "completed");
  assert.deepEqual(result.evidenceIds, []);
});
