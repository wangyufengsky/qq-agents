import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import path from "node:path";
import test from "node:test";
import { setImmediate as yieldLoop } from "node:timers/promises";
import { ConfigStore } from "../src/core/config.mjs";
import {
  MessageTiming,
  messageTimingSnapshotSchema,
} from "../src/core/message-timing.mjs";
import { analyzeMessageTiming } from "../src/core/message-timing-analysis.mjs";
import { Runtime } from "../src/core/runtime.mjs";
import { MemoryStore } from "../src/memory/store.mjs";
import { createServer } from "../src/server.mjs";
import { safeToolFailure } from "../src/tools/errors.mjs";
import { config, FakeTransport, raw, settle, temp } from "./helpers.mjs";

const epoch = Date.UTC(2030, 0, 1);
const target = "group:20000";
const fixtureSend = (requestId) => ({ requestId, text: "合成回复" });

function setup(t, { run, capture = true, configure = () => {} } = {}) {
  let now = 0;
  const cfg = config(1);
  configure(cfg.agents[0]);
  const root = temp(t);
  const memory = new MemoryStore(":memory:");
  const transport = new FakeTransport();
  const timing = capture ? new MessageTiming({ clock: () => now }) : undefined;
  const runtime = new Runtime({
    configStore: new ConfigStore(path.join(root, "config.json"), cfg),
    memory,
    clock: () => new Date(epoch + now),
    messageTiming: timing,
    backendFactory: () => ({
      run,
      cancel: async () => {},
      close: async () => {},
    }),
    transportFactory: () => transport,
  });
  runtime.transports.set("qq-0", transport);
  t.after(async () => {
    await runtime.close();
    memory.close();
  });
  return {
    runtime,
    transport,
    timing,
    at: (ms) => {
      now = ms;
    },
  };
}

test("real intake, scheduler, model and connection queue share one measured response", async (t) => {
  const proceed = Promise.withResolvers();
  const waiting = Promise.withResolvers();
  const releaseBlocker = Promise.withResolvers();
  const inFlight = Promise.withResolvers();
  const releaseResponse = Promise.withResolvers();
  const f = setup(t, {
    configure(a) {
      a.behavior.batchWindowMs = 4000;
      a.behavior.batchMaxMs = 12000;
    },
    run: async (p) => {
      p.onInputSubmitted();
      await proceed.promise;
      await p.callTool("qq_send", fixtureSend("timing-reply-fixture"));
    },
  });
  f.transport.send = async (scope) => {
    if (scope !== target) {
      waiting.resolve();
      return releaseBlocker.promise;
    }
    inFlight.resolve();
    return releaseResponse.promise;
  };

  try {
    await f.runtime.ingest("qq-0", raw(1));
    f.at(3000);
    await f.runtime.ingest("qq-0", raw(2));
    f.at(3500);
    await f.runtime.ingest("qq-0", raw(2));
    f.at(6999);
    f.runtime.tick();
    assert.equal(f.runtime.running.size, 0);

    f.at(7000);
    f.runtime.tick();
    f.at(7050);
    const blocker = f.runtime.withContext("agent-0", "group:20001", (ctx) =>
      f.runtime.send(ctx, fixtureSend("timing-queue-fixture")),
    );
    await waiting.promise;
    f.at(7100);
    proceed.resolve();
    await yieldLoop();
    f.at(8000);
    releaseBlocker.resolve({ messageId: "50000" });
    await blocker;
    await inFlight.promise;

    const active = f.timing.snapshot();
    assert.equal(active.counts.inProgress, 1);
    assert.deepEqual(active.samples, []);
    f.at(8500);
    releaseResponse.resolve({ messageId: "50001" });
    await settle(f.runtime);
    const snapshot = f.timing.snapshot();
    assert(messageTimingSnapshotSchema.safeParse(snapshot).success);
    assert.equal(snapshot.samples.length, 1);
    assert.deepEqual(snapshot.samples[0].marks, {
      firstInbound: 0,
      lastInbound: 3000,
      batchStarted: 0,
      batchReady: 7000,
      dispatched: 7000,
      processingStarted: 7000,
      backendInputSubmitted: 7000,
      sendRequested: 7100,
      draftStored: 7100,
      turnFinished: 8500,
      finished: 8500,
    });
    assert.deepEqual(snapshot.samples[0].deliveries, [
      {
        marks: {
          requested: 7100,
          conversationReady: 7100,
          queueEntered: 7100,
          queueLeft: 8000,
          reserved: 8000,
          submitted: 8000,
          gatewayConfirmed: 8500,
          ledgerConfirmed: 8500,
        },
        outcome: "confirmed",
      },
    ]);
    const output = JSON.stringify(snapshot);
    assert.doesNotMatch(
      output,
      /timing-reply-fixture|agent-0|group:20000|qq-0|合成回复/,
    );
    const state = f.runtime.memory.bind("agent-0").state(target);
    assert.doesNotMatch(
      JSON.stringify(state),
      /messageTiming|batchStarted|ledgerConfirmed/,
    );
  } finally {
    proceed.resolve();
    releaseBlocker.resolve({ messageId: "50000" });
    releaseResponse.resolve({ messageId: "50001" });
  }
});

