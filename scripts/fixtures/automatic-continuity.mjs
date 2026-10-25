import fs from "node:fs";
import path from "node:path";

// Real backends and native compaction; synthetic travel task and loopback QQ.
// A test-only reserve triggers the production 75% path with a small real sample.
// Backend occupancy is never fabricated; this does not claim 75% physical usage.
export async function automaticContinuityAcceptance({
  runtime,
  memory,
  id,
  turn,
  gateway,
  calls,
  root,
}) {
  const a = runtime.agent(id),
    m = memory.bind(id),
    target = "private:30000",
    startedAt = Date.now(),
    before = gateway.sent.length,
    callStart = calls.length,
    originalReserve = a.contextPolicy.reserveTokens,
    originalUsage = runtime.contexts.usage.bind(runtime.contexts),
    originalTools = runtime.toolsFor.bind(runtime),
    originalClock = runtime.clock;
  const samples = [],
    compactCalls = [];
  let backend,
    originalCompact,
    trigger = true;
  const requireResult = (ok, code) => {
    if (!ok) throw Error(code);
  };
  // Remove the optional note writer so this sample actually exercises automatic retention.
  runtime.toolsFor = (...args) =>
    originalTools(...args).filter((name) => name !== "work_note");
  runtime.contexts.usage = (ctx, value) => {
    if (
      trigger &&
      ctx.agentId === id &&
      value.source === "measured" &&
      value.capacityTokens > 0
    ) {
      a.contextPolicy.reserveTokens = Math.max(
        originalReserve,
        Math.ceil(value.capacityTokens * 0.8 - value.contextTokens),
      );
      samples.push({
        ...value,
        reserveTokens: a.contextPolicy.reserveTokens,
        ratio:
          (value.contextTokens + a.contextPolicy.reserveTokens) /
          value.capacityTokens,
      });
      backend = runtime.backends.get(id);
      if (!originalCompact) {
        originalCompact = backend.compact.bind(backend);
        backend.compact = async (args) => {
          const compactStarted = Date.now();
          try {
            const result = await originalCompact(args);
            compactCalls.push({
              result,
              elapsedMs: Date.now() - compactStarted,
            });
            return result;
          } catch (e) {
            compactCalls.push({ error: e.message });
            throw e;
          }
        };
      }
    }
    return originalUsage(ctx, value);
  };
  const report = {
    agentId: id,
    startedAt,
    samples,
    compactCalls,
    scope:
      "real model and native compact; real occupancy plus test-only reserve triggers automatic 75% path; optional work_note unavailable; synthetic sources; loopback QQ",
  };
  try {
    await turn(
      id,
      "我们这次去杭州，三人同行，住宿每晚预算600元。路线和酒店都还没有决定。先比较住在交通便利处与景点附近的利弊，暂时不用发QQ，我下一条接着问。",
    );
    trigger = false;
    report.afterPressure = m.state(target);
    requireResult(
      samples.length && compactCalls.length === 1 && !compactCalls[0].error,
      "AUTOMATIC_NATIVE_COMPACTION_REQUIRED",
    );
    if (id.includes("dsh"))
      requireResult(
        compactCalls[0].result.compacted,
        "DSH_NATIVE_COMPACTION_NOOP",
      );
    requireResult(
      m.state(target).readThroughSeq >= m.state(target).lastReceivedSeq,
      "TASK_NOT_MARKED_PROCESSED",
    );
    if (m.state(target).session) {
      // Advance the fixture clock to exercise normal idle retirement without calling retire directly.
      const future = runtime.now() + a.contextPolicy.idleMs + 1;
      runtime.clock = () => new Date(future);
      runtime.contexts.tick();
      runtime.clock = originalClock;
    }
    requireResult(!m.state(target).session, "AUTOMATIC_RETIREMENT_REQUIRED");
    a.contextPolicy.reserveTokens = originalReserve;
    report.handoff = runtime.contexts.handoff(id, target);
    await turn(
      id,
      "继续刚才的旅行安排。先用一条QQ消息复述我们已经确定的目的地、人数、每晚住宿预算，再说一个仍未确定的事项。不要重新问我已有条件。",
    );
    const oldSelf = m.identity.current();
    m.identity.adminEdit(
      {
        body: oldSelf.body + "\n交流时先核对已经明确的条件，再说明未确定事项。",
        reason: "合成验收：Self 变化",
        expectedVersion: oldSelf.version,
      },
      runtime.now(),
    );
    await turn(
      id,
      "继续这个行程，给一条简短QQ回复：目前有哪些确定条件，下一步还需决定什么？",
    );
    report.replies = gateway.sent.slice(before).map((s) =>
      (s.message || [])
        .filter((x) => x.type === "text")
        .map((x) => x.data.text)
        .join(""),
    );
    report.turns = m.identity
      .list("model_turns")
      .filter((t) => t.startedAt >= startedAt);
    report.notes = m.identity.notes(target);
    requireResult(report.notes.length === 0, "NOTE_FREE_SAMPLE_REQUIRED");
    requireResult(
      report.replies.length === 2 &&
        report.replies.every(
          (text) =>
            /杭州/.test(text) && /三|3/.test(text) && /600|六百/.test(text),
        ),
      "TASK_FACT_CONTINUITY_FAILED",
    );
    requireResult(
      report.turns.length === 3 && report.turns.every((t) => t.initialSession),
      "FRESH_SESSION_PATH_REQUIRED",
    );
    report.status = "passed";
    return report;
  } catch (e) {
    report.status = "failed";
    report.error = e.message;
    throw e;
  } finally {
    trigger = false;
    a.contextPolicy.reserveTokens = originalReserve;
    runtime.clock = originalClock;
    runtime.toolsFor = originalTools;
    runtime.contexts.usage = originalUsage;
    if (originalCompact) backend.compact = originalCompact;
    report.toolCalls = calls.slice(callStart);
    report.elapsedMs = Date.now() - startedAt;
    fs.writeFileSync(
      path.join(root, `${id}-automatic-continuity.json`),
      JSON.stringify(report, null, 2),
      { mode: 0o600 },
    );
  }
}
