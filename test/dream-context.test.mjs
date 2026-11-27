import test from "node:test";
import assert from "node:assert/strict";
import { runNativeSocial } from "../src/backends/native-social.mjs";
import { sessionSignature } from "../src/backends/session-contract.mjs";
import { cognitionContext } from "../src/dream/context-builder.mjs";
import { beginDesktopContext } from "../src/home/desktop-context.mjs";
import { DESKTOP_CONVERSATION } from "../src/home/desktop-decision.mjs";
import { config, fixture } from "./helpers.mjs";

const role = "agent-0";
const group = "group:20000";
const nativeSession = { id: "synthetic-qq-session", backend: "fixture" };
const patch = (operation) => ({
  schemaVersion: 1,
  operations: [operation],
  awakeningSummary: "",
  noChangesReason: null,
});
function append(f, dedupe, conversation = group) {
  return f.store.bind(role).append({
    dedupe,
    conversation,
    kind: "message.received",
    body: "实际读到的偏好",
    senderId: "30000",
    payload: {
      trustedInput: true,
      segments: [{ type: "at", data: { qq: "10000" } }],
    },
  });
}
function add(id, scopeId = "global") {
  return patch({
    op: "ADD",
    scopeId,
    category: "preference",
    subjectKey: "user:30000:music",
    evidenceIds: [id],
    importance: 0.7,
    confidence: 0.8,
    content: "喜欢听钢琴。",
    epistemicStatus: "reported",
    reason: "明确自述。",
  });
}

test("QQ delivers new versions incrementally and dream configuration retains the chat contract", async (t) => {
  const seen = [];
  let pending;
  const cfg = config(1);
  cfg.agents[0].contextPolicy.capacityTokens = 1000000;
  const f = fixture(t, {
    cfg,
    run: async (p) => {
      if (p.dream) {
        await p.callTool("dream_cognition_submit", pending);
        return;
      }
      seen.push({
        prompt: p.prompt,
        instructions: p.instructions,
        tools: p.tools,
        session: p.session,
      });
      p.saveSession(nativeSession);
    },
  });
  const memory = f.store.bind(role);
  let wakeCount = 0;
  const wake = () => {
    append(f, "chat-wake-" + ++wakeCount);
    return f.runtime.wake(role, group);
  };
  await wake();
  const originalSession = memory.state(group).session;
  assert.ok(
    originalSession,
    JSON.stringify(f.store.db.prepare("SELECT value FROM model_turns").all()),
  );
  assert.equal(originalSession.id, nativeSession.id);
  const enabled = structuredClone(f.runtime.config);
  enabled.agents[0].dream.enabled = true;
  await f.runtime.changeConfig(enabled, f.configStore.revision);
  assert.deepEqual(memory.state(group).session, originalSession);
  const first = append(f, "qq-context-first", "private:30000");
  pending = add(first.id);
  assert.equal((await f.runtime.dreams.run(role)).status, "COMMITTED");
  const { id } = f.store.db.prepare("SELECT id FROM cognitions").get();
  await wake();
  assert.match(seen[1].prompt, /喜欢听钢琴/);
  assert.match(seen[1].prompt, /"fromPrivate":true/);
  assert.match(seen[1].prompt, /醒来摘要.*fromPrivate/);
  assert.equal(seen[1].session.id, nativeSession.id);
  assert.equal(seen[1].instructions, seen[0].instructions);
  assert.deepEqual(seen[1].tools, seen[0].tools);
  assert.equal(memory.state(group).cognitionsShown[id], 1);
  await wake();
  assert.doesNotMatch(seen[2].prompt, /长期认知|喜欢听钢琴/);

  const second = append(f, "qq-context-second");
  pending = patch({
    op: "UPDATE",
    targetId: id,
    expectedVersion: 1,
    evidenceIds: [second.id],
    content: "现在也喜欢听弦乐。",
    epistemicStatus: "reported",
    reason: "补充偏好。",
  });
  assert.equal((await f.runtime.dreams.run(role)).status, "COMMITTED");
  await wake();
  assert.match(seen[3].prompt, /现在也喜欢听弦乐/);
  assert.match(seen[3].prompt, /"fromPrivate":true/);
  assert.equal(memory.state(group).cognitionsShown[id], 2);
  assert.deepEqual(memory.state(group).session, originalSession);

  const off = structuredClone(f.runtime.config);
  off.agents[0].dream.enabled = false;
  await f.runtime.changeConfig(off, f.configStore.revision);
  f.runtime.contexts.retire(role, group, "fixture-new-session");
  await wake();
  assert.deepEqual(memory.state(group).cognitionsShown, {});
  await f.runtime.changeConfig(enabled, f.configStore.revision);
  await wake();
  assert.match(seen.at(-1).prompt, /现在也喜欢听弦乐/);
});