test("busy, observed cooldown and wake rate limit retain distinct overlaps", async (t) => {
  const release = Promise.withResolvers();
  let calls = 0;
  const f = setup(t, {
    configure(a) {
      a.wake.cooldownMs = 10000;
      a.behavior.maxWakePerMinute = 1;
    },
    run: async (p) => {
      p.onInputSubmitted();
      if (++calls === 1) await release.promise;
      else await p.callTool("qq_send", fixtureSend("timing-delayed-fixture"));
    },
  });
  try {
    await f.runtime.ingest("qq-0", raw(1));
    assert.equal(calls, 1);
    f.at(1000);
    f.runtime.agent("agent-0").behavior.batchWindowMs = 2000;
    await f.runtime.ingest("qq-0", raw(2));
    f.at(5000);
    release.resolve();
    await settle(f.runtime);
    assert.equal(calls, 1);
    f.at(60000);
    f.runtime.tick();
    await settle(f.runtime);
    assert.equal(calls, 2);

    const snapshot = f.timing.snapshot();
    const delayed = snapshot.samples[1];
    assert.deepEqual(
      delayed.intervals.toSorted((a, b) => a.end - b.end),
      [
        { kind: "busy", start: 0, end: 4000 },
        { kind: "cooldown", start: 4000, end: 9000 },
        { kind: "wakeRateLimit", start: 4000, end: 59000 },
      ],
    );
    assert.equal(delayed.marks.batchReady, 2000);
    assert.equal(delayed.marks.dispatched, 59000);
    const { attribution } = analyzeMessageTiming(snapshot).overall;
    assert.equal(attribution.overlap.p50Ms, 7000);
    assert.equal(attribution.duration.p50Ms, 59000);
    assert.equal(attribution.observedByKind.cooldown.p50Ms, 5000);
    assert.equal(attribution.observedByKind.wakeRateLimit.p50Ms, 55000);
  } finally {
    release.resolve();
  }
});

test("a recovered pending batch has no invented first inbound or aggregation start", async (t) => {
  const f = setup(t, {
    configure(a) {
      a.behavior.batchWindowMs = 4000;
      a.behavior.batchMaxMs = 12000;
    },
    run: async (p) => {
      p.onInputSubmitted();
      await p.callTool("qq_send", fixtureSend("timing-recovered-fixture"));
    },
  });
  const m = f.runtime.memory.bind("agent-0");
  m.setState(target, {
    pendingWakes: [{ reason: "message", seq: 0, at: epoch - 1000 }],
    wakeBatchAt: epoch - 1000,
    wakeBatchSenders: ["30000"],
    wakeDueAt: epoch + 3000,
  });
  f.at(1000);
  await f.runtime.ingest("qq-0", raw(1));
  f.at(5000);
  f.runtime.tick();
  await settle(f.runtime);
  const [sample] = f.timing.snapshot().samples;
  assert.equal(sample.marks.firstInbound, undefined);
  assert.equal(sample.marks.batchStarted, undefined);
  assert.equal(sample.marks.lastInbound, 0);
  assert.equal(sample.marks.batchReady, 4000);
  assert.equal(sample.outcome, "confirmed");
});

