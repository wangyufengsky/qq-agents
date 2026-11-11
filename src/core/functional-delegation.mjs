import { randomUUID } from "node:crypto";
import { resolveFunctionalContract } from "./functional-contracts.mjs";
import {
  functionalConfigVersion,
  memoryRecallPolicy,
  resolveFunctionalAgent,
} from "./functional-agents.mjs";

export class FunctionalDelegation {
  #active = new Map();

  constructor(runtime) {
    this.runtime = runtime;
  }

  invalidate() {
    for (const invocation of this.#active.values()) invocation.stop("stale");
  }

  submit(ctx, data) {
    const invocation = this.#active.get(ctx);
    if (!invocation) throw Error("FUNCTIONAL_AGENT_STALE");
    invocation.assertCurrent();
    if (invocation.result)
      throw Error("FUNCTIONAL_AGENT_RESULT_ALREADY_SUBMITTED");
    invocation.result = invocation.contract.captureResult(data);
    const result = { status: "accepted" };
    if (invocation.acknowledged)
      this.runtime.stageToolOutput(ctx, result, [
        {
          value: result,
          expected: result,
          commit: () => invocation.acknowledged.resolve(true),
        },
      ]);
    return result;
  }

  async run(
    parent,
    targetKey,
    {
      prompt,
      timeoutMs,
      opening,
      evidenceBeforeSeq,
      shownEvidenceIds = [],
      beforeInput,
      resultOnReceipt,
    } = {},
  ) {
    const runtime = this.runtime;
    const parentSignal = parent.controller.signal;
    if (parentSignal.aborted) return { status: "cancelled" };
    let role;
    try {
      role = runtime.assertActive(parent);
    } catch {
      return { status: "denied" };
    }
    const source = resolveFunctionalAgent(role, parent.conversation);
    const recall = memoryRecallPolicy(
      role,
      parent.conversation,
      runtime.config,
    );
    const profile = resolveFunctionalAgent(
      role,
      parent.conversation,
      targetKey,
      runtime.config,
    );
    if (
      parent.runtimeKind === "functional-agent" ||
      source?.kind !== "qq-dialogue" ||
      profile?.kind !== "memory" ||
      role.memoryRecall === "disabled" ||
      (!recall && !source.definition.delegatesTo?.includes(targetKey)) ||
      typeof prompt !== "string" ||
      !prompt.trim() ||
      runtime.containsCapability(parent, prompt) ||
      (timeoutMs !== undefined &&
        (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0))
    )
      return { status: "denied" };

    const contract = resolveFunctionalContract(profile);
    if (opening && !recall?.opening) return { status: "denied" };
    const { timeoutMs: configuredTimeout, maxLookups } = opening
      ? { timeoutMs: recall.openingTimeoutMs, maxLookups: 1 }
      : profile.definition.onDemand;
    const deadline = Math.min(
      parent.expires,
      Date.now() + Math.min(timeoutMs ?? configuredTimeout, configuredTimeout),
    );
    if (deadline <= Date.now()) return { status: "timeout" };

    let lease;
    try {
      lease = runtime.backendConnections.acquireFunctionalBackend(
        role,
        profile.definition,
      );
    } catch (error) {
      return {
        status:
          error?.message === "FUNCTIONAL_AGENT_BUSY" ? "busy" : "unavailable",
      };
    }
    const invocationId = randomUUID();
    const configVersion = functionalConfigVersion(runtime.config);
    const inputEpoch = parent.inputEpoch;
    const controller = new AbortController();
    const stopped = Promise.withResolvers();
    let stopStatus;
    const stop = (status) => {
      if (stopStatus) return;
      stopStatus = status;
      stopped.resolve(false);
      controller.abort();
    };
    const isCurrent = () => {
      if (controller.signal.aborted) return false;
      if (parentSignal.aborted) stop("cancelled");
      else if (Date.now() >= deadline) stop("timeout");
      else if (
        functionalConfigVersion(runtime.config) !== configVersion ||
        parent.inputEpoch !== inputEpoch
      )
        stop("stale");
      if (!stopStatus) {
        try {
          runtime.assertActive(parent);
        } catch {
          stop("stale");
        }
      }
      return !stopStatus;
    };
    const assertCurrent = () => {
      if (!isCurrent()) throw Error("FUNCTIONAL_AGENT_STALE");
    };
    const cancel = () => stop("cancelled");
    parentSignal.addEventListener("abort", cancel, { once: true });
    controller.signal.addEventListener("abort", cancel, { once: true });
    const timer = setTimeout(
      () => stop("timeout"),
      Math.max(0, deadline - Date.now()),
    );

    let child;
    const invocation = {
      stop,
      assertCurrent,
      contract,
      result: undefined,
      acknowledged: resultOnReceipt ? Promise.withResolvers() : null,
    };
    const execute = async () => {
      try {
        assertCurrent();
        child = runtime.makeFunctionalContext(parent, {
          invocationId,
          profile,
          deadline,
          controller,
          assertCurrent,
          maxLookups,
          evidenceBeforeSeq,
        });
        this.#active.set(child, invocation);
        await lease.backend.run({
          ...contract.createExchange(runtime, child, {
            profile,
            prompt,
            isCurrent,
            shownEvidenceIds,
            resultOnReceipt,
          }),
          signal: controller.signal,
          modelSelection: lease.modelSelection,
          beforeInputSubmitted: async () => {
            if (beforeInput && !beforeInput()) stop("stale");
            assertCurrent();
          },
        });
      } finally {
        // A timed-out caller leaves immediately. The backend owns its lease
        // until the native turn and its cleanup settle.
        await lease.release();
      }
    };

    try {
      const settled = runtime.trackWork(execute()).then(
        () => true,
        () => false,
      );
      const completed = await Promise.race([
        stopped.promise,
        settled,
        ...(invocation.acknowledged ? [invocation.acknowledged.promise] : []),
      ]);
      assertCurrent();
      if (!completed) return { status: "unavailable", invocationId };
      if (!invocation.result) return { status: "no-result", invocationId };
      return {
        status: "completed",
        invocationId,
        ...contract.verifyResult(runtime, child, invocation.result),
      };
    } catch {
      return { status: stopStatus || "unavailable", invocationId };
    } finally {
      clearTimeout(timer);
      parentSignal.removeEventListener("abort", cancel);
      controller.signal.removeEventListener("abort", cancel);
      controller.abort();
      if (child) {
        this.#active.delete(child);
        runtime.closeFunctionalContext(child);
      }
    }
  }
}