test("desktop shares the ordinary Session and records delivery only on native input receipt", async (t) => {
  const cfg = config();
  cfg.desktopHome.enabled = true;
  cfg.agents[0].dream.enabled = true;
  let pending;
  const f = fixture(t, {
    cfg,
    run: (p) => p.callTool("dream_cognition_submit", pending),
  });
  pending = add(append(f, "desktop-context").id);
  assert.equal((await f.runtime.dreams.run(role)).status, "COMMITTED");
  const memory = f.store.bind(role);
  const agent = f.runtime.agent(role);
  let lastSignature;
  const backend = {
    config: f.runtime.config.backends[0],
    sessionSignature(tools) {
      return (lastSignature = sessionSignature(this, tools));
    },
  };
  const begin = () => {
    const controller = new AbortController();
    const ctx = f.runtime.makeContext(role, DESKTOP_CONVERSATION, {
      controller,
      assertCurrent() {},
      decide() {},
      unified: true,
      kind: "chat",
    });
    return beginDesktopContext(
      f.runtime,
      ctx,
      agent,
      backend,
      { kind: "chat", messages: [], people: [] },
      controller.signal,
    );
  };
  const initial = begin();
  assert.doesNotMatch(initial.prompt, /喜欢听钢琴/);
  assert.match(initial.appendPrompt(), /喜欢听钢琴/);
  assert.equal(memory.state(DESKTOP_CONVERSATION).cognitionsShown, undefined);
  const { id } = f.store.db.prepare("SELECT id FROM cognitions").get();
  initial.onInputSubmitted();
  assert.deepEqual(memory.state(DESKTOP_CONVERSATION).cognitionsShown, {
    [id]: 1,
  });
  initial.managedContext.saveSession({
    id: "synthetic-desktop-session",
    backend: "codex",
    signature: lastSignature,
  });
  initial.managedContext.onCompleted();
  await initial.finish();
  const retained = begin();
  assert.equal(retained.managedContext.session.id, "synthetic-desktop-session");
  assert.equal(retained.instructions, initial.instructions);
  assert.doesNotMatch(retained.prompt + retained.appendPrompt(), /喜欢听钢琴/);
  // The opening builder applies the same seen-version map across both surfaces.
  assert.equal(
    cognitionContext(
      f.runtime,
      { agentId: role, conversation: DESKTOP_CONVERSATION },
      { fresh: false },
    ).line,
    "",
  );
  const overBudget = {
    ...agent,
    dream: {
      ...agent.dream,
      budget: { ...agent.dream.budget, contextCoreChars: 8 },
    },
  };
  const runtime = { agent: () => overBudget, memory: f.store };
  assert.equal(
    cognitionContext(
      runtime,
      { agentId: role, conversation: DESKTOP_CONVERSATION },
      { fresh: true },
    ).line,
    "",
  );
});