test("a turn completing before its issued send still records the later authoritative receipt", async (t) => {
  const reply = Promise.withResolvers();
  const f = setup(t, {
    run: async (p) => {
      p.onInputSubmitted();
      void p
        .callTool("qq_send", fixtureSend("timing-detached-fixture"))
        .catch(() => {});
    },
  });
  f.transport.send = () => reply.promise;
  try {
    await f.runtime.ingest("qq-0", raw(1));
    await settle(f.runtime);
    assert.equal(f.timing.snapshot().counts.inProgress, 1);
    const inFlight = [...f.runtime.work];
    f.at(30);
    reply.resolve({ messageId: "50000" });
    await Promise.allSettled(inFlight);
    const [sample] = f.timing.snapshot().samples;
    assert.equal(sample.outcome, "confirmed");
    assert.equal(sample.marks.turnFinished, 0);
    assert.equal(sample.marks.finished, 30);
    assert.equal(sample.deliveries[0].marks.ledgerConfirmed, 30);
  } finally {
    reply.resolve({ messageId: "50000" });
  }
});

for (const revise of ["never", "before", "after"])
  test(
    "only draft continue marks the first send request, revised=" + revise,
    async (t) => {
      let draft, discardable, other;
      const f = setup(t, {
        run: async (p) => {
          p.onInputSubmitted();
          f.at(5);
          assert.equal(
            (await p.callTool("qq_draft", { action: "list" })).items.length,
            other ? 3 : 2,
          );
          f.at(8);
          await p.callTool("qq_draft", { action: "read", draftId: draft.id });
          f.at(12);
          const expectedVersion =
            revise === "before"
              ? (
                  await p.callTool("qq_draft", {
                    action: "revise",
                    draftId: draft.id,
                    expectedVersion: draft.revision,
                    position: 0,
                    input: { text: "修改后的合成回复" },
                  })
                ).version
              : draft.revision;
          f.at(15);
          await p.callTool("qq_draft", {
            action: "discard",
            draftId: discardable.id,
            expectedVersion: discardable.revision,
          });
          const continuation = {
            action: "continue",
            draftId: draft.id,
            expectedVersion,
          };
          let challenge;
          f.at(20);
          await assert.rejects(
            p.callTool("qq_draft", continuation),
            (error) => {
              challenge = safeToolFailure(error).inputReview;
              return error.message === "INPUT_REVIEW_REQUIRED";
            },
          );
          f.at(30);
          const sent = await p.callTool("qq_draft", {
            ...continuation,
            inputReview: { token: challenge.token, decision: "continue" },
          });
          assert.equal(sent.status, "sent");
          if (other) {
            f.at(50);
            await p.callTool("qq_draft", {
              action: "revise",
              draftId: other.id,
              expectedVersion: other.revision,
              position: 0,
              input: { text: "另外一份合成草稿" },
            });
          }
        },
      });
      const scope = {
        agentId: "agent-0",
        connectionId: "qq-0",
        accountId: "10000",
        conversation: target,
      };
      const stage = (requestId) =>
        f.runtime.drafts.stage(scope, {
          toolName: "qq_send",
          requestId,
          items: [{ requestId, input: { text: "暂存的合成回复" } }],
          value: { baseline: { readSeq: 0, sentSeq: 0 } },
        }).draft;
      draft = stage("timing-continue-fixture");
      discardable = stage("timing-discard-fixture");
      if (revise === "after") other = stage("timing-later-fixture");
      await f.runtime.ingest("qq-0", raw(1));
      await settle(f.runtime);
      const snapshot = f.timing.snapshot();
      const [sample] = snapshot.samples;
      assert.equal(sample.marks.sendRequested, 20);
      assert.equal(
        sample.marks.draftStored,
        revise === "before" ? 12 : other ? 50 : undefined,
      );
      assert.equal(
        Object.hasOwn(
          analyzeMessageTiming(snapshot).overall.traceTimings,
          "sendRequestToDraftStored",
        ),
        false,
      );
      assert.equal(sample.deliveries[0].outcome, "review-required");
      assert.equal(sample.deliveries[1].marks.ledgerConfirmed, 30);
    },
  );

