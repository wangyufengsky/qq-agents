// Keep only protocol-defined classifications, never provider messages/HTML or
// tool arguments: errors can contain credentials and private conversation text.
export class BackendTurnFailure extends Error {
  constructor(backend, code, category, turnId, recoverable = false) {
    super(`${backend.toUpperCase()}_TURN_FAILED`);
    Object.assign(this, {
      backend,
      code,
      category,
      turnId,
      recoverable,
      sessionReusable: false,
    });
  }
}

export function dshTurnFailure(reason, turnId) {
  const code = reason?.error?.code;
  if (reason?.kind === "error" && code === "MALFORMED_RESPONSE")
    return new BackendTurnFailure(
      "dsh",
      code,
      "malformed-response",
      String(turnId),
      true,
    );
  const category = reason?.kind === "cancelled" ? "cancelled" : "unknown";
  return new BackendTurnFailure("dsh", "TURN_FAILED", category, String(turnId));
}

export function codexTurnFailure(turn) {
  const info = turn.error?.codexErrorInfo;
  const categories = {
    unauthorized: "authentication",
    usageLimitExceeded: "quota",
    sessionBudgetExceeded: "quota",
    rateLimitExceeded: "rate-limit",
    contextWindowExceeded: "context-limit",
    badRequest: "invalid-request",
    sandboxError: "permission",
    cyberPolicy: "policy",
    misalignmentPolicyViolation: "policy",
    tooManyDenials: "permission",
  };
  if (turn.status === "failed") {
    for (const code of [
      "responseStreamDisconnected",
      "responseStreamConnectionFailed",
    ]) {
      if (!info || typeof info !== "object" || !Object.hasOwn(info, code))
        continue;
      const status = info[code]?.httpStatusCode;
      const transient = status == null || (status >= 500 && status <= 599);
      return new BackendTurnFailure(
        "codex",
        code,
        transient ? "response-stream" : "upstream-rejected",
        turn.id,
        transient,
      );
    }
    if (typeof info === "string" && Object.hasOwn(categories, info))
      return new BackendTurnFailure("codex", info, categories[info], turn.id);
  }
  return new BackendTurnFailure(
    "codex",
    "TURN_FAILED",
    turn.status === "interrupted" ? "cancelled" : "unknown",
    turn.id,
  );
}

export function failureSummary(error) {
  return error instanceof BackendTurnFailure
    ? {
        backend: error.backend,
        code: error.code,
        category: error.category,
        sessionReusable: error.sessionReusable === true,
      }
    : undefined;
}

// Retry a continuation, never the original prompt or a tools/call. The same
// runtime capability, disclosure state, limits and receipt ledger stay in use.
export async function runWithRecovery(
  backend,
  params,
  { onFailure, onRecovery } = {},
) {
  let session = params.session;
  let recovery;
  for (let attempt = 0; ; attempt++) {
    try {
      return await backend.run({
        ...params,
        session,
        recovery,
        ...(recovery
          ? {
              prompt:
                "上一轮因可恢复的生成错误结束。继续尚未完成的部分，不要重做已经成功的工具操作；已发送或投递结果未知的 QQ 消息不得重发，不得换 requestId 或改写文案重发。依据保留的工具结果继续；若已完成则结束本轮。" +
                (recovery.deliveryBlocked
                  ? " 本轮之前已有投递尝试，发送已锁定；只允许查询原回执，不再新增任何 QQ 投递。"
                  : ""),
            }
          : {}),
        saveSession: (value) => {
          session = value;
          params.saveSession(value);
        },
      });
    } catch (error) {
      onFailure?.(error, attempt);
      if (
        params.signal.aborted ||
        !(error instanceof BackendTurnFailure) ||
        !error.sessionReusable ||
        !session ||
        attempt >= 1
      )
        throw error;
      recovery = error;
      onRecovery?.(error, attempt + 1);
    }
  }
}