test("QQ and desktop omit stale cognitions at native input while delivering the rest of the turn", async (t) => {
  for (const surface of ["qq", "compact-qq", "desktop"]) {
    for (const mutation of ["protection", "revision", "deletion"]) {
      await t.test(`${surface} with ${mutation}`, async (t) => {
        const cfg = config(1);
        cfg.agents[0].dream.enabled = true;
        cfg.agents[0].contextPolicy.capacityTokens = 1000000;
        if (surface === "desktop") cfg.desktopHome.enabled = true;
        if (surface === "compact-qq")
          cfg.agents[0].behavior.compactChatGroups = ["20000"];
        let pending;
        const f = fixture(t, {
          cfg,
          run: (p) => p.callTool("dream_cognition_submit", pending),
        });
        const staleSource = append(f, "before-stale", "private:30000");
        const validSource = append(f, "before-valid", "private:30000");
        pending = add(staleSource.id);
        pending.operations.push({
          ...add(validSource.id).operations[0],
          subjectKey: "user:30000:reading",
          content: "喜欢阅读散文。",
        });
        assert.equal((await f.runtime.dreams.run(role)).status, "COMMITTED");

        const db = f.store.db;
        const stale = db
          .prepare("SELECT id FROM cognitions WHERE subject_key=?")
          .get("user:30000:music").id;
        const valid = db
          .prepare("SELECT id FROM cognitions WHERE subject_key=?")
          .get("user:30000:reading").id;
        const memory = f.store.bind(role);
        const scope = surface === "desktop" ? DESKTOP_CONVERSATION : group;
        let delivered;
        const backend = {
          config: cfg.backends[0],
          sessionSignature(tools) {
            return sessionSignature(this, tools);
          },
          async run(p) {
            assert.doesNotMatch(p.prompt, /喜欢听钢琴|喜欢阅读散文/);
            assert.equal(memory.state(scope).cognitionsShown, undefined);
            // Backend and image preparation can await after the base prompt exists.
            await p.beforeInputSubmitted();
            if (mutation === "protection")
              db.prepare("UPDATE events SET payload=? WHERE id=?").run(
                JSON.stringify({ protectedOperations: true }),
                staleSource.id,
              );
            if (mutation === "revision")
              db.prepare(
                "UPDATE cognitions SET content=?,version=2 WHERE id=?",
              ).run("修订后的偏好", stale);
            if (mutation === "deletion")
              db.prepare("DELETE FROM cognitions WHERE id=?").run(stale);
            delivered = p.prompt + p.appendPrompt();
            p.onInputSubmitted();
            if (surface === "desktop")
              p.saveSession({
                backend: this.config.type,
                id: "synthetic-desktop-tested",
                signature: this.sessionSignature(p.tools),
              });
          },
          close() {},
        };
        if (surface === "desktop") {
          const controller = new AbortController();
          const ctx = f.runtime.makeContext(role, scope, {
            controller,
            assertCurrent() {},
            decide() {},
            unified: true,
            kind: "chat",
          });
          const exchange = beginDesktopContext(
            f.runtime,
            ctx,
            f.runtime.agent(role),
            backend,
            { kind: "chat", messages: [], people: [] },
            controller.signal,
          );
          await runNativeSocial(
            backend,
            {
              ...exchange,
              budget: null,
              signal: controller.signal,
              binding: { runId: ctx.turnId },
              beforeInput() {},
              onRunStarted() {},
            },
            async () => {},
            "desktop",
          );
          await exchange.finish();
        } else {
          f.runtime.backendFactory = () => backend;
          append(f, "wake-after-selection");
          await f.runtime.wake(role, scope);
        }
        assert.doesNotMatch(delivered, /喜欢听钢琴|修订后的偏好/);
        assert.match(delivered, /喜欢阅读散文/);
        assert.doesNotMatch(delivered, /醒来摘要/);
        assert.deepEqual(memory.state(scope).cognitionsShown, { [valid]: 1 });
        assert.ok(
          !memory.state(scope).disclosureTaint.includes(staleSource.id),
        );
      });
    }
  }
});