test("a partially confirmed burst retains its structured stop reason", async (t) => {
  let calls = 0,
    result;
  const f = setup(t, {
    configure(a) {
      a.tools.push("qq_send_burst");
    },
    run: async (p) => {
      if (++calls > 1) return;
      p.onInputSubmitted();
      result = await p.callTool("qq_send_burst", {
        requestId: "timing-burst-fixture",
        messages: ["第一条合成回复", "第二条合成回复"],
        gapMs: 0,
      });
    },
  });
  const send = f.transport.send.bind(f.transport);
  f.transport.send = async (...args) => {
    const receipt = await send(...args);
    f.at(10);
    await f.runtime.ingest("qq-0", raw(2));
    return receipt;
  };
  await f.runtime.ingest("qq-0", raw(1));
  await settle(f.runtime);
  assert.equal(result.status, "stopped");
  assert.equal(result.error, "INPUT_REVIEW_REQUIRED");
  assert.equal(f.transport.sent.length, 1);
  const snapshot = f.timing.snapshot();
  const sample = snapshot.samples.find(({ stoppedBy }) => stoppedBy);
  assert.equal(sample.outcome, "confirmed");
  assert.equal(sample.stoppedBy, "review-required");
  assert.equal(sample.deliveries[0].marks.ledgerConfirmed, 10);
  assert.equal(sample.deliveries[1].marks.submitted, undefined);
  assert.deepEqual(analyzeMessageTiming(snapshot).overall.stoppedBy, {
    "review-required": 1,
  });
});

test("a cancelled burst gap preserves the prior confirmation and records cancellation", async (t) => {
  let result;
  const reachedGateway = Promise.withResolvers();
  const f = setup(t, {
    configure(a) {
      a.tools.push("qq_send_burst");
    },
    run: async (p) => {
      p.onInputSubmitted();
      result = await p.callTool("qq_send_burst", {
        requestId: "timing-cancelled-burst-fixture",
        messages: ["第一条合成回复", "第二条合成回复"],
        gapMs: 30000,
      });
    },
  });
  const send = f.transport.send.bind(f.transport);
  f.transport.send = async (...args) => {
    const receipt = await send(...args);
    reachedGateway.resolve();
    return receipt;
  };
  await f.runtime.ingest("qq-0", raw(1));
  await reachedGateway.promise;
  await yieldLoop();
  f.at(20);
  await f.runtime.cancel("agent-0");
  await settle(f.runtime);
  assert.equal(result.status, "stopped");
  assert.equal(result.error, "TOOL_FAILED");
  assert.equal(f.transport.sent.length, 1);
  const [sample] = f.timing.snapshot().samples;
  assert.equal(sample.outcome, "confirmed");
  assert.equal(sample.stoppedBy, "cancelled");
  assert.deepEqual(sample.intervals, [
    { kind: "simulation", start: 0, end: 20 },
  ]);
});

