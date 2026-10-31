// @ts-check
export class SessionPreparationFailure extends Error {
  /** @param {Error} error */
  constructor(error) {
    super(error.message, { cause: error });
  }
}

// A connection probe has not submitted a prompt or changed a transcript.
// Preserve that evidence separately from retryability: no generation is replayed.
/** @template T @param {import("./session-contract.mjs").StoredSession | null | undefined} session @param {() => Promise<T>} prepare @returns {Promise<T>} */
export async function beforeSessionInput(session, prepare) {
  try {
    return await prepare();
  } catch (error) {
    if (
      session &&
      error instanceof Error &&
      !(error instanceof SessionUnavailableFailure)
    )
      throw new SessionPreparationFailure(error);
    throw error;
  }
}
// A native rejection is different from losing the transport before input.
export class SessionUnavailableFailure extends Error {}
/** @param {unknown} error */
export function sessionWasUnchanged(error) {
  return error instanceof SessionPreparationFailure;
}

// Keep only protocol-defined classifications, never provider messages/HTML or
// tool arguments: errors can contain credentials and private conversation text.
export class BackendTurnFailure extends Error {
  /** @param {string} backend @param {string} code @param {string} category @param {string} turnId */
  constructor(backend, code, category, turnId, recoverable = false) {
    super(`${backend.toUpperCase()}_TURN_FAILED`);
    this.backend = backend;
    this.code = code;
    this.category = category;
    this.turnId = turnId;
    this.recoverable = recoverable;
    this.sessionReusable = false;
  }
}
/** The turn runner marks a failure whose turn already attempted QQ delivery.
 * @typedef {BackendTurnFailure & {deliveryBlocked?: boolean}} RecoveryFailure */

/** @param {any} reason @param {unknown} turnId */
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

/** @param {any} turn */
export function codexTurnFailure(turn) {
  const info = turn.error?.codexErrorInfo;
  /** @type {Record<string, string>} */
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

// Only network loss, 5xx and malformed bodies are transient. A 429 is not
// retried here: an immediate continuation would only meet the same limit.
/** @param {any} error @param {string} turnId */
export function openaiTurnFailure(error, turnId) {
  /** @param {string} code @param {string} category */
  const fail = (code, category, recoverable = false) =>
    new BackendTurnFailure("openai", code, category, turnId, recoverable);
  if (error?.message === "OPENAI_UNREACHABLE")
    return fail("unreachable", "response-stream", true);
  if (error?.message === "OPENAI_MALFORMED_RESPONSE")
    return fail("malformedResponse", "malformed-response", true);
  if (error?.message === "OPENAI_API_KEY_ENV_MISSING")
    return fail("apiKeyEnvMissing", "authentication");
  if (error?.message !== "OPENAI_HTTP_ERROR")
    return fail("TURN_FAILED", "unknown");
  const { status, code } = error;
  if (status >= 500 && status <= 599)
    return fail("serverError", "response-stream", true);
  if (status === 401 || status === 403)
    return fail("unauthorized", "authentication");
  if (status === 429)
    return code === "insufficient_quota"
      ? fail("insufficientQuota", "quota")
      : fail("rateLimited", "rate-limit");
  if (code === "context_length_exceeded" || status === 413)
    return fail("contextLengthExceeded", "context-limit");
  if (status === 400 || status === 404 || status === 422)
    return fail("badRequest", "invalid-request");
  return fail("TURN_FAILED", "unknown");
}

/** @param {unknown} error */
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
/**
 * @param {{run(params: import("./session-contract.mjs").RunParams): Promise<unknown>}} backend
 * @param {import("./session-contract.mjs").RunParams} params
 * @param {{onFailure?: (error: unknown, attempt: number) => void,
 *   onRecovery?: (error: BackendTurnFailure, attempt: number) => void}} [hooks]
 */
export async function runWithRecovery(
  backend,
  params,
  { onFailure, onRecovery } = {},
) {
  let session = params.session;
  /** @type {RecoveryFailure | undefined} */
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
        !error.recoverable ||
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
