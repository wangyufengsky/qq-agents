import fs from "node:fs";
import path from "node:path";

// Three real turns, synthetic task facts, only the local fixture QQ gateway.
export async function backendContractAcceptance({
  runtime,
  memory,
  id,
  turn,
  gateway,
  root,
}) {
  const m = memory.bind(id),
    target = "private:30000",
    startedAt = Date.now(),
    before = gateway.sent.length;
  const originalTools = runtime.toolsFor.bind(runtime);
  runtime.toolsFor = (...args) =>
    originalTools(...args).filter((name) => name !== "work_note");
  const report = {
    agentId: id,
    startedAt,
    scope: "real backend; synthetic task; loopback QQ; no work_note",
  };
  const requireResult = (ok, code) => {
    if (!ok) throw Error(code);
  };
  try {
    // The general acceptance profile starts with every tool in its allowlist.
    // Establish the actual disabled catalogue before testing enablement.
    await runtime.changeAppPermissions(
      id,
      { enabled: false },
      runtime.configStore.revision,
    );
    await turn(
      id,
      "这次去杭州，三人同行，每晚住宿预算600元，酒店尚未决定。先记住这些条件，不需要发QQ；用qq_mark_read标记已处理，下一条继续。",
    );
    report.firstSession = m.state(target).session;
    requireResult(report.firstSession, "FIRST_SESSION_REQUIRED");
    requireResult(
      m.state(target).readThroughSeq >= m.state(target).lastReceivedSeq,
      "FIRST_TASK_NOT_PROCESSED",
    );
    await runtime.changeAppPermissions(
      id,
      { enabled: true, sharing: true, platforms: ["bilibili"] },
      runtime.configStore.revision,
    );
    await turn(
      id,
      "继续刚才的方案。用一条QQ消息复述已经确定的地点、人数和每晚预算，并指出一个未决定事项。不要再问我已有条件，不使用平台浏览。",
    );
    report.secondSession = m.state(target).session;
    requireResult(
      report.secondSession?.id &&
        report.secondSession.id !== report.firstSession.id,
      "CONTRACT_DID_NOT_REBUILD",
    );
    await turn(
      id,
      "保持刚才的条件，用一条简短QQ消息再次复述这些已定条件，并提一个下一步需要做的选择。不使用平台浏览。",
    );
    report.thirdSession = m.state(target).session;
    requireResult(
      report.thirdSession?.id === report.secondSession.id,
      "UNCHANGED_CONTRACT_DID_NOT_REUSE",
    );
    report.replies = gateway.sent.slice(before).map((s) =>
      (s.message || [])
        .filter((x) => x.type === "text")
        .map((x) => x.data.text)
        .join(""),
    );
    report.turns = m.identity
      .list("model_turns")
      .filter((t) => t.startedAt >= startedAt)
      .sort((a, b) => a.startedAt - b.startedAt);
    report.retired = m.identity
      .list("session_history")
      .filter((s) => s.at >= startedAt)
      .map((s) => ({ reason: s.reason, id: s.session.id }));
    requireResult(
      report.replies.length === 2 &&
        report.replies.every(
          (s) => /杭州/.test(s) && /三|3/.test(s) && /600|六百/.test(s),
        ),
      "TASK_CONTINUITY_FAILED",
    );
    requireResult(
      JSON.stringify(report.turns.map((t) => t.initialSession)) ===
        "[true,true,false]",
      "INITIAL_FLAGS_WRONG",
    );
    requireResult(
      report.retired.some((s) => s.reason === "backend-contract-change"),
      "ARCHIVE_REQUIRED",
    );
    requireResult(
      m.identity.notes(target).length === 0,
      "NOTE_FREE_SAMPLE_REQUIRED",
    );
    report.status = "passed";
  } catch (error) {
    report.status = "failed";
    report.error = error.message;
    throw error;
  } finally {
    runtime.toolsFor = originalTools;
    report.completedAt = Date.now();
    fs.writeFileSync(
      path.join(root, id + "-backend-contract.json"),
      JSON.stringify(report, null, 2),
      { mode: 0o600 },
    );
  }
}