test("replaying a historical unresolved burst records a lock without another send", async (t) => {
  const results = [];
  const f = setup(t, {
    configure(a) {
      a.tools.push("qq_send_burst");
    },
    run: async (p) => {
      p.onInputSubmitted();
      results.push(
        await p.callTool("qq_send_burst", {
          requestId: "timing-old-burst-fixture",
          messages: ["第一条合成回复", "第二条合成回复"],
          gapMs: 0,
        }),
      );
    },
  });
  f.transport.failure = "ONEBOT_UNREACHABLE";
  await f.runtime.ingest("qq-0", raw(1));
  await settle(f.runtime);
  await f.runtime.ingest("qq-0", raw(2));
  await settle(f.runtime);
  assert.equal(f.transport.sent.length, 1);
  assert.equal(results[0].error, "DELIVERY_UNKNOWN");
  assert.equal(results[1].error, "QQ_DRAFT_CONTINUE_REQUIRED");
  assert.equal(results[1].draft.items[0].status, "unknown");
  const [initial, replay] = f.timing.snapshot().samples;
  assert.equal(initial.outcome, "unknown");
  assert.equal(replay.outcome, "unresolved-delivery");
  assert.equal(replay.stoppedBy, "unresolved-delivery");
  assert.equal(replay.marks.draftStored, undefined);
  assert.deepEqual(replay.deliveries, []);
});

test("an unconfirmed OneBot submission stays unknown in timing analysis", async (t) => {
  let calls = 0;
  const f = setup(t, {
    run: async (p) => {
      p.onInputSubmitted();
      if (++calls === 1) {
        await assert.rejects(
          p.callTool("qq_send", fixtureSend("timing-unknown-fixture")),
          /DELIVERY_UNKNOWN/,
        );
      } else {
        await assert.rejects(
          p.callTool("qq_send", fixtureSend("timing-new-fixture")),
          /QQ_DRAFT_DELIVERY_UNRESOLVED/,
        );
      }
    },
  });
  f.transport.failure = "ONEBOT_UNREACHABLE";
  await f.runtime.ingest("qq-0", raw(1));
  await settle(f.runtime);
  await f.runtime.ingest("qq-0", raw(2));
  await settle(f.runtime);
  const snapshot = f.timing.snapshot();
  const [sample, blocked] = snapshot.samples;
  assert.equal(blocked.outcome, "unresolved-delivery");
  assert.deepEqual(blocked.deliveries, []);
  assert.equal(sample.outcome, "unknown");
  assert.equal(sample.deliveries[0].outcome, "unknown");
  assert.equal(sample.deliveries[0].marks.ledgerConfirmed, undefined);
  assert.equal(
    analyzeMessageTiming(snapshot).overall.firstConfirmationSamples,
    0,
  );
  const memory = f.runtime.memory.bind("agent-0");
  const [unconfirmed] = memory.unresolvedDeliveries().items;
  assert.match(unconfirmed.requestId, /^draft:/);
  memory.reconcileDelivery(unconfirmed.requestId, "sent", {
    messageId: "50000",
  });
  assert.equal(memory.delivery(unconfirmed.requestId).status, "sent");
  assert.deepEqual(f.timing.snapshot(), snapshot);
});

for (const capture of [false, true])
  test(
    "timing export uses the existing admin boundary, enabled=" + capture,
    async (t) => {
      const f = setup(t, { capture });
      const token = randomBytes(32).toString("hex");
      const server = createServer({ runtime: f.runtime, token });
      const port = await server.listen();
      t.after(() => server.close());
      const url = `http://127.0.0.1:${port}/api/diagnostics/message-timing`;
      const headers = { "x-admin-token": token };
      assert.equal((await fetch(url)).status, 401);
      assert.equal(
        (
          await fetch(url, {
            headers: { ...headers, origin: "https://example.invalid" },
          })
        ).status,
        403,
      );
      const response = await fetch(url, { headers });
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("cache-control"), "no-store");
      const snapshot = messageTimingSnapshotSchema.parse(await response.json());
      assert.equal(snapshot.enabled, capture);
      assert.deepEqual(snapshot.samples, []);
    },
  );