test("retained QQ and desktop sessions invalidate previously delivered cognition versions once", async (t) => {
  for (const surface of ["qq", "desktop"])
    for (const op of ["WEAKEN", "UPDATE", "ARCHIVE", "MERGE"]) {
      await t.test(`${surface} ${op}`, async (t) => {
        const cfg = config(1);
        cfg.agents[0].dream.enabled = true;
        cfg.agents[0].contextPolicy.capacityTokens = 1000000;
        cfg.desktopHome.enabled = true;
        const prompts = [];
        let nextPatch;
        const f = fixture(t, {
          cfg,
          run: async (p) => {
            if (p.dream) return p.callTool("dream_cognition_submit", nextPatch);
            prompts.push({
              prompt: p.prompt,
              instructions: p.instructions,
              session: p.session,
            });
            p.saveSession(nativeSession);
          },
        });
        const memory = f.store.bind(role),
          db = f.store.db;
        const source = append(f, "invalidation-source", "private:30000");
        nextPatch = add(source.id);
        if (op === "MERGE")
          nextPatch.operations.push({
            ...add(source.id, "desktop").operations[0],
            scopeId: "global",
            subjectKey: "merge:destination",
            content: "合并保留的认知。",
          });
        assert.equal((await f.runtime.dreams.run(role)).status, "COMMITTED");
        const id = db
          .prepare(
            "SELECT id FROM cognitions WHERE subject_key='user:30000:music'",
          )
          .get().id;
        const scope = surface === "desktop" ? DESKTOP_CONVERSATION : group;
        let wakeCount = 0;
        const native = {
          config: cfg.backends[0],
          sessionSignature(tools) {
            return sessionSignature(this, tools);
          },
          async run(p) {
            await p.beforeInputSubmitted();
            prompts.push({
              prompt: p.prompt + (p.appendPrompt?.() || ""),
              instructions: p.instructions,
              session: p.session,
            });
            p.onInputSubmitted();
            p.saveSession(
              p.session ?? {
                id: "synthetic-desktop-retained",
                backend: "codex",
                signature: this.sessionSignature(p.tools),
              },
            );
          },
        };
        async function wake() {
          if (surface === "qq") {
            append(f, "invalidation-wake-" + ++wakeCount);
            return f.runtime.wake(role, scope);
          }
          const controller = new AbortController();
          const ctx = f.runtime.makeContext(role, scope, {
            controller,
            assertCurrent() {},
            decide() {},
            unified: true,
            kind: "chat",
          });
          const exchange = beginDesktopContext(
            f.runtime,
            ctx,
            f.runtime.agent(role),
            native,
            { kind: "chat", messages: [], people: [] },
            controller.signal,
          );
          await runNativeSocial(
            native,
            {
              ...exchange,
              budget: null,
              signal: controller.signal,
              binding: { runId: ctx.turnId },
              beforeInput() {},
              onRunStarted() {},
            },
            async () => {},
            "desktop",
          );
          await exchange.finish();
          f.runtime.capabilities.delete(ctx.token);
        }
        await wake();
        assert.match(prompts[0].prompt, /喜欢听钢琴/);
        assert.equal(memory.state(scope).cognitionsShown[id], 1);
        const next = append(f, "invalidation-next", "private:30000");
        const target = {
          targetId: id,
          expectedVersion: 1,
          reason: "旧结论失效",
        };
        if (op === "MERGE") {
          const destination = db
            .prepare(
              "SELECT id FROM cognitions WHERE subject_key='merge:destination'",
            )
            .get().id;
          nextPatch = patch({
            ...target,
            op,
            targetId: destination,
            sourceIds: [id],
            evidenceIds: [next.id],
            content: "合并后的有效认知。",
          });
        } else {
          nextPatch = patch({
            ...target,
            op,
            ...(op !== "ARCHIVE" && { evidenceIds: [next.id] }),
            ...(op === "UPDATE" && {
              content: "相互矛盾的材料。",
              epistemicStatus: "disputed",
            }),
          });
        }
        assert.equal((await f.runtime.dreams.run(role)).status, "COMMITTED");
        assert.doesNotMatch(
          cognitionContext(
            f.runtime,
            { agentId: role, conversation: scope },
            { fresh: true },
          ).line,
          new RegExp(id),
        );
        assert.match(
          cognitionContext(
            f.runtime,
            { agentId: role, conversation: scope },
            { fresh: false },
          ).refresh().line,
          new RegExp(id),
        );
        assert.equal(memory.state(scope).cognitionsShown[id], 1);

        const shielded = op === "UPDATE" ? next.id : source.id;
        const beforeProtection = cognitionContext(
          f.runtime,
          { agentId: role, conversation: scope },
          { fresh: false },
        );
        const previousPayload = db
          .prepare("SELECT payload FROM events WHERE id=?")
          .get(shielded).payload;
        const updatePayload = db.prepare(
          "UPDATE events SET payload=? WHERE id=?",
        );
        updatePayload.run(
          JSON.stringify({ protectedOperations: true }),
          shielded,
        );
        assert.doesNotMatch(beforeProtection.refresh().line, new RegExp(id));
        assert.equal(memory.state(scope).cognitionsShown[id], 1);
        updatePayload.run(previousPayload, shielded);

        const status =
          op === "WEAKEN" || op === "UPDATE" ? "disputed" : "archived";
        const sameSession = memory.state(scope).session;
        await wake();
        assert.match(
          prompts[1].prompt,
          new RegExp(`"id":"${id}","version":2[^}]*"status":"${status}"`),
        );
        assert.doesNotMatch(prompts[1].prompt, /喜欢听钢琴|相互矛盾的材料/);
        assert.equal(prompts[1].session.id, sameSession.id);
        if (surface === "qq")
          assert.equal(prompts[1].instructions, prompts[0].instructions);
        assert.equal(memory.state(scope).cognitionsShown[id], 2);
        await wake();
        assert.doesNotMatch(prompts[2].prompt, new RegExp(id));
      });
    }
});
